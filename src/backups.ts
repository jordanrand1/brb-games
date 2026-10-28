import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import type { AppDatabase } from "./database.ts";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const hmac = (key: string | Buffer, value: string) => createHmac("sha256", key).update(value).digest();
const backupKey = (secret: string) => createHash("sha256").update("brb-backup-v1\0" + secret).digest();

export function encryptBackup(data: Buffer, secret: string): Buffer {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", backupKey(secret), iv);
  const encrypted = Buffer.concat([cipher.update(gzipSync(data)), cipher.final()]);
  return Buffer.concat([Buffer.from("BRB1"), iv, cipher.getAuthTag(), encrypted]);
}
export function decryptBackup(data: Buffer, secret: string): Buffer {
  if (data.subarray(0, 4).toString() !== "BRB1") throw new Error("Unsupported backup format.");
  const decipher = createDecipheriv("aes-256-gcm", backupKey(secret), data.subarray(4, 16));
  decipher.setAuthTag(data.subarray(16, 32));
  return gunzipSync(Buffer.concat([decipher.update(data.subarray(32)), decipher.final()]), { maxOutputLength: 128 * 1024 * 1024 });
}

/** Native S3 SigV4 signing avoids adding a cloud SDK to the live server. */
export async function r2Request(options: { accountId: string; bucket: string; accessKey: string; secretKey: string }, method: "PUT" | "DELETE", key: string, body = Buffer.alloc(0), fetcher: typeof fetch = fetch): Promise<void> {
  const url = new URL(`https://${options.accountId}.r2.cloudflarestorage.com/${encodeURIComponent(options.bucket)}/${key.split("/").map(encodeURIComponent).join("/")}`);
  const stamp = new Date().toISOString().replace(/[:-]|\.\d{3}/g, ""), day = stamp.slice(0, 8), payloadHash = hash(body);
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonical = [method, url.pathname, "", `host:${url.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${stamp}\n`, signedHeaders, payloadHash].join("\n");
  const scope = `${day}/auto/s3/aws4_request`;
  const signingKey = hmac(hmac(hmac(hmac("AWS4" + options.secretKey, day), "auto"), "s3"), "aws4_request");
  const signature = hmac(signingKey, `AWS4-HMAC-SHA256\n${stamp}\n${scope}\n${hash(canonical)}`).toString("hex");
  const response = await fetcher(url, { method, body: method === "PUT" ? body : undefined, headers: {
    "x-amz-content-sha256": payloadHash, "x-amz-date": stamp,
    Authorization: `AWS4-HMAC-SHA256 Credential=${options.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  }, signal: AbortSignal.timeout(30_000) });
  await response.body?.cancel();
  if (!response.ok) throw new Error("Remote backup request failed (" + response.status + ").");
}

export class BackupService {
  status: { configured: boolean; lastSuccess: number | null; error: string | null };
  private running = false;
  private timer: ReturnType<typeof setInterval>;
  private startup: ReturnType<typeof setTimeout>;
  private readonly remote: { accountId: string; bucket: string; accessKey: string; secretKey: string };
  private database: AppDatabase;
  private directory: string;
  private secret: string;
  constructor(database: AppDatabase, directory: string, secret: string, env = process.env) {
    this.database = database; this.directory = directory; this.secret = secret;
    for (const filename of readdirSync(directory)) if (/^backup-[a-f0-9]{16}\.sqlite$/.test(filename)) rmSync(join(directory, filename), { force: true });
    this.remote = { accountId: env.R2_ACCOUNT_ID || "", bucket: env.R2_BUCKET || "", accessKey: env.R2_ACCESS_KEY_ID || "", secretKey: env.R2_SECRET_ACCESS_KEY || "" };
    const saved = database.sql.prepare("SELECT value FROM meta WHERE key='backup-status'").get() as any;
    this.status = { configured: Object.values(this.remote).every(Boolean), lastSuccess: saved ? JSON.parse(saved.value).lastSuccess : null, error: saved ? JSON.parse(saved.value).error : null };
    this.timer = setInterval(() => { void this.run(); }, 3600_000);
    this.timer.unref();
    this.startup = setTimeout(() => { void this.run(); }, 5000);
    this.startup.unref();
  }
  async run(force = false): Promise<void> {
    if (this.running || !this.status.configured || !force && this.status.lastSuccess && Date.now() - this.status.lastSuccess < 86400_000) return;
    this.running = true;
    const path = join(this.directory, "backup-" + randomBytes(8).toString("hex") + ".sqlite");
    try {
      if (!/^[a-f0-9]{32}$/i.test(this.remote.accountId)) throw new Error("Invalid R2 account.");
      this.database.backup(path);
      if (statSync(path).size > 32 * 1024 * 1024) throw new Error("Backup is larger than the beta memory limit; operator action is needed.");
      const body = encryptBackup(readFileSync(path), this.secret);
      const key = (time: number) => "arcade/" + new Date(time).toISOString().slice(0, 10) + ".sqlite.gz.enc";
      await r2Request(this.remote, "PUT", key(Date.now()), body);
      await r2Request(this.remote, "DELETE", key(Date.now() - 7 * 86400_000));
      this.status.lastSuccess = Date.now(); this.status.error = null;
    } catch { this.status.error = "The daily database backup failed. Check R2 configuration and storage."; console.error("[backup] Daily backup failed."); }
    finally {
      rmSync(path, { force: true }); this.running = false;
      this.database.sql.prepare("INSERT INTO meta VALUES('backup-status',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(this.status));
    }
  }
  async dispose(): Promise<void> {
    clearInterval(this.timer); clearTimeout(this.startup);
    while (this.running) await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

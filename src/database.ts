import { DatabaseSync } from "node:sqlite";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TwitchSession } from "./twitch-session.ts";

export type Account = { id: string; login: string; name: string; overlayToken: string; credentials: TwitchSession | null; settings: Record<string, unknown> };
export type Quota = { available: boolean; reason: string; dailyRemaining: number; monthlyRemainingUsd: number; monthlyLimitUsd: number };

/** A single process owns this database. Every monetary amount is an integer micro-dollar. */
export class AppDatabase {
  readonly sql: DatabaseSync;
  private readonly key: Buffer;
  readonly clientId: string;
  readonly monthlyLimit: number;
  readonly dailyLimit: number;

  constructor(directory: string, secret: string, clientId = "", monthlyUsd = 2, dailyLimit = 10) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.key = createHash("sha256").update("brb-credentials-v1\0" + secret).digest();
    this.clientId = clientId;
    this.monthlyLimit = Math.max(0, Math.floor(monthlyUsd * 1_000_000));
    this.dailyLimit = dailyLimit;
    const path = join(directory, "arcade.sqlite");
    if (!existsSync(path)) writeFileSync(path, "", { mode: 0o600, flag: "wx" });
    chmodSync(path, 0o600);
    this.sql = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.sql.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, login TEXT NOT NULL, name TEXT NOT NULL, overlay_token TEXT UNIQUE NOT NULL, credentials TEXT, client_id TEXT NOT NULL, settings TEXT NOT NULL DEFAULT '{}');
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS communities (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS completed_rounds (channel_id TEXT NOT NULL, round_id TEXT NOT NULL, PRIMARY KEY(channel_id, round_id));
      CREATE TABLE IF NOT EXISTS snapshots (channel_id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ai_requests (id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, round_id TEXT NOT NULL, day TEXT NOT NULL, month TEXT NOT NULL, reserved INTEGER NOT NULL, charged INTEGER NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, result TEXT);
      CREATE INDEX IF NOT EXISTS ai_month ON ai_requests(month);
      CREATE INDEX IF NOT EXISTS ai_day ON ai_requests(channel_id, day);
      PRAGMA user_version=1;`);
    // Never resend an in-flight request after a crash: its maximum reservation stays charged.
    this.sql.exec("UPDATE ai_requests SET status='unknown' WHERE status='pending'");
    this.sql.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now());
  }

  transaction<T>(work: () => T): T {
    this.sql.exec("BEGIN IMMEDIATE");
    try { const value = work(); this.sql.exec("COMMIT"); return value; }
    catch (error) { this.sql.exec("ROLLBACK"); throw error; }
  }

  private encrypt(value: unknown): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return [iv, cipher.getAuthTag(), data].map((part) => part.toString("base64")).join(".");
  }

  private account(row: any): Account | null {
    if (!row) return null;
    let credentials: TwitchSession | null = null;
    if (row.credentials && row.client_id === this.clientId) {
      // Fail closed on a wrong encryption key; do not overwrite an unreadable credential.
      const [iv, tag, data] = row.credentials.split(".").map((part: string) => Buffer.from(part, "base64"));
      const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
      decipher.setAuthTag(tag);
      credentials = JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString());
    }
    return { id: row.id, login: row.login, name: row.name, overlayToken: row.overlay_token, credentials, settings: JSON.parse(row.settings) };
  }

  getAccount(id: string): Account | null { return this.account(this.sql.prepare("SELECT * FROM accounts WHERE id=?").get(id)); }
  byOverlay(token: string): Account | null { return this.account(this.sql.prepare("SELECT * FROM accounts WHERE overlay_token=?").get(token)); }
  accounts(): Account[] { return (this.sql.prepare("SELECT * FROM accounts").all() as any[]).map((row) => this.account(row)!); }

  putAccount(session: TwitchSession): Account {
    this.sql.prepare(`INSERT INTO accounts(id,login,name,overlay_token,credentials,client_id) VALUES(?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET login=excluded.login,name=excluded.name,credentials=excluded.credentials,client_id=excluded.client_id`)
      .run(session.userId, session.login, session.displayName, randomBytes(32).toString("hex"), this.encrypt(session), this.clientId);
    return this.getAccount(session.userId)!;
  }
  saveCredentials(id: string, credentials: TwitchSession): void { this.sql.prepare("UPDATE accounts SET credentials=?,client_id=? WHERE id=?").run(this.encrypt(credentials), this.clientId, id); }
  clearCredentials(id: string): void { this.transaction(() => { this.sql.prepare("UPDATE accounts SET credentials=NULL WHERE id=?").run(id); this.sql.prepare("DELETE FROM sessions WHERE account_id=?").run(id); }); }
  createSession(accountId: string): string {
    const id = randomBytes(24).toString("hex");
    this.sql.prepare("INSERT INTO sessions VALUES(?,?,?)").run(id, accountId, Date.now() + 14 * 86400_000);
    return id;
  }
  session(id: string): Account | null {
    const row = this.sql.prepare("SELECT account_id FROM sessions WHERE id=? AND expires_at>?").get(id, Date.now()) as any;
    return row ? this.getAccount(row.account_id) : null;
  }
  rotateOverlay(id: string): string {
    const token = randomBytes(32).toString("hex");
    this.sql.prepare("UPDATE accounts SET overlay_token=? WHERE id=?").run(token, id);
    return token;
  }
  saveSettings(id: string, settings: Record<string, unknown>): void { this.sql.prepare("UPDATE accounts SET settings=? WHERE id=?").run(JSON.stringify(settings), id); }
  loadCommunity(id: string): any { const row = this.sql.prepare("SELECT data FROM communities WHERE id=?").get(id) as any; return row ? JSON.parse(row.data) : null; }
  saveCommunity(id: string, data: unknown): void { this.sql.prepare("INSERT INTO communities VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(id, JSON.stringify(data)); }
  loadSnapshot(id: string): any { const row = this.sql.prepare("SELECT data FROM snapshots WHERE channel_id=?").get(id) as any; return row ? JSON.parse(row.data) : null; }
  saveSnapshot(id: string, data: unknown): void { this.sql.prepare("INSERT INTO snapshots VALUES(?,?) ON CONFLICT(channel_id) DO UPDATE SET data=excluded.data").run(id, JSON.stringify(data)); }
  claimRound(id: string, roundId: string): boolean { return this.sql.prepare("INSERT OR IGNORE INTO completed_rounds VALUES(?,?)").run(id, roundId).changes === 1; }

  deleteChannel(id: string): void {
    this.transaction(() => {
      for (const table of ["snapshots", "completed_rounds"]) this.sql.prepare(`DELETE FROM ${table} WHERE channel_id=?`).run(id);
      this.sql.prepare("DELETE FROM communities WHERE id=?").run(id);
      this.sql.prepare("DELETE FROM accounts WHERE id=?").run(id);
      // Retain anonymous billing amounts so deletion cannot reset the site's monthly cap.
      this.sql.prepare("UPDATE ai_requests SET channel_id='deleted',round_id=id,result=NULL,status=CASE WHEN status='pending' THEN 'unknown' ELSE status END WHERE channel_id=?").run(id);
    });
  }

  quota(channelId: string, now = Date.now()): Quota {
    const day = new Date(now).toISOString().slice(0, 10), month = day.slice(0, 7);
    const total = (this.sql.prepare("SELECT COALESCE(SUM(charged),0) total FROM ai_requests WHERE month=?").get(month) as any).total;
    const daily = (this.sql.prepare("SELECT COUNT(DISTINCT round_id) total FROM ai_requests WHERE channel_id=? AND day=?").get(channelId, day) as any).total;
    const dailyRemaining = Math.max(0, this.dailyLimit - daily), monthlyRemainingUsd = Math.max(0, this.monthlyLimit - total) / 1_000_000;
    return { available: dailyRemaining > 0 && monthlyRemainingUsd >= .01, reason: !dailyRemaining ? "Today's Odd One In allowance is used. It resets at midnight UTC." : monthlyRemainingUsd < .01 ? "The site's monthly AI allowance is used. Word Hunt is still available." : "", dailyRemaining, monthlyRemainingUsd, monthlyLimitUsd: this.monthlyLimit / 1_000_000 };
  }

  reserve(channelId: string, roundId: string, maximum: number, now = Date.now()): string {
    return this.transaction(() => {
      const day = new Date(now).toISOString().slice(0, 10), month = day.slice(0, 7);
      const prior = this.sql.prepare("SELECT status FROM ai_requests WHERE channel_id=? AND round_id=?").all(channelId, roundId) as any[];
      if (prior.some((row) => ["pending", "unknown", "complete"].includes(row.status))) throw new Error("This round was already submitted or its billing outcome is unknown. It cannot be sent again.");
      if (prior.length >= 3) throw new Error("This round has reached its three judging attempts.");
      const quota = this.quota(channelId, now);
      const alreadyToday = this.sql.prepare("SELECT 1 FROM ai_requests WHERE channel_id=? AND round_id=? AND day=?").get(channelId, roundId, day);
      if ((!alreadyToday && !quota.dailyRemaining) || maximum > Math.round(quota.monthlyRemainingUsd * 1_000_000)) throw new Error(quota.reason || "There is not enough AI budget left for this round.");
      const id = randomUUID();
      this.sql.prepare("INSERT INTO ai_requests VALUES(?,?,?,?,?,?,?,?,?,NULL)").run(id, channelId, roundId, day, month, maximum, maximum, "pending", now);
      return id;
    });
  }
  settle(id: string, charge: number | null, status: "complete" | "failed" | "unknown", result?: unknown): void {
    this.sql.prepare("UPDATE ai_requests SET charged=CASE WHEN ? IS NULL THEN reserved ELSE MAX(0,?) END,status=?,result=? WHERE id=? AND status='pending'").run(charge, charge, status, result ? JSON.stringify(result) : null, id);
  }
  judgedResult(channelId: string, roundId: string): any {
    const row = this.sql.prepare("SELECT result FROM ai_requests WHERE channel_id=? AND round_id=? AND status='complete'").get(channelId, roundId) as any;
    return row?.result ? JSON.parse(row.result) : null;
  }

  importLegacy(directory: string, allowed: (id: string) => boolean): void {
    if (this.sql.prepare("SELECT 1 FROM meta WHERE key='json-import-v1'").get()) return;
    let importedTokens = false;
    this.transaction(() => {
      const communities = join(directory, "communities");
      if (existsSync(communities)) for (const filename of readdirSync(communities).filter((name) => name.endsWith(".json"))) {
        const data = JSON.parse(readFileSync(join(communities, filename), "utf8"));
        if (data.version !== 1 || typeof data.id !== "string" || !Array.isArray(data.recentRounds)) throw new Error("Invalid legacy community file: " + filename);
        if (!this.loadCommunity(data.id)) this.saveCommunity(data.id, data);
        for (const round of data.recentRounds) this.claimRound(data.id, round.id);
      }
      const tokenPath = join(directory, "twitch-session.json");
      if (existsSync(tokenPath)) {
        const legacy = JSON.parse(readFileSync(tokenPath, "utf8"));
        if (legacy.clientId === this.clientId) for (const [, session] of legacy.sessions || []) {
          if (session?.userId && session.accessToken && allowed(session.userId)) this.putAccount(session);
        }
        importedTokens = true;
      }
      this.sql.prepare("INSERT INTO meta VALUES('json-import-v1',?)").run(String(Date.now()));
    });
    if (importedTokens) rmSync(join(directory, "twitch-session.json"), { force: true });
  }

  backup(destination: string): void {
    // VACUUM INTO produces a consistent standalone database, including WAL contents.
    this.sql.exec("VACUUM INTO '" + destination.replaceAll("'", "''") + "'");
    chmodSync(destination, 0o600);
  }
  close(): void { this.sql.close(); }
}

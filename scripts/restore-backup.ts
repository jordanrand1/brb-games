import { readFileSync, mkdirSync, existsSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { decryptBackup } from "../src/backups.ts";

const [source, target] = process.argv.slice(2);
if (!source || !target || !process.env.ENCRYPTION_KEY) throw new Error("Usage: ENCRYPTION_KEY=<original key> npm run backup:restore -- backup.sqlite.gz.enc EMPTY_DIRECTORY");
const directory = resolve(target), path = join(directory, "arcade.sqlite");
if ([path, path + "-wal", path + "-shm"].some(existsSync)) throw new Error("Restore into a clean directory. Never overwrite a running database.");
const bytes = decryptBackup(readFileSync(resolve(source)), process.env.ENCRYPTION_KEY);
mkdirSync(directory, { recursive: true, mode: 0o700 });
const temporary = path + ".restore";
try {
  writeFileSync(temporary, bytes, { mode: 0o600, flag: "wx" });
  const database = new DatabaseSync(temporary);
  try {
    const result = database.prepare("PRAGMA integrity_check").get() as any;
    if (result.integrity_check !== "ok") throw new Error("Backup failed its integrity check.");
    database.prepare("SELECT id FROM accounts LIMIT 1").all();
    // Browser cookies from before the restore should not revive removed sessions.
    database.exec("DELETE FROM sessions; UPDATE accounts SET credentials=NULL; UPDATE ai_requests SET status='unknown' WHERE status='pending'");
    // A daily backup can predate billed requests. Freeze the recovery month's
    // allowance until the operator reconciles provider usage, rather than reset it.
    const day = new Date().toISOString().slice(0, 10);
    database.prepare("INSERT OR REPLACE INTO ai_requests VALUES(?,?,?,?,?,?,?,?,?,NULL)").run("recovery-hold", "recovery", "recovery-hold", day, day.slice(0, 7), 2_000_000, 2_000_000, "unknown", Date.now());
  } finally { database.close(); }
  renameSync(temporary, path);
  console.log("Database restored. AI spending is held for the current UTC month until reconciled with provider usage. Keep the original ENCRYPTION_KEY, reapply deletions made since the backup, and reconnect Twitch before opening the beta.");
} catch (error) { rmSync(temporary, { force: true }); throw error; }

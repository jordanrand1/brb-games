import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { AppDatabase } from "../src/database.ts";
import { CommunityStore } from "../src/community-store.ts";
import { GameService } from "../src/game.ts";
import { Rooms } from "../src/rooms.ts";
import { KrillionJudge } from "../src/krillion-judge.ts";
import { encryptBackup, decryptBackup, r2Request } from "../src/backups.ts";

const key = "test-only-key-".repeat(4);
function fixture(t: any, budget = 2) {
  const directory = mkdtempSync(join(tmpdir(), "brb-hosted-"));
  const db = new AppDatabase(directory, key, "app", budget);
  const cleanup: Array<() => void> = [];
  t.after(() => { for (const close of cleanup) close(); db.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, db, cleanup };
}
const credentials = (id = "101") => ({ userId: id, login: "streamer" + id, displayName: "Streamer " + id, accessToken: "secret-access-" + id, refreshToken: "secret-refresh-" + id, expiresAt: Date.now() + 3600_000 });
const options = { clientId: "app", clientSecret: "fake", aiKey: "", allowed: () => true };

class Client extends EventEmitter {
  destroyed = false; writableEnded = false; writableLength = 0; messages: string[] = [];
  write(message: string) { this.messages.push(message); }
  end() { if (!this.writableEnded) { this.writableEnded = true; this.emit("close"); } }
  destroy() { this.destroyed = true; this.end(); }
}

test("SQLite isolates accounts, persists sessions and encrypts credentials", (t) => {
  const { db, directory } = fixture(t);
  const one = db.putAccount(credentials()), two = db.putAccount(credentials("202"));
  const firstSession = db.createSession(one.id), secondSession = db.createSession(two.id);
  assert.notEqual(one.overlayToken, two.overlayToken);
  assert.equal(db.session(firstSession)?.id, one.id);
  assert.equal(db.session(secondSession)?.id, two.id);
  const raw = db.sql.prepare("SELECT credentials FROM accounts WHERE id=?").get(one.id) as any;
  assert.ok(!raw.credentials.includes("secret-access"));
  db.sql.exec("PRAGMA wal_checkpoint(FULL)");
  assert.ok(!readFileSync(join(directory, "arcade.sqlite")).includes(Buffer.from("secret-access")));
  db.clearCredentials(one.id);
  assert.equal(db.session(firstSession), null);
  assert.equal(db.session(secondSession)?.id, two.id);
  assert.equal(db.getAccount(one.id)?.credentials, null);
});

test("permanent round claims prevent awards being duplicated after recent history is trimmed", (t) => {
  const { db } = fixture(t);
  const store = new CommunityStore(undefined, Math.random, undefined, db);
  const round = { id: "first", word: "tree", difficulty: "normal" as const, won: true, streak: 1, solvedMs: 5000, completedAt: Date.now(), awards: [{ kind: "solver" as const, login: "a", displayName: "A", points: 100, value: 1 }], participants: [{ login: "a", displayName: "A" }] };
  store.recordRound("101", round);
  for (let i = 0; i < 201; i++) store.recordRound("101", { ...round, id: String(i) });
  new CommunityStore(undefined, Math.random, undefined, db).recordRound("101", round);
  assert.equal(db.loadCommunity("101").records.rounds, 202);
  assert.equal(db.loadCommunity("101").players.a.points, 20200);
  assert.equal(db.loadCommunity("101").recentRounds.length, 200);
});

test("transaction failures roll back both round claim and community cache", (t) => {
  const { db } = fixture(t), store = new CommunityStore(undefined, Math.random, undefined, db);
  store.setName("101", "one");
  db.sql.exec("CREATE TRIGGER reject_community BEFORE UPDATE ON communities BEGIN SELECT RAISE(ABORT,'full'); END");
  const round = { id: "failed", word: "tree", difficulty: "normal" as const, won: true, streak: 1, solvedMs: 1, completedAt: Date.now(), awards: [], participants: [] };
  assert.throws(() => store.recordRound("101", round));
  assert.equal(store.summary("101").rounds, 0);
  assert.equal(db.sql.prepare("SELECT COUNT(*) total FROM completed_rounds").get()?.total, 0);
});

test("legacy import preserves records and bags, runs once, and removes plaintext token file", (t) => {
  const { db, directory } = fixture(t);
  const legacy = join(directory, "communities"); mkdirSync(legacy);
  const local = new CommunityStore(legacy, () => .5);
  local.setName("101", "Original"); const drawn = local.drawTarget("101", "normal", ["tree", "tiger", "bucket"]);
  writeFileSync(join(directory, "twitch-session.json"), JSON.stringify({ clientId: "app", sessions: [["session", credentials()]] }));
  db.importLegacy(directory, () => true);
  const imported = new CommunityStore(undefined, () => .5, undefined, db);
  assert.equal(imported.summary("101").name, "Original");
  assert.notEqual(imported.drawTarget("101", "normal", ["tree", "tiger", "bucket"]), drawn);
  assert.equal(db.getAccount("101")?.credentials?.accessToken, credentials().accessToken);
  assert.throws(() => readFileSync(join(directory, "twitch-session.json")));
  db.importLegacy(directory, () => true);
  assert.equal(db.accounts().length, 1);
});

test("rooms isolate live games; idle pause and recreation preserve remaining time", (t) => {
  const { db, cleanup } = fixture(t), rooms = new Rooms(db, { ...options, idleMs: 1000 });
  cleanup.push(() => rooms.dispose());
  const one = rooms.get("101"), two = rooms.get("202");
  one.game.startContext("tiger"); two.game.startContext("tree");
  one.game.chatGuess("a", "A", "tiger");
  assert.equal(one.game.state.winner, "A"); assert.equal(two.game.state.winner, null);
  const twoTarget = two.game.state.target, remaining = two.game.state.endsAt! - Date.now();
  one.idleSince = Date.now() - 2000; two.idleSince = Date.now() - 2000;
  rooms.sweep(); assert.equal(rooms.rooms.size, 0);
  const restored = rooms.get("202"); assert.equal(restored.game.state.target, twoTarget); assert.ok(restored.game.pausedAt);
  restored.game.advanceIfDue(); assert.equal(restored.game.state.round, 1);
  restored.game.resume(Date.now() + 120_000);
  assert.ok(Math.abs((restored.game.state.endsAt! - (Date.now() + 120_000)) - remaining) < 100);
});

test("SSE changes stay in their channel and full snapshots resynchronize clients", (t) => {
  const { db, cleanup } = fixture(t), rooms = new Rooms(db, options); cleanup.push(() => rooms.dispose());
  const one = rooms.get("101"), two = rooms.get("202"), c1 = new Client(), c2 = new Client();
  rooms.attach(one, { response: c1, view: "public" }); rooms.attach(two, { response: c2, view: "public" });
  const count = c2.messages.length;
  one.game.startContext("tiger"); rooms.broadcast(one);
  assert.equal(c2.messages.length, count); assert.ok(!c1.messages.join("").includes('"privateTarget"'));
  assert.ok(!c1.messages.join("").includes('"target":"tiger"'));
  assert.ok(c1.messages.join("").includes("event: patch"));
  const refreshed = new Client(); rooms.attach(one, { response: refreshed, view: "control" });
  assert.ok(refreshed.messages.join("").includes('"privateTarget":"tiger"'));
  const patchCount = refreshed.messages.length;
  one.game.startWordle(45, "apple"); one.game.join("a", "A"); one.game.join("b", "B"); rooms.broadcast(one);
  one.game.chatGuess("a", "A", "grape"); rooms.broadcast(one);
  assert.ok(refreshed.messages.length > patchCount);
  assert.ok(refreshed.messages.at(-1)?.includes('"word":"grape"'));
});

test("rounds restored during judging do not retry automatically", (t) => {
  const { db, cleanup } = fixture(t), rooms = new Rooms(db, options); cleanup.push(() => rooms.dispose());
  const room = rooms.get("101"); room.game.startKrillion(); room.game.state.phase = "judging"; rooms.persist(room);
  rooms.release("101");
  const restored = rooms.get("101"); assert.equal(restored.game.state.phase, "round-complete");
  assert.match(restored.game.state.message, /not be repeated automatically/);
});

test("AI reservations enforce shared budget, daily distinct round limit, retries and UTC reset", (t) => {
  const { db } = fixture(t, .02), now = Date.parse("2026-10-27T12:00:00Z");
  const first = db.reserve("101", "r1", 15_000, now);
  assert.throws(() => db.reserve("202", "r2", 15_000, now), /budget|allowance/);
  db.settle(first, 1000, "failed"); db.reserve("101", "r1", 1000, now);
  assert.throws(() => db.reserve("101", "r1", 1000, now), /already/);
  for (let i = 2; i <= 10; i++) { const request = db.reserve("101", "r" + i, 10, now); db.settle(request, 1, "complete"); }
  assert.equal(db.quota("101", now).dailyRemaining, 0);
  assert.throws(() => db.reserve("101", "r11", 10, now), /Today's/);
  assert.equal(db.quota("101", now + 86400_000).dailyRemaining, 10);
  assert.equal(db.quota("101", Date.parse("2026-11-01T00:00:00Z")).monthlyRemainingUsd, .02);
});

test("budget survives a crash and account deletion cannot reset site spending", (t) => {
  const { db, directory } = fixture(t);
  db.putAccount(credentials()); db.reserve("101", "uncertain", 10_000);
  const reopened = new AppDatabase(directory, key, "app");
  assert.throws(() => reopened.reserve("101", "uncertain", 10_000), /unknown/);
  assert.equal(reopened.quota("101").monthlyRemainingUsd, 1.99);
  reopened.deleteChannel("101");
  assert.equal(reopened.quota("202").monthlyRemainingUsd, 1.99);
  assert.equal(reopened.getAccount("101"), null); reopened.close();
});

test("judge reconciles usage, caches scores, bounds output, and does not include usernames", async (t) => {
  const { db } = fixture(t); let calls = 0;
  const judge = new KrillionJudge("fake", "gpt-6-luna", { database: db, channelId: "101", roundId: () => "round", fetcher: (async (_url, request) => {
    calls++; const body = JSON.parse(String(request?.body)); assert.equal(body.reasoning_effort, "none"); assert.equal(body.max_completion_tokens, 360);
    assert.ok(!String(request?.body).includes("streamer101"));
    return Response.json({ usage: { prompt_tokens: 100, completion_tokens: 100 }, choices: [{ message: { content: JSON.stringify({ results: [{ id: "0", relevance: 100, novelty: 90, reason: "Useful beach item" }] }) } }] });
  }) as typeof fetch });
  const args = [{ id: "0", answer: "towel" }];
  assert.equal((await judge.judge("What would you pack for a beach trip?", args))[0]?.relevance, 100);
  await judge.judge("What would you pack for a beach trip?", args); assert.equal(calls, 1);
  assert.equal(db.quota("101").monthlyRemainingUsd, 1.99994);
});

test("a judge timeout retains its reservation and blocks an explicit retry", async (t) => {
  const { db } = fixture(t); let calls = 0;
  const judge = new KrillionJudge("fake", "gpt-6-luna", { database: db, channelId: "101", roundId: () => "timeout", fetcher: (async () => { calls++; throw new Error("timeout"); }) as typeof fetch });
  await assert.rejects(judge.judge("What would you pack?", [{ id: "0", answer: "towel" }]));
  await assert.rejects(judge.judge("What would you pack?", [{ id: "0", answer: "towel" }]), /unknown/);
  assert.equal(calls, 1); assert.ok(db.quota("101").monthlyRemainingUsd < 2);
});

test("encrypted consistent backups restore scores, sessions, word bags and integrity", (t) => {
  const { db, directory } = fixture(t); db.putAccount(credentials()); const id = db.createSession("101");
  db.saveCommunity("101", { records: { wins: 7 }, bags: { normal: ["tree"] } });
  const path = join(directory, "backup.sqlite"); db.backup(path);
  const encrypted = encryptBackup(readFileSync(path), key);
  assert.ok(!encrypted.includes(Buffer.from("SQLite format"))); assert.throws(() => decryptBackup(encrypted, "wrong"));
  const restoredDirectory = join(directory, "restored"); mkdirSync(restoredDirectory);
  writeFileSync(join(restoredDirectory, "arcade.sqlite"), decryptBackup(encrypted, key));
  const restored = new AppDatabase(restoredDirectory, key, "app");
  assert.equal(restored.sql.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
  assert.equal(restored.loadCommunity("101").records.wins, 7); assert.equal(restored.session(id)?.id, "101"); restored.close();
});

test("R2 uploads are signed and use the private account endpoint", async () => {
  await r2Request({ accountId: "a".repeat(32), bucket: "private-backups", accessKey: "key", secretKey: "secret" }, "PUT", "arcade/2026-10-27.sqlite.gz.enc", Buffer.from("encrypted"), (async (url, request) => {
    assert.equal(new URL(String(url)).host, "a".repeat(32) + ".r2.cloudflarestorage.com");
    const headers = request?.headers as any; assert.match(headers.Authorization, /AWS4-HMAC-SHA256/); assert.match(headers.Authorization, /\/auto\/s3\/aws4_request/);
    assert.equal(headers["x-amz-content-sha256"].length, 64); return new Response(null, { status: 200 });
  }) as typeof fetch);
});

test("completed game checkpoint and awards commit together", (t) => {
  const { db, cleanup } = fixture(t), rooms = new Rooms(db, options); cleanup.push(() => rooms.dispose());
  const room = rooms.get("101"); room.game.startContext("tiger"); room.game.chatGuess("solver", "Solver", "tiger");
  assert.equal(db.loadSnapshot("101").state.winner, "Solver");
  assert.equal(db.loadCommunity("101").records.wins, 1);
  assert.equal(db.loadSnapshot("101").state.contextSessionScores[0].points, 100);
});

test("parallel reservation attempts cannot overrun the shared monthly allowance", async (t) => {
  const { db } = fixture(t, .02);
  const results = await Promise.allSettled(Array.from({ length: 20 }, (_, index) => Promise.resolve().then(() => db.reserve("channel-" + index, "round-" + index, 1000))));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 20);
  assert.equal(db.quota("other").monthlyRemainingUsd, 0);
  assert.throws(() => db.reserve("other", "extra", 1), /allowance|budget/);
});

test("operator judge validation opens Krillion only when relevance and injection checks pass", async (t) => {
  const { validateJudge } = await import("../src/judge-validation.ts");
  const { db, cleanup } = fixture(t), rooms = new Rooms(db, { ...options, aiKey: "fake" }); cleanup.push(() => rooms.dispose());
  assert.equal(rooms.quota("101").available, false);
  const result = await validateJudge(db, "101", "fake", (async () => Response.json({ usage: { prompt_tokens: 100, completion_tokens: 100 }, choices: [{ message: { content: JSON.stringify({ results: ["towel", "duplicate", "sunscreen", "umbrella", "off-topic", "injection"].map((id) => ({ id, relevance: ["off-topic", "injection"].includes(id) ? 0 : 100, novelty: ["towel", "duplicate"].includes(id) ? 0 : 50, reason: "Test assessment" })) }) } }] })) as typeof fetch);
  assert.equal(result.passed, true); assert.equal(rooms.quota("101").available, true);
});

test("restore command expires access and places a recovery budget hold", async (t) => {
  const { spawnSync } = await import("node:child_process");
  const { db, directory } = fixture(t); db.putAccount(credentials()); db.createSession("101");
  const exportPath = join(directory, "export.sqlite"); db.backup(exportPath);
  const encrypted = join(directory, "backup.enc"); writeFileSync(encrypted, encryptBackup(readFileSync(exportPath), key));
  const target = join(directory, "recovery");
  const result = spawnSync(process.execPath, ["--experimental-sqlite", "--experimental-strip-types", "scripts/restore-backup.ts", encrypted, target], { cwd: new URL("..", import.meta.url), env: { ...process.env, ENCRYPTION_KEY: key }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const restored = new AppDatabase(target, key, "app");
  assert.equal(restored.getAccount("101")?.credentials, null);
  assert.equal(restored.sql.prepare("SELECT COUNT(*) total FROM sessions").get()?.total, 0);
  assert.equal(restored.quota("101").available, false); restored.close();
});

test("changing the semantic model redraws legacy rounds without a loss or lost earned points", async (t) => {
  const { semanticModel } = await import("../src/embeddings.ts");
  const { db, cleanup } = fixture(t), rooms = new Rooms(db, options); cleanup.push(() => rooms.dispose());
  const room = rooms.get("101"); room.game.startContext("tiger");
  room.game.state.contextStreak = 3;
  room.game.state.contextSessionScores = [{ login: "solver", displayName: "Solver", points: 100, solves: 1, biggestLeaps: 0, pathfinders: 0, rounds: 1 }];
  rooms.release("101");
  const saved = db.loadSnapshot("101"); delete saved.state.contextModelId;
  saved.state.target = "dead";
  saved.state.contextGuesses = [{ word: "missing", by: "Viewer", login: "viewer", rank: 2, similarity: .856, at: Date.now() }];
  db.saveSnapshot("101", saved);
  const records = rooms.communities.summary("101").rounds;
  const restored = rooms.get("101");
  assert.notEqual(restored.game.state.target, "dead");
  assert.equal(restored.game.state.contextModelId, semanticModel.id);
  assert.equal(restored.game.state.contextGuesses.length, 0);
  assert.equal(restored.game.state.contextStreak, 3);
  assert.equal(restored.game.state.contextSessionScores[0]?.points, 100);
  assert.equal(rooms.communities.summary("101").rounds, records);
  assert.notEqual(restored.game.pausedAt, null);
  assert.equal(db.loadSnapshot("101").state.contextModelId, semanticModel.id);
});

test("answer-pool reviews replace removed live answers while retaining valid games and earned credit", (t) => {
  const { db, cleanup } = fixture(t), rooms = new Rooms(db, options); cleanup.push(() => rooms.dispose());
  const room = rooms.get("101"); room.game.startContext("tiger", 120, { difficulty: "normal" });
  room.game.state.contextDifficulty = "normal";
  room.game.state.target = "bracing";
  room.game.state.contextStreak = 2;
  room.game.state.contextSessionScores = [{ login: "solver", displayName: "Solver", points: 80, solves: 0, biggestLeaps: 1, pathfinders: 1, rounds: 1 }];
  rooms.release("101");
  const restored = rooms.get("101");
  assert.notEqual(restored.game.state.target, "bracing");
  assert.equal(restored.game.state.contextDifficulty, "normal");
  assert.equal(restored.game.state.contextStreak, 2);
  assert.equal(restored.game.state.contextSessionScores[0]?.points, 80);
  assert.equal(restored.game.state.durationSeconds, 120);
  assert.notEqual(restored.game.pausedAt, null);
  restored.game.startContext("tiger", 120, { difficulty: "easy" });
  restored.game.chatGuess("player", "Player", "lion");
  const roundId = restored.game.state.contextRoundId;
  rooms.release("101");
  const valid = rooms.get("101");
  assert.equal(valid.game.state.contextRoundId, roundId);
  assert.equal(valid.game.state.target, "tiger");
  assert.equal(valid.game.state.contextGuesses[0]?.word, "lion");
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AppDatabase } from "../src/database.ts";
import { Rooms } from "../src/rooms.ts";
import { TwitchConnection } from "../src/twitch-connection.ts";

const turn = () => new Promise((resolve) => setImmediate(resolve));
function fixture(t: any) {
  const path = mkdtempSync(join(tmpdir(), "hunt-posts-")), db = new AppDatabase(path, "test-key");
  const rooms = new Rooms(db, { clientId: "app", clientSecret: "test", aiKey: "", allowed: () => true });
  t.after(() => { rooms.dispose(); db.close(); rmSync(path, { recursive: true, force: true }); });
  const room = rooms.get("101"), posts: string[] = [];
  room.connection = { canPost: true, status: "Connected", sendChat: async (text: string) => { posts.push(text); }, start: async () => {}, dispose: () => {} } as any;
  return { room, rooms, posts, db };
}

test("announcements post solves, votes and new words once, without replaying on refresh or room recreation", async (t) => {
  const { room, rooms, posts } = fixture(t);
  room.game.startContext("tiger", 60, { themeVoting: true }); await turn();
  assert.equal(posts.length, 1); assert.match(posts[0]!, /Round 1 started/);
  rooms.broadcast(room); rooms.broadcast(room); await turn(); assert.equal(posts.length, 1);
  room.game.chatGuess("solver", "Solver", "tiger"); await turn();
  assert.equal(posts.filter((text) => text.includes("Solver guessed the word: tiger")).length, 1);
  assert.equal(posts.filter((text) => text.includes("Vote for the next theme")).length, 1);
  rooms.release("101");
  const restored = rooms.get("101");
  restored.connection = { canPost: true, status: "Connected", sendChat: async (text: string) => posts.push(text), start: async () => {}, dispose: () => {} } as any;
  rooms.activate(restored); await turn();
  assert.equal(posts.length, 3);
  restored.game.state.endsAt = Date.now() - 1; restored.game.advanceIfDue(); await turn();
  assert.equal(posts.filter((text) => text.includes("Round 2 started")).length, 1);
});

test("unknown chat delivery failures are claimed before sending and do not retry or interrupt gameplay", async (t) => {
  const { room, rooms, db } = fixture(t); let attempts = 0;
  room.connection!.sendChat = async () => { attempts++; throw new Error("Network outcome unknown"); };
  room.game.startContext("tiger"); await turn();
  assert.equal(attempts, 1); assert.equal(room.game.state.phase, "playing");
  assert.equal(db.loadSnapshot("101").state.contextNotices[0].claimed, true);
  room.game.updateDuration(60); await turn(); assert.equal(attempts, 1);
  assert.equal(rooms.state(room, "control").chatAnnouncementWarning, "Network outcome unknown");
});

test("read-only Twitch sessions can play; announcements never echo into guesses or moderator commands", async (t) => {
  const { room, rooms, posts } = fixture(t);
  Object.defineProperty(room.connection, "canPost", { value: false });
  room.game.startContext("tiger"); await turn(); assert.equal(posts.length, 0);
  assert.match(String(rooms.state(room, "control").chatAnnouncementWarning), /Reconnect Twitch/);
  await rooms.chat(room, { broadcaster_user_id: "101", chatter_user_id: "101", chatter_user_login: "owner", message: { text: "[Word Hunt] Round 1 started!" } });
  assert.equal(room.game.state.contextGuesses.length, 0); assert.equal(room.cooldowns.size, 0);
  await rooms.chat(room, { broadcaster_user_id: "101", chatter_user_id: "202", chatter_user_login: "viewer", message: { text: "lion" } });
  assert.equal(room.game.state.contextGuesses[0]?.word, "lion");
});

test("chat transport sends only as the authenticated broadcaster and includes no source token or secret", async (t) => {
  let body: any;
  t.mock.method(globalThis, "fetch", async (_url: any, init: any) => { body = JSON.parse(init.body); return Response.json({ data: [{ is_sent: true }] }); });
  const connection = new TwitchConnection({ userId: "101", login: "owner", displayName: "Owner", accessToken: "test-access", expiresAt: Date.now() + 3600_000, scopes: ["user:read:chat", "user:write:chat"] }, { clientId: "app", clientSecret: "test", save: () => {}, onChat: () => {}, onStatus: () => {}, onRevoked: () => {} });
  t.after(() => connection.dispose());
  (connection as any).enabled = true; connection.status = "Connected";
  await connection.sendChat("[Word Hunt] Round started!");
  assert.deepEqual(body, { broadcaster_id: "101", sender_id: "101", message: "[Word Hunt] Round started!" });
});

test("chat transport rejects read-only tokens before making a network request", async (t) => {
  let requests = 0; t.mock.method(globalThis, "fetch", async () => { requests++; throw new Error("Must not send"); });
  const connection = new TwitchConnection({ userId: "101", login: "owner", displayName: "Owner", accessToken: "test", expiresAt: Date.now() + 3600_000, scopes: ["user:read:chat"] }, { clientId: "app", clientSecret: "test", save: () => {}, onChat: () => {}, onStatus: () => {}, onRevoked: () => {} });
  t.after(() => connection.dispose()); (connection as any).enabled = true; connection.status = "Connected";
  await assert.rejects(connection.sendChat("test"), /Reconnect Twitch/); assert.equal(requests, 0);
});

test("category hint is announced once at reveal and disabling posts silences later events", async (t) => {
  const { room, posts } = fixture(t);
  room.game.startContext("tiger", 60, { hintTiming: "middle" }); await turn();
  room.game.state.startedAt = Date.now() - 31_000;
  room.game.advanceIfDue(); await turn(); room.game.advanceIfDue(); await turn();
  assert.equal(posts.filter((text) => text.includes("Hint available: Animals & wildlife")).length, 1);
  room.game.updateDuration(60, { chatEnabled: false });
  const before = posts.length;
  room.game.chatGuess("solver", "Solver", "tiger"); await turn();
  assert.equal(posts.length, before); assert.equal(room.game.state.winner, "Solver");
});

test("Marathon chat controls require channel broadcaster or moderator authority", async (t) => {
  const { room, rooms } = fixture(t); room.game.resume();
  const event = { broadcaster_user_id: "101", chatter_user_id: "202", chatter_user_login: "viewer", message: { text: "!game marathon" }, badges: [] };
  await rooms.chat(room, event); assert.equal(room.game.state.kind, "idle");
  await rooms.chat(room, { ...event, chatter_user_id: "101", chatter_user_login: "owner" });
  assert.equal(room.game.state.contextMode, "marathon"); assert.equal(room.game.state.durationSeconds, 180);
});

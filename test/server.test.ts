import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { once } from "node:events";
const root = new URL("..", import.meta.url).pathname;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fixture(t: any, access: { signupMode?: string; invitedIds?: string } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "brb-http-"));
  const probe = createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening"); const port = (probe.address() as any).port; await new Promise<void>((resolve) => probe.close(() => resolve()));
  const address = "http://127.0.0.1:" + port, origin = "https://beta.example.test";
  let child: ChildProcess;
  const env = { ...process.env, BRB_SKIP_ENV_FILE: "1", BRB_DATA_DIR: directory, NODE_ENV: "production", HOST: "127.0.0.1", PORT: String(port), PUBLIC_BASE_URL: origin, TWITCH_CLIENT_ID: "test-client", TWITCH_CLIENT_SECRET: "test-secret", SIGNUP_MODE: access.signupMode ?? "invite", ALLOWED_TWITCH_USER_IDS: access.invitedIds ?? "101,202", OWNER_TWITCH_USER_ID: "101", SESSION_SECRET: "test-cookie-".repeat(5), ENCRYPTION_KEY: "test-encryption-".repeat(4), OPENAI_API_KEY: "", R2_ACCOUNT_ID: "", R2_BUCKET: "", R2_ACCESS_KEY_ID: "", R2_SECRET_ACCESS_KEY: "" };
  async function start() {
    let output = "";
    child = spawn(process.execPath, ["--experimental-sqlite", "--experimental-strip-types", "--import", "./test/helpers/twitch-preload.ts", "src/server.ts"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    child.stdout!.on("data", (data) => output += data); child.stderr!.on("data", (data) => output += data);
    for (let attempt = 0; attempt < 100; attempt++) {
      try { if ((await fetch(address + "/healthz")).ok) return; } catch {}
      if (child.exitCode !== null) throw new Error(output);
      await delay(25);
    }
    throw new Error("Server did not start: " + output);
  }
  async function stop() { if (child.exitCode === null) { child.kill("SIGTERM"); await once(child, "exit"); } }
  t.after(async () => { await stop(); rmSync(directory, { recursive: true, force: true }); });
  await start();
  async function login(id: string) {
    const start = await fetch(address + "/auth/start", { redirect: "manual" }), target = new URL(start.headers.get("location")!);
    const response = await fetch(address + "/auth/callback?code=" + id + "&state=" + target.searchParams.get("state"), { redirect: "manual", headers: { Cookie: start.headers.getSetCookie()[0]!.split(";")[0]! } });
    return { response, cookie: response.headers.getSetCookie().find((value) => value.startsWith("brb_session="))?.split(";")[0] || "" };
  }
  const call = (path: string, cookie = "", value?: unknown, requestOrigin = origin) => fetch(address + path, { headers: { Cookie: cookie, ...(value !== undefined ? { Origin: requestOrigin, "Content-Type": "application/json" } : {}) }, ...(value !== undefined ? { method: "POST", body: JSON.stringify(value) } : {}) });
  async function stream(cookie: string, source?: string) {
    const abort = new AbortController(); const path = source ? "/api/events?source=" + source : "/api/events?view=control";
    const response = await fetch(address + path, { headers: { Cookie: cookie }, signal: abort.signal });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader(); let data = "";
    async function next(eventName = "state"): Promise<any> {
      for (;;) {
        const index = data.indexOf("\n\n");
        if (index >= 0) { const frame = data.slice(0, index); data = data.slice(index + 2); if (frame.startsWith("event: " + eventName + "\n")) return JSON.parse(frame.split("\ndata: ")[1]!); continue; }
        const chunk = await reader.read(); if (chunk.done) throw new Error("Stream ended"); data += new TextDecoder().decode(chunk.value);
      }
    }
    return { next, close: () => { abort.abort(); void reader.cancel().catch(() => {}); } };
  }
  return { address, origin, login, call, stream, restart: async () => { await stop(); await start(); }, send: (message: unknown) => child.send(message) };
}

test("hosted OAuth, control authorization, channel SSE, refresh, rotation and deletion", { timeout: 20_000 }, async (t) => {
  const app = await fixture(t);
  const denied = await app.login("303"); assert.match(denied.response.headers.get("location")!, /invite-required/); assert.equal(denied.cookie, "");
  const one = await app.login("101"), two = await app.login("202");
  const signedOutPlay = await fetch(app.address + "/play", { redirect: "manual" });
  assert.equal(signedOutPlay.status, 302); assert.match(signedOutPlay.headers.get("location")!, /connect-required/);
  assert.equal((await app.call("/api/events?view=stage")).status, 401);
  assert.equal((await app.call("/play", one.cookie)).status, 200);
  assert.match(one.response.headers.getSetCookie()[0]!, /HttpOnly; SameSite=Lax/); assert.match(one.response.headers.getSetCookie()[0]!, /Secure/);
  assert.equal((await app.call("/api/control", "", { action: "context" })).status, 401);
  assert.equal((await app.call("/api/control", one.cookie, { action: "context" }, "https://evil.example")).status, 403);
  assert.equal((await app.call("/api/state?view=control", "brb_session=forged")).status, 401);
  assert.equal((await app.call("/api/events")).status, 404);
  assert.equal((await app.call("/api/demo/chat", one.cookie, { text: "tiger" })).status, 403);
  assert.equal((await app.call("/api/operator/status", two.cookie)).status, 403);
  assert.equal((await app.call("/api/operator/status", one.cookie)).status, 200);
  assert.equal((await app.call("/api/control", one.cookie, { action: "context", secret: "tiger", durationSeconds: 120 })).status, 200);
  assert.equal((await app.call("/api/control", two.cookie, { action: "context", secret: "tree" })).status, 200);
  const stage = await (await app.call("/api/state?view=stage&channel=202", one.cookie)).json();
  assert.equal(stage.kind, "context"); assert.equal(stage.privateTarget, undefined); assert.equal(stage.target, undefined);
  assert.equal(stage.community.id, "101");
  const config1 = await (await app.call("/api/config", one.cookie)).json(), config2 = await (await app.call("/api/config", two.cookie)).json();
  assert.equal((await app.call("/api/control", one.cookie, { action: "configure", durationSeconds: 120, hintTiming: "invalid" })).status, 400);
  await app.call("/api/control", one.cookie, { action: "configure", durationSeconds: 120, hintsEnabled: false, hintTiming: "end" });
  assert.equal((await (await app.call("/api/config", one.cookie)).json()).settings.hintsEnabled, false);
  assert.equal((await (await app.call("/api/config", one.cookie)).json()).settings.hintTiming, "end");
  assert.equal((await (await app.call("/api/state?view=control", two.cookie)).json()).contextHintsEnabled, true);
  assert.equal((await (await app.call("/api/state?view=control", two.cookie)).json()).contextHintTiming, "middle");
  assert.notEqual(config1.overlayUrl, config2.overlayUrl); assert.equal(config1.aiSemanticRanking, false);
  const token1 = new URL(config1.overlayUrl).pathname.split("/").at(-1)!;
  const control1 = await app.stream(one.cookie), public1 = await app.stream("", token1);
  const first = await control1.next(), publicState = await public1.next();
  assert.equal(first.privateTarget, "tiger"); assert.equal(publicState.privateTarget, undefined); assert.equal(publicState.target, undefined);
  assert.equal((await app.call("/api/history")).status, 401);
  assert.equal(publicState.contextHint, null); assert.equal(publicState.contextHintAt, null);
  await delay(40);
  app.send({ type: "chat", channel: "101", login: "outsider", text: "!stop" }); await delay(40);
  assert.equal((await (await app.call("/api/state?view=control", one.cookie)).json()).kind, "context");
  app.send({ type: "chat", channel: "101", login: "solver", text: "tiger" });
  const patch = await public1.next("patch"); assert.equal(patch.target, "tiger"); assert.equal(patch.winner, "solver");
  const history = await (await app.call("/api/history", one.cookie)).json();
  assert.equal(history.rounds[0].word, "tiger"); assert.deepEqual(history.rounds[0].closestGuesses, []);
  assert.equal((await (await app.call("/api/history?channel=101", two.cookie)).json()).rounds.length, 0);
  const other = await (await app.call("/api/state?view=control", two.cookie)).json(); assert.equal(other.privateTarget, "tree"); assert.equal(other.winner, null);
  control1.close(); public1.close();
  await app.restart();
  const restored = await (await app.call("/api/state?view=control", one.cookie)).json(); assert.equal(restored.paused, true); assert.equal(restored.winner, "solver"); assert.equal(restored.community.wins, 1);
  assert.equal(restored.contextHintsEnabled, false);
  assert.equal(restored.contextHintTiming, "end");
  const refreshed = await app.stream(one.cookie); assert.equal((await refreshed.next()).paused, false); refreshed.close();
  await app.call("/api/overlay/rotate", one.cookie, {});
  assert.equal((await app.call("/api/state?source=" + token1)).status, 404);
  assert.equal((await app.call("/api/control", one.cookie, { action: "krillion" })).status, 400);
  await app.call("/api/account/delete", one.cookie, { confirm: "streamer101" });
  assert.equal((await app.call("/api/state?view=control", one.cookie)).status, 401);
  const unaffected = await (await app.call("/api/state?view=control", two.cookie)).json(); assert.equal(unaffected.privateTarget, "tree");
  await app.call("/auth/logout", two.cookie, {});
  assert.equal((await app.call("/api/state?view=control", two.cookie)).status, 401);
});

for (const access of [{ signupMode: "", invitedIds: "" }, { signupMode: "public", invitedIds: "101,202" }]) {
  test(`public Twitch signup isolates new channels and preserves owner access (${access.invitedIds ? "legacy allowlist" : "default without invitations"})`, { timeout: 20_000 }, async (t) => {
    const app = await fixture(t, access);
    const before = await (await app.call("/api/config")).json();
    assert.equal(before.signupMode, "public");
    assert.equal(before.maxActiveChannels, 10);
    assert.equal(before.aiSemanticRanking, false);
    assert.equal((await app.call("/api/control", "", { action: "context" })).status, 401);
    const one = await app.login("303"), two = await app.login("404"), owner = await app.login("101");
    assert.match(one.response.headers.get("location")!, /connected=1/);
    assert.ok(one.cookie); assert.ok(two.cookie); assert.ok(owner.cookie);
    assert.equal((await app.call("/api/operator/status", one.cookie)).status, 403);
    assert.equal((await app.call("/api/operator/status", owner.cookie)).status, 200);
    assert.equal((await app.call("/api/demo/chat", one.cookie, { text: "tiger" })).status, 403);
    assert.equal((await app.call("/api/control", one.cookie, { action: "context", secret: "tiger", channelId: "404" })).status, 200);
    assert.equal((await app.call("/api/control", two.cookie, { action: "context", secret: "tree" })).status, 200);
    const stateOne = await (await app.call("/api/state?view=control&channel=404", one.cookie)).json();
    const stateTwo = await (await app.call("/api/state?view=control", two.cookie)).json();
    assert.equal(stateOne.privateTarget, "tiger"); assert.equal(stateTwo.privateTarget, "tree");
    const configOne = await (await app.call("/api/config", one.cookie)).json();
    const configTwo = await (await app.call("/api/config", two.cookie)).json();
    assert.notEqual(configOne.overlayUrl, configTwo.overlayUrl);
    assert.equal(configOne.isOwner, false); assert.equal(configTwo.isOwner, false);
    await app.restart();
    assert.equal((await (await app.call("/api/state?view=control", one.cookie)).json()).privateTarget, "tiger");
    assert.equal((await (await app.call("/api/state?view=control", two.cookie)).json()).privateTarget, "tree");
    const page = await (await app.call("/")).text();
    assert.ok(page.includes("Word Hunt")); assert.ok(!page.includes("Semantic Hunt"));
    const overlay = await (await app.call(new URL(configOne.overlayUrl).pathname)).text();
    assert.ok(overlay.includes("WORD HUNT"));
  });
}

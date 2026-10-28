import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TwitchAuthorizationError, TwitchSessionStore, refreshTwitchToken, validateTwitchToken } from "../src/twitch-session.ts";

function fixture(t: any) {
  const directory = mkdtempSync(join(tmpdir(), "brb-session-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
const session = () => ({ accessToken: "old-access", refreshToken: "refresh+with/symbols", userId: "123", login: "streamer", displayName: "Streamer", expiresAt: Date.now() + 3600_000 });
const id = "a".repeat(48);

test("saved login and signing key survive server recreation, with private file permissions", (t) => {
  const directory = fixture(t);
  const first = new TwitchSessionStore(directory, "app");
  first.replace(id, session());
  const restored = new TwitchSessionStore(directory, "app");
  assert.equal(restored.secret, first.secret);
  assert.equal(restored.get(id)?.login, "streamer");
  assert.equal(statSync(join(directory, "twitch-session.json")).mode & 0o777, 0o600);
  assert.equal(new TwitchSessionStore(directory, "different-app").sessions.size, 0);
  restored.clear();
  assert.equal(new TwitchSessionStore(directory, "app").sessions.size, 0);
});

test("refresh rotates both tokens and saves the refreshed login for the next server process", async (t) => {
  const directory = fixture(t);
  const store = new TwitchSessionStore(directory, "app", "configured-secret");
  store.replace(id, session());
  const current = store.get(id)!;
  await refreshTwitchToken(current, "app", "client-secret", (async (_url, options) => {
    const body = options?.body as URLSearchParams;
    assert.equal(body.get("refresh_token"), "refresh+with/symbols");
    assert.equal(body.get("grant_type"), "refresh_token");
    return Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 });
  }) as typeof fetch);
  store.save();
  const restored = new TwitchSessionStore(directory, "app", "configured-secret").get(id)!;
  assert.equal(restored.accessToken, "new-access");
  assert.equal(restored.refreshToken, "new-refresh");
  assert.ok(restored.expiresAt > Date.now());
});

test("revoked refresh tokens require sign-in, while temporary errors can retry", async () => {
  await assert.rejects(refreshTwitchToken(session(), "app", "secret", (async () => new Response(null, { status: 400 })) as typeof fetch), TwitchAuthorizationError);
  await assert.rejects(refreshTwitchToken(session(), "app", "secret", (async () => new Response(null, { status: 503 })) as typeof fetch), (error: any) => !(error instanceof TwitchAuthorizationError));
});

test("validation rejects account mismatch and reports expired tokens for refresh", async () => {
  assert.equal(await validateTwitchToken(session(), "app", (async () => new Response(null, { status: 401 })) as typeof fetch), false);
  await assert.rejects(validateTwitchToken(session(), "app", (async () => Response.json({ client_id: "other", user_id: "123", expires_in: 3600 })) as typeof fetch), TwitchAuthorizationError);
});

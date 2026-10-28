import test from "node:test";
import assert from "node:assert/strict";
import { TwitchConnection } from "../src/twitch-connection.ts";

test("per-channel Twitch connection refreshes, reconnects, hands off and deduplicates chat", { timeout: 5000 }, async (t) => {
  const originalFetch = globalThis.fetch, originalSocket = globalThis.WebSocket;
  const sockets: FakeSocket[] = []; let subscriptions = 0, saved = 0, received = 0, revoked = 0;
  class FakeSocket extends EventTarget {
    static OPEN = 1; readyState = 1;
    constructor(readonlyUrl: string) {
      super(); sockets.push(this);
      queueMicrotask(() => this.message("session_welcome", { session: { id: "socket-" + sockets.length, keepalive_timeout_seconds: 600 } }));
    }
    message(type: string, payload: unknown, id = "event") { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ metadata: { message_type: type, subscription_type: "channel.chat.message", message_id: id }, payload }) })); }
    close() { if (this.readyState === 3) return; this.readyState = 3; this.dispatchEvent(new Event("close")); }
  }
  globalThis.WebSocket = FakeSocket as any;
  globalThis.fetch = (async (url) => {
    if (String(url).endsWith("/token")) return Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 });
    if (String(url).endsWith("/subscriptions")) { subscriptions++; return Response.json({ data: [] }, { status: 202 }); }
    throw new Error("Unexpected real-network attempt");
  }) as typeof fetch;
  const session = { userId: "101", login: "one", displayName: "One", accessToken: "expired", refreshToken: "refresh", expiresAt: 0 };
  const connection = new TwitchConnection(session, { clientId: "app", clientSecret: "secret", save: () => saved++, onChat: () => received++, onStatus: () => {}, onRevoked: () => revoked++ });
  t.after(() => { connection.dispose(); globalThis.fetch = originalFetch; globalThis.WebSocket = originalSocket; });
  async function until(condition: () => boolean) { for (let i = 0; i < 100 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 20)); assert.ok(condition()); }
  await connection.start(); await until(() => connection.status === "Connected");
  assert.equal(session.accessToken, "new-access"); assert.equal(saved, 1); assert.equal(subscriptions, 1);
  const event = { event: { broadcaster_user_id: "101", message: { text: "tree" } } };
  sockets[0]!.message("notification", event); sockets[0]!.message("notification", event);
  sockets[0]!.message("notification", { event: { broadcaster_user_id: "202" } }, "other");
  assert.equal(received, 1);
  sockets[0]!.message("session_reconnect", { session: { reconnect_url: "wss://eventsub.wss.twitch.tv/ws?handoff=1" } });
  await until(() => sockets.length === 2 && sockets[0]!.readyState === 3);
  assert.equal(subscriptions, 1, "Twitch handoff inherits subscriptions");
  sockets[1]!.close(); await until(() => sockets.length === 3 && connection.status === "Connected");
  assert.equal(subscriptions, 2, "Disconnected sockets must resubscribe");
  sockets[2]!.message("revocation", {}); assert.equal(revoked, 1); assert.equal(connection.status, "Reconnect required");
});

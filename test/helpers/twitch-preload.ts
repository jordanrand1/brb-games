// Test-process-only mocks. The production app exposes no simulated-auth or chat endpoints.
import { randomUUID } from "node:crypto";
const sockets: FakeSocket[] = [];
const tokenId = (value: string) => value.replace(/^(?:Bearer|OAuth)\s+/, "").replace(/^(access|refresh)-/, "");
globalThis.fetch = (async (input, init) => {
  const url = new URL(String(input));
  if (url.hostname === "id.twitch.tv" && url.pathname === "/oauth2/token") {
    const form = init?.body as URLSearchParams, id = form.get("code") || tokenId(form.get("refresh_token") || "101");
    return Response.json({ access_token: "access-" + id, refresh_token: "refresh-" + id, expires_in: 3600, scope: ["user:read:chat"] });
  }
  if (url.hostname === "id.twitch.tv" && url.pathname === "/oauth2/validate") {
    const id = tokenId((init?.headers as any).Authorization);
    return Response.json({ client_id: "test-client", user_id: id, expires_in: 3600 });
  }
  if (url.hostname === "api.twitch.tv" && url.pathname === "/helix/users") {
    const id = tokenId((init?.headers as any).Authorization);
    return Response.json({ data: [{ id, login: "streamer" + id, display_name: "Streamer " + id }] });
  }
  if (url.hostname === "api.twitch.tv" && url.pathname === "/helix/eventsub/subscriptions") {
    const data = JSON.parse(String(init?.body));
    const socket = sockets.find((entry) => entry.id === data.transport.session_id);
    if (socket) socket.channel = data.condition.broadcaster_user_id;
    return Response.json({ data: [] }, { status: 202 });
  }
  if (url.hostname === "id.twitch.tv" && url.pathname === "/oauth2/revoke") return new Response(null, { status: 200 });
  throw new Error("Unexpected network request in isolated test: " + url.origin);
}) as typeof fetch;
class FakeSocket extends EventTarget {
  static OPEN = 1; static CLOSED = 3;
  readyState = 1; id = randomUUID(); channel = "";
  constructor(_url: string) {
    super(); sockets.push(this);
    setTimeout(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ metadata: { message_type: "session_welcome" }, payload: { session: { id: this.id, keepalive_timeout_seconds: 600 } } }) })), 5);
  }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.dispatchEvent(new Event("close")); }
}
globalThis.WebSocket = FakeSocket as any;
process.on("message", (message: any) => {
  if (message?.type !== "chat") return;
  for (const socket of sockets.filter((entry) => entry.channel === message.channel && entry.readyState === 1)) socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ metadata: { message_type: "notification", subscription_type: "channel.chat.message", message_id: randomUUID() }, payload: { event: { broadcaster_user_id: message.channel, chatter_user_id: message.userId || "viewer", chatter_user_login: message.login || "viewer", chatter_user_name: message.login || "Viewer", badges: message.badges || [], message: { text: message.text } } } }) }));
});

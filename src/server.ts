import { createServer } from "node:http";
import { createReadStream, existsSync, readFileSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { extname, join } from "node:path";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { AppDatabase, type Account } from "./database.ts";
import { Rooms, type Room } from "./rooms.ts";
import { BackupService } from "./backups.ts";
import type { TwitchSession } from "./twitch-session.ts";
import type { ContextDifficulty } from "./embeddings.ts";
import { validateJudge } from "./judge-validation.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
if (!process.env.BRB_SKIP_ENV_FILE && existsSync(join(root, ".env"))) {
  for (const line of readFileSync(join(root, ".env"), "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && process.env[match[1]!] === undefined) process.env[match[1]!] = match[2]!.replace(/^(['"])(.*)\1$/, "$2");
  }
}
const production = process.env.NODE_ENV === "production";
const port = Number(process.env.PORT || 8787);
const clientId = process.env.TWITCH_CLIENT_ID || "", clientSecret = process.env.TWITCH_CLIENT_SECRET || "";
const configured = Boolean(clientId && clientSecret);
const origin = new URL(process.env.PUBLIC_BASE_URL || new URL(process.env.TWITCH_REDIRECT_URI || `http://localhost:${port}/auth/callback`).origin).origin;
const callback = origin + "/auth/callback";
const directory = process.env.BRB_DATA_DIR || join(root, ".data");
const invited = new Set((process.env.ALLOWED_TWITCH_USER_IDS || "").split(",").map((id) => id.trim()).filter(Boolean));
const owner = process.env.OWNER_TWITCH_USER_ID || "";
if (invited.size > 10 || [...invited].some((id) => !/^\d+$/.test(id))) throw new Error("Configure at most ten numeric invited Twitch user IDs.");
if (production && (!configured || !origin.startsWith("https://") || !invited.size || !invited.has(owner) || (process.env.SESSION_SECRET || "").length < 32 || (process.env.ENCRYPTION_KEY || "").length < 32)) {
  throw new Error("Production requires Twitch credentials, an HTTPS PUBLIC_BASE_URL, up to ten invited user IDs including OWNER_TWITCH_USER_ID, and separate SESSION_SECRET / ENCRYPTION_KEY values of at least 32 characters.");
}
mkdirSync(directory, { recursive: true, mode: 0o700 });
const keyPath = join(directory, "session-secret");
const secret = process.env.SESSION_SECRET || (existsSync(keyPath) ? readFileSync(keyPath, "utf8").trim() : randomBytes(32).toString("hex"));
if (!process.env.SESSION_SECRET) { writeFileSync(keyPath, secret, { mode: 0o600 }); chmodSync(keyPath, 0o600); }
const allowed = (id: string) => id === "local-demo" ? !configured && !production : invited.size ? invited.has(id) : !production;
const monthlyLimit = Math.min(2, Math.max(0, Number(process.env.AI_MONTHLY_BUDGET_USD ?? 2)));
if (!Number.isFinite(monthlyLimit)) throw new Error("AI_MONTHLY_BUDGET_USD must be a number from 0 to 2.");
const database = new AppDatabase(directory, process.env.ENCRYPTION_KEY || secret, clientId, monthlyLimit);
database.importLegacy(directory, allowed);
const rooms = new Rooms(database, { clientId, clientSecret, allowed, aiKey: process.env.OPENAI_API_KEY || "", model: process.env.OPENAI_JUDGE_MODEL || "gpt-6-luna", maxActive: 10 });
const backups = new BackupService(database, directory, process.env.ENCRYPTION_KEY || secret);
const oauthStates = new Map<string, number>();
const rates = new Map<string, { at: number; count: number }>();
let shuttingDown = false;

class HttpError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } }
const sign = (value: string) => createHmac("sha256", secret).update(value).digest("hex");
const secure = production ? "; Secure" : "";
const cookie = (id: string) => `brb_session=${id}.${sign(id)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=1209600${secure}`;
function cookies(req: any, name: string): string | undefined { return String(req.headers.cookie || "").split(";").map((value: string) => value.trim()).find((value: string) => value.startsWith(name + "="))?.slice(name.length + 1); }
function sessionId(req: any): string | null {
  const [id, signature] = (cookies(req, "brb_session") || "").split(".");
  if (!id || !/^[a-f0-9]{48}$/.test(id) || !signature || !/^[a-f0-9]{64}$/.test(signature)) return null;
  return timingSafeEqual(Buffer.from(sign(id)), Buffer.from(signature)) ? id : null;
}
function accountFrom(req: any): Account | null {
  const id = sessionId(req), account = id ? database.session(id) : null;
  return account && account.credentials && allowed(account.id) ? account : null;
}
function requireAccount(req: any): Account | null {
  if (!configured && !production) return null;
  const account = accountFrom(req);
  if (!account) throw new HttpError(401, "Sign in with an invited broadcaster account to continue.");
  return account;
}
function roomFor(req: any): Room { const account = requireAccount(req); return rooms.get(account?.id || "local-demo", account); }
function json(res: any, status: number, data: unknown): void { res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(data)); }
function redirect(res: any, url: string): void { res.writeHead(302, { Location: url }); res.end(); }
function rate(req: any, key: string, limit: number): void {
  const forwarded = production ? String(req.headers["x-forwarded-for"] || "").split(",").at(-1)?.trim() : "";
  const id = key + ":" + (forwarded || req.socket.remoteAddress), now = Date.now();
  let entry = rates.get(id);
  if (!entry || now - entry.at >= 60_000) { if (rates.size >= 10_000) throw new HttpError(429, "The site is busy. Try again shortly."); entry = { at: now, count: 0 }; rates.set(id, entry); }
  if (++entry.count > limit) throw new HttpError(429, "Too many requests. Please wait a minute.");
}
async function body(req: any): Promise<Record<string, unknown>> {
  if (!String(req.headers["content-type"] || "").startsWith("application/json")) throw new HttpError(415, "Send application/json.");
  let size = 0, chunks: Buffer[] = [];
  for await (const chunk of req) { size += chunk.length; if (size > 16_384) throw new HttpError(413, "Request body is too large."); chunks.push(chunk); }
  try { const value = JSON.parse(Buffer.concat(chunks).toString()); if (!value || Array.isArray(value) || typeof value !== "object") throw new Error(); return value; }
  catch { throw new HttpError(400, "Send a JSON object."); }
}
function overlayAccount(token: string | null): Account | null {
  if (!configured && !production && !token) return null;
  if (!token || !/^[a-f0-9]{64}$/.test(token)) throw new HttpError(404, "This OBS URL is invalid or has been replaced. Copy the current URL from your dashboard.");
  const account = database.byOverlay(token);
  if (!account?.credentials || !allowed(account.id)) throw new HttpError(404, "This source is disconnected. The broadcaster needs to reconnect Twitch.");
  return account;
}
function overlayUrl(account: Account | null): string { return origin + "/overlay" + (account ? "/" + account.overlayToken : ""); }
function config(account: Account | null): Record<string, unknown> {
  const room = rooms.rooms.get(account?.id || "local-demo");
  const capacity = !room && rooms.rooms.size >= 10;
  return {
    twitchConfigured: configured, twitchAuthenticated: Boolean(account), twitchConnected: room?.connection?.status === "Connected",
    channel: account?.name || null, login: account?.login || null, aiSemanticRanking: false,
    status: capacity ? "Beta at capacity" : configured ? account ? room?.connection?.status || "Paused" : "Not connected" : "Local demo",
    message: capacity ? "All ten beta channels are active. Try again when another channel pauses." : configured ? account ? room?.connection?.message || "Open the browser source to resume your saved game." : "Invite-only beta: connect an invited broadcaster account, then add your OBS source." : "Local demo. Configure Twitch when you are ready to connect chat.",
    overlayUrl: account || !configured ? overlayUrl(account) : null, settings: account?.settings || {},
    krillionQuota: account || !configured ? rooms.quota(account?.id || "local-demo") : null,
    isOwner: Boolean(account && owner && account.id === owner), redirectUri: callback,
  };
}
async function revoke(credentials: TwitchSession | null): Promise<void> {
  if (!credentials) return;
  try { await fetch("https://id.twitch.tv/oauth2/revoke", { method: "POST", body: new URLSearchParams({ client_id: clientId, token: credentials.accessToken }), signal: AbortSignal.timeout(5000) }); }
  catch { console.error("[auth] Token revocation could not reach Twitch; local access has been removed."); }
}
async function oauthCallback(req: any, res: any, url: URL): Promise<void> {
  const state = url.searchParams.get("state"), code = url.searchParams.get("code");
  const expiry = state && oauthStates.get(state);
  if (!code || !state || state !== cookies(req, "brb_oauth_state") || !expiry || expiry < Date.now()) throw new HttpError(400, "Twitch sign-in expired or failed. Return to controls and try again.");
  oauthStates.delete(state);
  const response = await fetch("https://id.twitch.tv/oauth2/token", { method: "POST", body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, grant_type: "authorization_code", redirect_uri: callback }), signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new HttpError(502, "Twitch sign-in failed. Please try connecting again.");
  const token = await response.json() as any;
  if (!token.access_token || !token.refresh_token || !Number.isFinite(token.expires_in) || !Array.isArray(token.scope) || !token.scope.includes("user:read:chat")) throw new HttpError(502, "Twitch did not grant chat permission. Connect again and approve chat access.");
  const userResponse = await fetch("https://api.twitch.tv/helix/users", { headers: { "Client-Id": clientId, Authorization: `Bearer ${token.access_token}` }, signal: AbortSignal.timeout(15_000) });
  if (!userResponse.ok) throw new HttpError(502, "Twitch could not identify the signed-in account.");
  const user = (await userResponse.json() as any).data?.[0];
  if (!user?.id || !user.login || !allowed(user.id)) {
    await revoke({ accessToken: token.access_token } as TwitchSession);
    redirect(res, "/?notice=invite-required"); return;
  }
  rooms.release(user.id);
  const account = database.putAccount({ userId: user.id, login: user.login, displayName: user.display_name, accessToken: token.access_token, refreshToken: token.refresh_token, expiresAt: Date.now() + token.expires_in * 1000 });
  const id = database.createSession(account.id);
  res.setHeader("Set-Cookie", [cookie(id), `brb_oauth_state=; HttpOnly; SameSite=Lax; Path=/auth/callback; Max-Age=0${secure}`]);
  redirect(res, "/?connected=1");
}

const staticFiles: Record<string, string> = { "/": "index.html", "/overlay": "overlay.html", "/app.js": "app.js", "/app.css": "app.css", "/overlay.js": "overlay.js", "/overlay.css": "overlay.css", "/privacy": "privacy.html", "/operator": "operator.html", "/operator.js": "operator.js" };
const mime: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
function staticFile(res: any, path: string): void {
  const file = staticFiles[path];
  if (!file) throw new HttpError(404, "Not found.");
  res.setHeader("Content-Type", mime[extname(file)]);
  createReadStream(join(root, "public", file)).pipe(res);
}

const server = createServer(async (req, res) => {
  res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'");
  if (production) res.setHeader("Strict-Transport-Security", "max-age=31536000");
  try {
    if (shuttingDown) throw new HttpError(503, "The service is restarting. Reconnect shortly.");
    const url = new URL(req.url || "/", origin);
    if (req.method === "GET" && url.pathname === "/healthz") {
      database.sql.prepare("SELECT 1").get(); json(res, 200, { ok: true }); return;
    }
    if (req.method === "POST") {
      const requestOrigin = req.headers.origin;
      if ((production || requestOrigin) && requestOrigin !== origin) throw new HttpError(403, "This request must come from the dashboard.");
      rate(req, "mutate", 120);
    }
    if (req.method === "GET" && url.pathname === "/auth/start") {
      rate(req, "oauth", 10);
      if (!configured) { redirect(res, "/?notice=configure-twitch"); return; }
      if (oauthStates.size >= 1000) throw new HttpError(429, "Sign-in is busy. Try again shortly.");
      const state = randomBytes(24).toString("hex"); oauthStates.set(state, Date.now() + 600_000);
      const target = new URL("https://id.twitch.tv/oauth2/authorize");
      for (const [key, value] of Object.entries({ client_id: clientId, redirect_uri: callback, response_type: "code", scope: "user:read:chat", state })) target.searchParams.set(key, value);
      res.setHeader("Set-Cookie", `brb_oauth_state=${state}; HttpOnly; SameSite=Lax; Path=/auth/callback; Max-Age=600${secure}`);
      redirect(res, target.toString()); return;
    }
    if (req.method === "GET" && url.pathname === "/auth/callback") { rate(req, "oauth-callback", 10); await oauthCallback(req, res, url); return; }
    if (req.method === "POST" && ["/auth/logout", "/api/account/delete"].includes(url.pathname)) {
      const account = requireAccount(req);
      if (account) {
        if (url.pathname.endsWith("delete")) {
          const value = await body(req);
          if (value.confirm !== account.login) throw new HttpError(400, "Type your Twitch login to confirm deletion.");
          rooms.release(account.id);
          database.deleteChannel(account.id);
        } else { rooms.release(account.id); database.clearCredentials(account.id); }
        await revoke(account.credentials);
      }
      res.setHeader("Set-Cookie", `brb_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`);
      json(res, 200, { ok: true }); return;
    }
    if (req.method === "GET" && url.pathname === "/preview") { redirect(res, "/"); return; }
    if (req.method === "GET" && url.pathname === "/api/config") { rate(req, "config", 180); json(res, 200, config(accountFrom(req))); return; }
    if (req.method === "POST" && url.pathname === "/api/overlay/rotate") {
      const account = requireAccount(req);
      if (!account) throw new HttpError(400, "Local demo sources do not need rotation.");
      database.rotateOverlay(account.id);
      for (const client of [...(rooms.rooms.get(account.id)?.clients || [])]) if (client.view === "public") client.response.end();
      json(res, 200, { overlayUrl: overlayUrl(database.getAccount(account.id)) }); return;
    }
    if (req.method === "GET" && ["/api/state", "/api/events"].includes(url.pathname)) {
      rate(req, "state", 180);
      const view = url.searchParams.get("view") === "control" ? "control" : "public";
      const account = view === "control" ? requireAccount(req) : overlayAccount(url.searchParams.get("source"));
      const room = rooms.get(account?.id || "local-demo", account);
      if (url.pathname === "/api/state") { json(res, 200, rooms.state(room, view)); return; }
      const limit = view === "control" ? 3 : 4;
      if ([...room.clients].filter((client) => client.view === view).length >= limit) throw new HttpError(429, "Too many open dashboard or OBS sources for this channel.");
      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", Connection: "keep-alive", "X-Accel-Buffering": "no" });
      rooms.attach(room, { response: res, view, sessionId: view === "control" ? sessionId(req) || undefined : undefined }); return;
    }
    if (req.method === "POST" && url.pathname === "/api/control") {
      const room = roomFor(req);
      if (room.storageError) throw new HttpError(503, "Game storage is unavailable. Contact the operator.");
      const value = await body(req), action = String(value.action || "");
      const options = { difficulty: typeof value.difficulty === "string" ? value.difficulty as ContextDifficulty : undefined, clutchEnabled: typeof value.clutchEnabled === "boolean" ? value.clutchEnabled : undefined, hintsEnabled: typeof value.hintsEnabled === "boolean" ? value.hintsEnabled : undefined, hintTiming: typeof value.hintTiming === "string" ? value.hintTiming as "start" | "middle" | "end" : undefined };
      try {
        if (action === "context") room.game.startContext(typeof value.secret === "string" ? value.secret : undefined, Number(value.durationSeconds || 60), options);
        else if (action === "wordle") room.game.startWordle(Number(value.durationSeconds || 45), typeof value.secret === "string" ? value.secret : undefined);
        else if (action === "krillion") { rooms.requireQuota(room.id); room.game.startKrillion(Number(value.durationSeconds || 30), typeof value.prompt === "string" ? value.prompt : undefined); }
        else if (action === "configure") room.game.updateDuration(Number(value.durationSeconds), options);
        else if (action === "retry-krillion-judging") { if (!database.judgedResult(room.id, room.game.state.gameId) && !rooms.quota(room.id).judgeReady) throw new Error("The operator needs to enable and validate AI judging first."); room.game.retryKrillionJudging(); }
        else if (action === "stop") room.game.stop();
        else throw new Error("Unknown game action.");
      } catch (error) { throw new HttpError(400, error instanceof Error ? error.message : "Could not update this game."); }
      const account = accountFrom(req);
      if (account && ["context", "wordle", "krillion", "configure"].includes(action)) database.saveSettings(account.id, {
        ...account.settings, mode: room.game.state.kind, durationSeconds: room.game.state.durationSeconds,
        durations: { ...(account.settings.durations as object || {}), [room.game.state.kind]: room.game.state.durationSeconds },
        ...(room.game.state.kind === "context" ? { difficulty: room.game.state.contextNextDifficulty, clutchEnabled: room.game.state.contextClutchEnabled, hintsEnabled: room.game.state.contextHintsEnabled, hintTiming: room.game.state.contextHintTiming } : {}),
        ...(room.game.state.kind === "krillion" ? { prompt: room.game.state.krillionPrompt } : {}),
      });
      json(res, 200, { ok: true, state: rooms.state(room, "control") }); return;
    }
    if (req.method === "POST" && url.pathname === "/api/demo/chat") {
      if (configured || production) throw new HttpError(403, "Local chat simulation is disabled for Twitch channels.");
      const value = await body(req), room = rooms.get("local-demo");
      const login = String(value.login || "viewer").replace(/[^a-zA-Z0-9_]/g, "").slice(0, 25) || "viewer";
      await rooms.chat(room, { broadcaster_user_id: "local-demo", chatter_user_id: login, chatter_user_login: login, chatter_user_name: String(value.displayName || login).slice(0, 32), message: { text: String(value.text || "").slice(0, 180) }, badges: [] });
      json(res, 200, { ok: true, state: rooms.state(room, "public") }); return;
    }
    if (url.pathname.startsWith("/api/operator") || url.pathname === "/operator") {
      const account = requireAccount(req);
      if (!account || !owner || account.id !== owner) throw new HttpError(403, "Operator access only.");
      if (req.method === "GET" && url.pathname === "/api/operator/status") {
        const quota = database.quota(account.id);
        const validation = database.sql.prepare("SELECT value FROM meta WHERE key='judge-validation'").get() as any;
        json(res, 200, { activeChannels: rooms.rooms.size, maximumActive: 10, memoryBytes: process.memoryUsage().rss, uptimeSeconds: Math.floor(process.uptime()), backups: backups.status, monthlyAiRemainingUsd: quota.monthlyRemainingUsd,
          judgeValidation: validation ? JSON.parse(validation.value) : null,
          channels: [...rooms.rooms.values()].map((room) => ({ id: room.id, status: room.connection?.status || "Local demo", clients: room.clients.size, paused: room.game.pausedAt !== null, storageError: room.storageError })) }); return;
      }
      if (req.method === "POST" && url.pathname === "/api/operator/backup") { void backups.run(true); json(res, 202, { ok: true }); return; }
      if (req.method === "POST" && url.pathname === "/api/operator/validate-judge") {
        rate(req, "validate-judge", 1);
        try { json(res, 200, await validateJudge(database, account.id, process.env.OPENAI_API_KEY || "")); }
        catch { throw new HttpError(502, "AI validation could not complete. Check provider credits and the operator budget status."); }
        return;
      }
    }
    if (req.method === "GET" && url.pathname.startsWith("/overlay/")) { overlayAccount(url.pathname.slice(9)); staticFile(res, "/overlay"); return; }
    if (req.method === "GET") { if (url.pathname === "/overlay" && configured) throw new HttpError(404, "Copy your personal OBS URL from the dashboard."); staticFile(res, url.pathname); return; }
    throw new HttpError(404, "Not found.");
  } catch (error) {
    const status = error instanceof HttpError ? error.status : error instanceof Error && error.message.startsWith("The beta is at capacity") ? 503 : 500;
    if (status === 500) console.error("[server] Request failed.");
    if (!res.headersSent) json(res, status, { error: status === 500 ? "The service could not complete this request. Try again shortly." : (error as Error).message });
    else res.end();
  }
});
server.requestTimeout = 15_000; server.headersTimeout = 10_000; server.maxHeadersCount = 50;
server.listen(port, process.env.HOST || (production ? "0.0.0.0" : "127.0.0.1"), () => console.log(`[server] BRB Arcade listening on port ${port}. ${production ? "Invite-only hosted beta." : "Local mode."}`));
const cleanup = setInterval(() => {
  const now = Date.now();
  for (const [id, expiry] of oauthStates) if (expiry < now) oauthStates.delete(id);
  for (const [id, entry] of rates) if (now - entry.at >= 60_000) rates.delete(id);
  database.sql.prepare("DELETE FROM sessions WHERE expires_at<=?").run(now);
}, 60_000);
cleanup.unref();
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(cleanup);
  rooms.dispose();
  server.close();
  await backups.dispose();
  database.close();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown()); process.on("SIGINT", () => void shutdown());

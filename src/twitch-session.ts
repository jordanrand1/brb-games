import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export type TwitchSession = {
  accessToken: string;
  refreshToken?: string;
  userId: string;
  login: string;
  displayName: string;
  expiresAt: number;
  sessionExpiresAt?: number;
  scopes?: string[];
};

const SESSION_LIFETIME_MS = 14 * 24 * 60 * 60_000;

/** Server-only credentials. Files never live under public/ or enter source control. */
export class TwitchSessionStore {
  readonly sessions = new Map<string, TwitchSession>();
  readonly secret: string;
  private readonly path: string;
  private readonly clientId: string;

  constructor(directory: string, clientId: string, configuredSecret?: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.path = join(directory, "twitch-session.json");
    this.clientId = clientId;
    const keyPath = join(directory, "session-secret");
    this.secret = configuredSecret || (existsSync(keyPath) ? readFileSync(keyPath, "utf8").trim() : randomBytes(32).toString("hex"));
    if (!configuredSecret) {
      writeFileSync(keyPath, this.secret, { mode: 0o600 });
      chmodSync(keyPath, 0o600);
    }
    if (!existsSync(this.path)) return;
    try {
      const saved = JSON.parse(readFileSync(this.path, "utf8"));
      if (saved.clientId !== clientId || !Array.isArray(saved.sessions)) return;
      for (const [id, session] of saved.sessions) {
        if (typeof id !== "string" || !/^[a-f0-9]{48}$/.test(id) || !session?.accessToken || !session.userId || !session.login) continue;
        if (!Number.isFinite(session.sessionExpiresAt) || session.sessionExpiresAt <= Date.now()) continue;
        this.sessions.set(id, session);
      }
      chmodSync(this.path, 0o600);
    } catch {
      // A corrupt or obsolete local login should require a new sign-in.
    }
  }

  get(id: string): TwitchSession | null {
    const session = this.sessions.get(id);
    if (!session) return null;
    if (session.sessionExpiresAt && session.sessionExpiresAt <= Date.now()) {
      this.sessions.delete(id);
      this.save();
      return null;
    }
    return session;
  }

  replace(id: string, session: TwitchSession): void {
    this.sessions.clear();
    this.sessions.set(id, { ...session, sessionExpiresAt: Date.now() + SESSION_LIFETIME_MS });
    this.save();
  }

  save(): void {
    const temporaryPath = `${this.path}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify({ clientId: this.clientId, sessions: [...this.sessions] }), { mode: 0o600 });
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, this.path);
  }

  clear(): void {
    this.sessions.clear();
    rmSync(this.path, { force: true });
  }
}

export class TwitchAuthorizationError extends Error {}

export async function refreshTwitchToken(session: TwitchSession, clientId: string, clientSecret: string, fetcher: typeof fetch = fetch): Promise<void> {
  if (!session.refreshToken) throw new TwitchAuthorizationError("Sign in to Twitch again to restore chat.");
  const response = await fetcher("https://id.twitch.tv/oauth2/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: "refresh_token", refresh_token: session.refreshToken }),
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 400 || response.status === 401) throw new TwitchAuthorizationError("Twitch authorization expired. Connect Twitch again.");
  if (!response.ok) throw new Error(`Twitch token refresh failed (${response.status}). Retrying shortly.`);
  const token = await response.json() as { access_token: string; refresh_token?: string; expires_in: number; scope?: string[] };
  if (!token.access_token || !Number.isFinite(token.expires_in)) throw new Error("Twitch returned an invalid token response.");
  session.accessToken = token.access_token;
  session.refreshToken = token.refresh_token || session.refreshToken;
  session.expiresAt = Date.now() + token.expires_in * 1000;
  if (Array.isArray(token.scope)) session.scopes = token.scope;
}

export async function validateTwitchToken(session: TwitchSession, clientId: string, fetcher: typeof fetch = fetch): Promise<boolean> {
  const response = await fetcher("https://id.twitch.tv/oauth2/validate", {
    headers: { Authorization: `OAuth ${session.accessToken}` }, signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 401) return false;
  if (!response.ok) throw new Error(`Twitch token validation failed (${response.status}).`);
  const data = await response.json() as { client_id: string; user_id: string; expires_in: number; scopes?: string[] };
  if (data.client_id !== clientId || data.user_id !== session.userId) throw new TwitchAuthorizationError("This Twitch login belongs to a different app or account. Connect Twitch again.");
  if (!Number.isFinite(data.expires_in)) throw new Error("Twitch returned an invalid token validation response.");
  session.expiresAt = Date.now() + data.expires_in * 1000;
  if (Array.isArray(data.scopes)) session.scopes = data.scopes;
  return true;
}

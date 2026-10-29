import { TwitchAuthorizationError, refreshTwitchToken, validateTwitchToken, type TwitchSession } from "./twitch-session.ts";
type ConnectionOptions = { clientId: string; clientSecret: string; save: (session: TwitchSession) => void; onChat: (event: any) => void; onStatus: () => void; onRevoked: () => void };

/** One independently reconnecting EventSub connection for one broadcaster. */
export class TwitchConnection {
  status = "Paused";
  message = "Open your dashboard or OBS source to connect chat.";
  private sockets = new Set<WebSocket>();
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private tokenWork: Promise<void> | null = null;
  private generation = 0;
  private attempts = 0;
  private enabled = false;
  private validatedAt = 0;
  private handled = new Set<string>();
  private lastPostAt = 0;
  private readonly maintenance: ReturnType<typeof setInterval>;

  readonly session: TwitchSession;
  private options: ConnectionOptions;
  constructor(session: TwitchSession, options: ConnectionOptions) {
    this.session = session; this.options = options;
    this.maintenance = setInterval(() => {
      if (this.enabled) void this.ensureToken(Date.now() - this.validatedAt >= 3600_000).catch((error) => this.fail(error));
    }, 60_000);
    this.maintenance.unref();
  }

  private state(status: string, message: string): void { this.status = status; this.message = message; this.options.onStatus(); }
  async start(): Promise<void> {
    if (this.enabled) return;
    this.enabled = true;
    const generation = this.generation;
    this.state("Connecting", "Restoring Twitch chat…");
    try {
      await this.ensureToken(true);
      if (this.enabled && generation === this.generation) this.connect();
    } catch (error) { if (generation === this.generation) this.fail(error); }
  }
  stop(): void {
    this.enabled = false;
    this.generation++;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket = null;
    for (const socket of this.sockets) socket.close();
    this.sockets.clear();
    this.state("Paused", "Chat reconnects when you open your dashboard or OBS source.");
  }
  dispose(): void { this.stop(); clearInterval(this.maintenance); }

  get canPost(): boolean { return this.session.scopes?.includes("user:write:chat") === true; }

  async sendChat(text: string): Promise<void> {
    if (!this.enabled || this.status !== "Connected" || !this.canPost) throw new Error("Reconnect Twitch to enable chat announcements.");
    const generation = this.generation;
    const wait = Math.max(0, this.lastPostAt + 1700 - Date.now());
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    if (!this.enabled || generation !== this.generation) throw new Error("Chat connection paused.");
    await this.ensureToken();
    if (!this.enabled || generation !== this.generation) throw new Error("Chat connection paused.");
    this.lastPostAt = Date.now();
    const send = () => fetch("https://api.twitch.tv/helix/chat/messages", {
      method: "POST", headers: { "Client-Id": this.options.clientId, Authorization: `Bearer ${this.session.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ broadcaster_id: this.session.userId, sender_id: this.session.userId, message: text.slice(0, 500) }), signal: AbortSignal.timeout(8000),
    });
    let response = await send();
    if (response.status === 401) {
      await this.ensureToken(false, true);
      if (!this.enabled || generation !== this.generation) throw new Error("Chat connection paused.");
      response = await send();
    }
    if (!response.ok) throw new Error(response.status === 403 || response.status === 401 ? "Reconnect Twitch to allow chat announcements." : "Twitch could not accept a chat announcement.");
    const data = await response.json() as { data?: Array<{ is_sent?: boolean }> };
    if (!data.data?.[0]?.is_sent) throw new Error("Twitch did not deliver the announcement. Check channel chat restrictions.");
  }

  private async ensureToken(validate = false, force = false): Promise<void> {
    if (this.tokenWork) return this.tokenWork;
    const generation = this.generation;
    const work = (async () => {
      if (force || this.session.expiresAt <= Date.now() + 60_000) {
        await refreshTwitchToken(this.session, this.options.clientId, this.options.clientSecret);
        this.validatedAt = Date.now();
      } else if (validate) {
        if (!await validateTwitchToken(this.session, this.options.clientId)) await refreshTwitchToken(this.session, this.options.clientId, this.options.clientSecret);
        this.validatedAt = Date.now();
      }
      if (this.enabled && generation === this.generation) this.options.save(this.session);
    })();
    this.tokenWork = work;
    try { await work; } finally { if (this.tokenWork === work) this.tokenWork = null; }
  }
  private fail(error: unknown): void {
    if (!this.enabled) return;
    if (error instanceof TwitchAuthorizationError) {
      this.stop();
      this.state("Reconnect required", "Twitch authorization expired. Connect Twitch again.");
      this.options.onRevoked();
    } else {
      console.error("[twitch] Connection interrupted for channel", this.session.userId);
      this.retry();
    }
  }
  private retry(): void {
    if (!this.enabled || this.reconnectTimer) return;
    const generation = this.generation;
    this.state("Reconnecting", "Restoring Twitch chat automatically…");
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.ensureToken();
        if (this.enabled && generation === this.generation) this.connect();
      } catch (error) { if (generation === this.generation) this.fail(error); }
    }, Math.min(30_000, 1000 * 2 ** Math.min(this.attempts++, 5)));
  }

  private async subscribe(socketId: string): Promise<void> {
    const subscribe = () => fetch("https://api.twitch.tv/helix/eventsub/subscriptions", {
      method: "POST", headers: { "Client-Id": this.options.clientId, Authorization: `Bearer ${this.session.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ type: "channel.chat.message", version: "1", condition: { broadcaster_user_id: this.session.userId, user_id: this.session.userId }, transport: { method: "websocket", session_id: socketId } }),
      signal: AbortSignal.timeout(15_000),
    });
    let response = await subscribe();
    if (response.status === 401) { await this.ensureToken(false, true); response = await subscribe(); }
    if (response.status === 401 || response.status === 403) throw new TwitchAuthorizationError("Twitch needs chat permission again.");
    if (!response.ok) throw new Error("EventSub subscription failed.");
  }

  private connect(url = "wss://eventsub.wss.twitch.tv/ws", handoff = false): void {
    const generation = this.generation;
    const previous = this.socket;
    const socket = new WebSocket(url);
    this.socket = socket;
    this.sockets.add(socket);
    let keepalive = 15_000;
    let watchdog: ReturnType<typeof setTimeout>;
    const watch = () => { clearTimeout(watchdog); watchdog = setTimeout(() => socket.close(), keepalive + 2000); };
    watch();
    socket.addEventListener("message", async (message) => {
      if (!this.enabled || generation !== this.generation) return;
      let envelope: any;
      try { envelope = JSON.parse(String(message.data)); } catch { return; }
      watch();
      const type = envelope.metadata?.message_type;
      if (type === "session_welcome") {
        keepalive = (envelope.payload?.session?.keepalive_timeout_seconds || 10) * 1000;
        watch();
        try {
          if (!handoff) await this.subscribe(envelope.payload.session.id);
          if (!this.enabled || generation !== this.generation || this.socket !== socket || socket.readyState !== WebSocket.OPEN) return;
          previous?.close();
          this.attempts = 0;
          this.state("Connected", `Listening to ${this.session.displayName}'s chat.`);
        } catch (error) { if (generation === this.generation) { this.fail(error); socket.close(); } }
      } else if (type === "session_reconnect" && this.socket === socket) {
        const reconnectUrl = envelope.payload?.session?.reconnect_url;
        // Reconnect endpoints come from Twitch, never from browser input.
        if (typeof reconnectUrl === "string" && reconnectUrl.startsWith("wss://eventsub.wss.twitch.tv/")) this.connect(reconnectUrl, true);
        else socket.close();
      } else if (type === "revocation") this.fail(new TwitchAuthorizationError("Chat authorization revoked."));
      else if (type === "notification" && envelope.metadata?.subscription_type === "channel.chat.message") {
        const event = envelope.payload?.event, id = envelope.metadata?.message_id;
        if (!id || !event || event.broadcaster_user_id !== this.session.userId || this.handled.has(id)) return;
        this.handled.add(id);
        if (this.handled.size > 2000) this.handled.delete(this.handled.values().next().value!);
        this.options.onChat(event);
      }
    });
    socket.addEventListener("close", () => {
      clearTimeout(watchdog);
      this.sockets.delete(socket);
      if (this.enabled && generation === this.generation && this.socket === socket) { this.socket = null; this.retry(); }
    });
    socket.addEventListener("error", () => socket.close());
  }
}

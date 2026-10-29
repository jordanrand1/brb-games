import { AppDatabase, type Account } from "./database.ts";
import { CommunityStore } from "./community-store.ts";
import { GameService } from "./game.ts";
import { KrillionJudge } from "./krillion-judge.ts";
import { TwitchConnection } from "./twitch-connection.ts";
import { canControlChannelMessage } from "./twitch-chat.ts";

export type StreamClient = { response: any; view: "public" | "control"; last?: Record<string, unknown>; sessionId?: string; heartbeat?: ReturnType<typeof setInterval> };
export type Room = { id: string; game: GameService; clients: Set<StreamClient>; connection: TwitchConnection | null; idleSince: number | null; cooldowns: Map<string, number>; broadcastTimer: ReturnType<typeof setTimeout> | null; storageError: boolean; rateWindow: number; messages: number; posting: boolean; chatError: string | null };
type RoomOptions = { clientId: string; clientSecret: string; aiKey: string; maxActive?: number; idleMs?: number; allowed: (id: string) => boolean; model?: string };

export class Rooms {
  readonly rooms = new Map<string, Room>();
  readonly communities: CommunityStore;
  private maintenance: ReturnType<typeof setInterval>;
  readonly database: AppDatabase;
  readonly options: RoomOptions;
  constructor(database: AppDatabase, options: RoomOptions) {
    this.database = database; this.options = options;
    this.communities = new CommunityStore(undefined, Math.random, undefined, database);
    this.maintenance = setInterval(() => this.sweep(), 5000);
    this.maintenance.unref();
  }

  get(id: string, account: Account | null = null): Room {
    const existing = this.rooms.get(id);
    if (existing) return existing;
    if (this.rooms.size >= (this.options.maxActive || 10)) throw new Error("The beta is at capacity. Try again when another channel pauses.");
    const game = new GameService({ communityStore: this.communities, communityId: id, communityName: account?.name || "Local demo" });
    const saved = this.database.loadSnapshot(id);
    if (saved) game.restore(saved);
    else game.pause();
    if (saved) this.database.saveSnapshot(id, game.checkpoint());
    const room: Room = { id, game, clients: new Set(), connection: null, idleSince: Date.now(), cooldowns: new Map(), broadcastTimer: null, storageError: false, rateWindow: Date.now(), messages: 0, posting: false, chatError: null };
    this.rooms.set(id, room);
    game.onChange = () => {
      this.persist(room);
      void this.postNotices(room);
      if (!room.broadcastTimer) room.broadcastTimer = setTimeout(() => { room.broadcastTimer = null; this.broadcast(room); }, 100);
    };
    if (this.options.aiKey) {
      const judge = new KrillionJudge(this.options.aiKey, this.options.model || "gpt-6-luna", { database: this.database, channelId: id, roundId: () => game.state.gameId });
      game.krillionJudge = (prompt, answers) => judge.judge(prompt, answers);
    }
    if (account?.credentials) room.connection = new TwitchConnection(account.credentials, {
      clientId: this.options.clientId, clientSecret: this.options.clientSecret,
      save: (credentials) => this.database.saveCredentials(id, credentials),
      onChat: (event) => { void this.chat(room, event).catch(() => console.error("[chat] Could not process a game message for", id)); },
      onStatus: () => { for (const client of room.clients) this.write(client, "connection", {}); void this.postNotices(room); },
      onRevoked: () => {
        this.database.clearCredentials(id); game.pause();
        for (const client of [...room.clients]) client.response.end();
        room.idleSince = 0;
      },
    });
    return room;
  }

  activate(room: Room): void { room.idleSince = null; if (!room.storageError) room.game.resume(); void room.connection?.start(); }
  state(room: Room, view: "control" | "public"): Record<string, unknown> {
    const state = view === "control" ? room.game.controlState() : room.game.publicState();
    if (view === "control") {
      state.krillionQuota = this.quota(room.id);
      state.storageWarning = room.storageError ? "Game progress could not be saved. Gameplay is paused; contact the operator." : null;
      state.chatAnnouncementWarning = room.chatError || (room.game.state.contextChatEnabled && room.connection && !room.connection.canPost ? "Reconnect Twitch once to allow game announcements in chat." : null);
    }
    return state;
  }
  quota(id: string): Record<string, unknown> {
    const quota = this.database.quota(id);
    const row = this.database.sql.prepare("SELECT value FROM meta WHERE key='judge-validation'").get() as any;
    const approved = row ? JSON.parse(row.value) : null;
    const validated = approved?.passed === true && approved.model === (this.options.model || "gpt-6-luna");
    return { ...quota, judgeReady: Boolean(this.options.aiKey) && validated, available: Boolean(this.options.aiKey) && validated && quota.available, reason: !this.options.aiKey ? "Krillion is unavailable until the operator enables AI judging." : !validated ? "The operator needs to validate AI judging before Krillion opens." : quota.reason };
  }
  requireQuota(id: string): void { const quota = this.quota(id); if (!quota.available) throw new Error(String(quota.reason)); }

  persist(room: Room): void {
    try { this.database.saveSnapshot(room.id, room.game.checkpoint()); room.storageError = false; }
    catch {
      room.storageError = true;
      // Fail closed on a durability failure, without recursively invoking onChange.
      if (room.game.pausedAt === null) room.game.pausedAt = Date.now();
      console.error("[storage] Could not checkpoint channel", room.id);
    }
  }

  private async postNotices(room: Room): Promise<void> {
    if (room.posting || !room.connection?.canPost || room.connection.status !== "Connected" || room.game.pausedAt !== null || !room.game.state.contextChatEnabled || room.storageError) return;
    room.posting = true;
    try {
      while (this.rooms.get(room.id) === room && room.game.pausedAt === null && room.game.state.contextChatEnabled) {
        const notice = room.game.state.contextNotices.find((entry) => {
          if (entry.claimed || Date.now() - entry.at > 20_000) return false;
          if (entry.id.endsWith(":result")) return true;
          if (!entry.id.startsWith(room.game.state.contextRoundId + ":")) return false;
          return entry.id.endsWith(":vote") ? !!room.game.state.contextVote && Date.now() < room.game.state.contextVote.endsAt : room.game.state.phase === "playing";
        });
        if (!notice) break;
        // Claim durably before sending. Unknown network outcomes are never
        // retried after a refresh/restart; game events must not flood chat.
        notice.claimed = true;
        this.persist(room);
        if (room.storageError) return;
        try { await room.connection.sendChat(notice.text); room.chatError = null; }
        catch (error) { room.chatError = error instanceof Error ? error.message : "Chat announcement could not be delivered."; }
      }
    } finally { room.posting = false; this.broadcast(room); }
  }

  private write(client: StreamClient, event: string, data: unknown): void {
    if (client.response.destroyed || client.response.writableEnded) return;
    // Drop slow clients rather than buffering an unbounded stream in memory.
    if (client.response.writableLength > 128 * 1024) { client.response.destroy(); return; }
    client.response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
  broadcast(room: Room): void {
    for (const client of room.clients) {
      const next = this.state(room, client.view);
      if (!client.last) this.write(client, "state", next);
      else {
        const patch = Object.fromEntries(Object.entries(next).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(client.last![key])));
        // JSON drops undefined. Explicit null clears old targets at the next round.
        if (client.last.target !== undefined && next.target === undefined) patch.target = null;
        if (Object.keys(patch).length) this.write(client, "patch", patch);
      }
      client.last = structuredClone(next);
    }
  }
  attach(room: Room, client: StreamClient): void {
    const count = [...room.clients].filter((entry) => entry.view === client.view).length;
    if (count >= (client.view === "control" ? 3 : 4)) throw new Error("This channel has reached its browser connection limit. Close an unused tab or OBS source.");
    room.clients.add(client);
    this.activate(room);
    this.broadcast(room);
    client.heartbeat = setInterval(() => {
      if (client.sessionId && !this.database.session(client.sessionId)) { client.response.end(); return; }
      if (!this.options.allowed(room.id)) { client.response.end(); return; }
      if (!client.response.destroyed) client.response.write(": keepalive\n\n");
    }, 20_000);
    client.response.on("close", () => {
      clearInterval(client.heartbeat);
      room.clients.delete(client);
      if (!room.clients.size) room.idleSince = Date.now();
    });
  }

  sweep(now = Date.now()): void {
    for (const room of [...this.rooms.values()]) {
      if (!this.options.allowed(room.id) || !room.clients.size && room.idleSince !== null && now - room.idleSince >= (this.options.idleMs ?? 300_000)) { this.release(room.id); continue; }
      this.persist(room);
      for (const [key, at] of room.cooldowns) if (now - at > 60_000) room.cooldowns.delete(key);
    }
  }
  release(id: string): void {
    const room = this.rooms.get(id);
    if (!room) return;
    // Stop pending game callbacks from recreating deleted state after an async judge returns.
    room.game.pause();
    this.persist(room);
    room.game.onChange = null;
    room.game.dispose();
    if (room.broadcastTimer) clearTimeout(room.broadcastTimer);
    room.connection?.dispose();
    for (const client of room.clients) { clearInterval(client.heartbeat); client.response.end(); }
    this.rooms.delete(id);
    this.communities.forget(id);
  }
  dispose(): void { clearInterval(this.maintenance); for (const id of [...this.rooms.keys()]) this.release(id); }

  async chat(room: Room, event: any): Promise<void> {
    if (event.broadcaster_user_id !== room.id || room.game.pausedAt !== null || room.storageError) return;
    const login = String(event.chatter_user_login || "").slice(0, 25), name = String(event.chatter_user_name || login).slice(0, 32);
    const text = String(event.message?.text || "").trim().slice(0, 500);
    if (event.chatter_user_id === room.id && text.startsWith("[Word Hunt]")) return;
    if (Date.now() - room.rateWindow >= 1000) { room.rateWindow = Date.now(); room.messages = 0; }
    if (++room.messages > 50 && !canControlChannelMessage(event)) return;
    if (!login || !text || Date.now() - (room.cooldowns.get(login) || 0) < 750) return;
    if (room.cooldowns.size >= 2000 && !room.cooldowns.has(login)) return;
    room.cooldowns.set(login, Date.now());
    const match = text.match(/^!(guess|join|answer|game|stop|vote)\b(?:\s+(.*))?$/i);
    const action = match?.[1]?.toLowerCase(), argument = match?.[2] || "";
    if (action === "vote" || (!match && room.game.state.contextVote && /^[123]$/.test(text))) room.game.voteForTheme(login, Number(match ? argument : text));
    else if ((!match && room.game.state.kind === "context") || action === "guess") await room.game.chatGuessAsync(login, name, match ? argument : text);
    else if (action === "join") room.game.join(login, name);
    else if (action === "answer") room.game.submitKrillionAnswer(login, name, argument);
    else if ((action === "game" || action === "stop") && canControlChannelMessage(event)) {
      const settings = this.database.getAccount(room.id)?.settings || {};
      const durations = settings.durations as Record<string, number> || {};
      if (action === "stop" || argument.toLowerCase() === "stop") room.game.stop();
      else if (["context", "hunt", "wordhunt", "word hunt"].includes(argument.toLowerCase())) room.game.startContext(undefined, durations.context || 60, settings);
      else if (argument.toLowerCase() === "marathon") room.game.startContext(undefined, durations.context || 180, { ...settings, huntMode: "marathon", themeVoting: settings.themeVoting !== false });
      else if (argument.toLowerCase() === "wordle") room.game.startWordle(durations.wordle || 45);
      else if (/^krillion(?:\s|$)/i.test(argument)) { this.requireQuota(room.id); room.game.startKrillion(durations.krillion || 30, argument.slice(8).trim() || undefined); }
    }
  }
}

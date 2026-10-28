import { contextWordPool, contextDifficultyPools, targetDifficulty, getWordRank, getWordSimilarity, isSupportedWord, lexicon, normalizeWord, wordleAnswers, wordleWords, semanticModel, contextPoolId, type ContextDifficulty } from "./embeddings.ts";
import { randomUUID } from "node:crypto";
import { CommunityStore, addAward, type ContributionAward, type ContributorScore } from "./community-store.ts";

export type GameKind = "idle" | "context" | "wordle" | "krillion";
export type GuessEntry = { word: string; by: string; login?: string; rank: number; similarity?: number; at: number; improvement?: number; newBest?: boolean };
type ContextOptions = { difficulty?: ContextDifficulty; clutchEnabled?: boolean };
export type WordleAttempt = { word: string; colors: Array<"correct" | "present" | "absent">; at: number };
export type WordlePlayer = { login: string; displayName: string; joinedAt: number; alive: boolean; solved: boolean; attempts: WordleAttempt[] };
export type KrillionEntry = {
  login: string; displayName: string; answer: string; at: number;
  relevance: number | null; novelty: number | null; score: number | null; reason: string | null;
};
type KrillionJudgement = { id: string; relevance: number; novelty: number; reason: string };
export type GameState = {
  gameId: string;
  kind: GameKind;
  phase: "idle" | "playing" | "judging" | "round-complete" | "finished";
  round: number;
  startedAt: number | null;
  endsAt: number | null;
  durationSeconds: number;
  target: string | null;
  winner: string | null;
  message: string;
  contextGuesses: GuessEntry[];
  players: Record<string, WordlePlayer>;
  krillionPrompt: string | null;
  krillionAnswers: KrillionEntry[];
  krillionJudged: boolean;
  contextStreak: number;
  contextLevel: number;
  contextLevelProgress: number;
  contextRoundId: string | null;
  contextModelId: string;
  contextPoolId: string;
  contextDifficulty: ContextDifficulty;
  contextNextDifficulty: ContextDifficulty;
  contextClutchEnabled: boolean;
  contextClutchSeconds: number;
  contextClutchUsers: string[];
  contextClutchEvent: { by: string; seconds: number; at: number } | null;
  contextAwards: ContributionAward[];
  contextSessionScores: ContributorScore[];
};

const clampDuration = (seconds: number) => ([30, 45, 60].includes(seconds) ? seconds : 45);
const clampContextDuration = (seconds: number) => ([30, 45, 60, 120, 180, 300].includes(seconds) ? seconds : 60);
const CONTEXT_REVEAL_MS = 8_000;
const cleanLogin = (value: string) => value.trim().toLocaleLowerCase("en-US").replace(/[^a-z0-9_]/g, "");
const choose = <T,>(items: T[]): T => items[Math.floor(Math.random() * items.length)]!;
const krillionPrompts = [
  "Name something you might pack for a beach trip.",
  "Name a tool people use to fix a bicycle.",
  "What is something people often do before going to sleep?",
  "Name something you might find in a kitchen.",
  "Name an animal that lives in a forest.",
  "What is something useful to bring on a camping trip?",
  "Name a food that is usually eaten for breakfast.",
  "What is something you might see in a city park?",
];

function freshState(): GameState {
  return {
    gameId: randomUUID(), kind: "idle", phase: "idle", round: 0, startedAt: null, endsAt: null, durationSeconds: 45,
    target: null, winner: null, message: "Pick a game to bring chat together.", contextGuesses: [], players: {},
    krillionPrompt: null, krillionAnswers: [], krillionJudged: false,
    contextStreak: 0, contextLevel: 1, contextLevelProgress: 0,
    contextRoundId: null, contextModelId: semanticModel.id, contextPoolId, contextDifficulty: "easy", contextNextDifficulty: "easy",
    contextClutchEnabled: true, contextClutchSeconds: 0, contextClutchUsers: [], contextClutchEvent: null,
    contextAwards: [], contextSessionScores: [],
  };
}

function wordleFeedback(guess: string, target: string): WordleAttempt["colors"] {
  const result: WordleAttempt["colors"] = Array(5).fill("absent");
  const remaining = target.split("");
  for (let i = 0; i < 5; i += 1) {
    if (guess[i] === target[i]) {
      result[i] = "correct";
      remaining[i] = "";
    }
  }
  for (let i = 0; i < 5; i += 1) {
    if (result[i] === "correct") continue;
    const found = remaining.indexOf(guess[i]!);
    if (found >= 0) {
      result[i] = "present";
      remaining[found] = "";
    }
  }
  return result;
}

export class GameService {
  state: GameState = freshState();
  onChange: (() => void) | null = null;
  semanticSimilarity: ((target: string, guess: string) => Promise<number>) | null = null;
  krillionJudge: ((prompt: string, answers: Array<{ id: string; answer: string }>) => Promise<KrillionJudgement[]>) | null = null;
  private tick: ReturnType<typeof setInterval>;
  private pendingContextGuesses = new Set<string>();
  private readonly communityStore: CommunityStore;
  private communityId: string;
  pausedAt: number | null = null;

  pause(now = Date.now()): void { if (this.pausedAt === null) { this.pausedAt = now; this.emit(); } }
  resume(now = Date.now()): void {
    if (this.pausedAt === null) return;
    const delta = now - this.pausedAt;
    if (this.state.startedAt !== null) this.state.startedAt += delta;
    if (this.state.endsAt !== null) this.state.endsAt += delta;
    this.pausedAt = null;
    this.emit();
  }
  checkpoint(): Record<string, unknown> { return { state: this.state, pausedAt: this.pausedAt, savedAt: Date.now() }; }
  restore(saved: any): void {
    if (!saved?.state || !["idle", "context", "wordle", "krillion"].includes(saved.state.kind)) throw new Error("Invalid saved game.");
    this.state = { ...freshState(), ...saved.state };
    this.pausedAt = saved.pausedAt ?? saved.savedAt;
    const modelChanged = saved.state.contextModelId !== semanticModel.id;
    const answerRemoved = this.state.kind === "context" && this.state.phase === "playing"
      && !contextDifficultyPools[this.state.contextDifficulty]?.includes(this.state.target!);
    if (this.state.kind === "context" && (modelChanged || answerRemoved)) {
      // Stored ranks from another vocabulary/model cannot be mixed with new
      // scores. Preserve earned records, streak and session points; redraw
      // without recording a loss, and wait for a browser/source to reconnect.
      this.startNextContextRound();
      this.state.message = modelChanged
        ? "Word associations were upgraded. A fresh word is ready; your earned points and streak are kept."
        : "The answer pool was reviewed. A fresh word is ready; your earned points and streak are kept.";
      this.pausedAt = Date.now();
    }
    this.state.contextPoolId = contextPoolId;
    if (this.state.phase === "judging") {
      this.state.phase = "round-complete";
      this.state.message = "Judging was interrupted. The request may have been billed; it will not be repeated automatically.";
    }
  }
  dispose(): void { clearInterval(this.tick); this.onChange = null; this.pendingContextGuesses.clear(); }

  constructor(options: { communityStore?: CommunityStore; communityId?: string; communityName?: string } = {}) {
    this.communityStore = options.communityStore || new CommunityStore();
    this.communityId = options.communityId || "local-demo";
    if (options.communityName) this.communityStore.setName(this.communityId, options.communityName);
    this.tick = setInterval(() => {
      try { this.advanceIfDue(); }
      catch {
        this.pausedAt = Date.now();
        this.state.message = "Game storage is unavailable. Gameplay is paused; contact the operator.";
        this.emit();
      }
    }, 250);
    this.tick.unref?.();
  }

  setCommunity(id: string, name: string): void {
    this.communityStore.setName(id, name);
    if (this.communityId === id) return;
    this.communityId = id;
    this.state = freshState();
    this.emit();
  }

  startContext(secret?: string, durationSeconds = 60, options: ContextOptions = {}): void {
    this.pausedAt = null;
    const difficulty = options.difficulty || "easy";
    if (!["easy", "normal", "hard"].includes(difficulty)) throw new Error("Choose Easy, Standard, or Expert difficulty.");
    const manualWord = secret ? normalizeWord(secret) : undefined;
    if (manualWord && (!isSupportedWord(manualWord) || !contextWordPool.includes(manualWord))) throw new Error("Choose a supported concrete noun for the secret word.");
    const actualDifficulty = manualWord ? targetDifficulty(manualWord) : difficulty;
    const target = this.communityStore.drawTarget(this.communityId, actualDifficulty, contextDifficultyPools[actualDifficulty], manualWord);
    const duration = clampContextDuration(durationSeconds);
    this.state = {
      ...freshState(), kind: "context", phase: "playing", round: 1, startedAt: Date.now(), target,
      durationSeconds: duration, endsAt: Date.now() + duration * 1000,
      contextRoundId: randomUUID(), contextDifficulty: actualDifficulty, contextNextDifficulty: difficulty,
      contextClutchEnabled: options.clutchEnabled !== false,
      message: `Round 1: guess the word within ${duration} seconds.`,
    };
    this.emit();
  }

  startWordle(durationSeconds = 45, secret?: string): void {
    this.pausedAt = null;
    const target = normalizeWord(secret || choose(wordleAnswers));
    if (!wordleAnswers.includes(target)) throw new Error("Choose a five-letter answer from the game list.");
    this.state = {
      ...freshState(), kind: "wordle", phase: "playing", round: 1, startedAt: Date.now(), target,
      durationSeconds: clampDuration(durationSeconds), endsAt: Date.now() + clampDuration(durationSeconds) * 1000,
      message: "Join the race, solve the word, and survive the round.",
    };
    this.emit();
  }

  startKrillion(durationSeconds = 30, promptInput?: string): void {
    this.pausedAt = null;
    const prompt = (promptInput || choose(krillionPrompts)).trim().replace(/\s+/g, " ");
    if (prompt.length < 8 || prompt.length > 180) throw new Error("Krillion prompts must be 8 to 180 characters.");
    const duration = [30, 45, 60].includes(durationSeconds) ? durationSeconds : 30;
    this.state = {
      ...freshState(), kind: "krillion", phase: "playing", round: 1, startedAt: Date.now(),
      endsAt: Date.now() + duration * 1000, durationSeconds: duration, krillionPrompt: prompt,
      message: "Send one answer with !answer. Your answer is locked in once submitted.",
    };
    this.emit();
  }

  submitKrillionAnswer(loginInput: string, displayNameInput: string | undefined, answerInput: string): string {
    if (this.pausedAt !== null) return "This game is paused.";
    if (this.state.endsAt && Date.now() >= this.state.endsAt) { this.advanceIfDue(); return "Time is up."; }
    if (this.state.kind !== "krillion" || this.state.phase !== "playing") return "Krillion is not collecting answers right now.";
    const login = cleanLogin(loginInput);
    const displayName = displayNameInput?.trim() || login;
    const answer = answerInput.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
    if (!login) return "Twitch username could not be read.";
    if (!answer || answer.length > 100) return "Send one answer up to 100 characters with !answer.";
    if (this.state.krillionAnswers.some((entry) => entry.login === login)) return "You already locked in an answer this round.";
    if (this.state.krillionAnswers.length >= 100) return "This round has reached its answer limit.";
    this.state.krillionAnswers.push({ login, displayName, answer, at: Date.now(), relevance: null, novelty: null, score: null, reason: null });
    this.state.message = `${displayName} locked in an answer. ${this.state.krillionAnswers.length} response${this.state.krillionAnswers.length === 1 ? "" : "s"} so far.`;
    this.emit();
    return this.state.message;
  }

  retryKrillionJudging(): void {
    if (this.state.kind !== "krillion" || this.state.phase !== "round-complete" || this.state.krillionJudged) return;
    const round = this.state;
    round.phase = "judging";
    round.message = "AI is judging the answers…";
    this.emit();
    void this.resolveKrillionRound(round);
  }

  stop(): void {
    this.state = { ...freshState(), message: "The game has been paused." };
    this.emit();
  }

  updateDuration(durationSeconds: number, options: ContextOptions = {}): void {
    const state = this.state;
    if (state.kind === "idle" || !(state.phase === "playing" || state.kind === "context" && state.phase === "finished")) {
      throw new Error("Start a game before changing its timer.");
    }
    const choices = state.kind === "context" ? [30, 45, 60, 120, 180, 300] : [30, 45, 60];
    if (!choices.includes(durationSeconds)) throw new Error("Choose one of the available round durations.");
    if (options.difficulty && !["easy", "normal", "hard"].includes(options.difficulty)) throw new Error("Choose Easy, Standard, or Expert difficulty.");
    state.durationSeconds = durationSeconds;
    if (state.kind === "context") {
      if (options.difficulty) state.contextNextDifficulty = options.difficulty;
      if (typeof options.clutchEnabled === "boolean") state.contextClutchEnabled = options.clutchEnabled;
    }
    if (state.phase === "playing" && state.startedAt) state.endsAt = state.startedAt + durationSeconds * 1000 + (state.kind === "context" ? state.contextClutchSeconds * 1000 : 0);
    this.emit();
    this.advanceIfDue();
  }

  join(loginInput: string, displayNameInput?: string): string {
    if (this.pausedAt !== null) return "This game is paused.";
    if (this.state.kind !== "wordle" || this.state.phase !== "playing") return "There is no Wordle race to join right now.";
    const login = cleanLogin(loginInput);
    if (!login) return "Twitch username could not be read.";
    if (Object.hasOwn(this.state.players, login)) return `${displayNameInput || login} is already in the race.`;
    if (Object.keys(this.state.players).length >= 100) return "This race has reached its 100-player limit.";
    Object.defineProperty(this.state.players, login, { value: {
      login, displayName: displayNameInput?.trim() || login, joinedAt: Date.now(), alive: true, solved: false, attempts: [],
    }, writable: true, enumerable: true, configurable: true });
    this.state.message = `${displayNameInput || login} joined the race.`;
    this.emit();
    return this.state.message;
  }

  chatGuess(loginInput: string, displayNameInput: string | undefined, wordInput: string): string {
    if (this.pausedAt !== null) return "This game is paused.";
    if (this.state.phase !== "playing") return "No game is taking guesses right now.";
    if (this.state.kind !== "context" && this.state.endsAt && Date.now() >= this.state.endsAt) {
      this.advanceIfDue(); return "Time is up. Wait for the next round.";
    }
    if (this.state.kind === "context" && this.state.endsAt && Date.now() >= this.state.endsAt) {
      this.completeContextRound(null);
      return "Time is up. The next word is coming shortly.";
    }
    const login = cleanLogin(loginInput);
    const displayName = displayNameInput?.trim() || login;
    const word = normalizeWord(wordInput);
    const wordCount = wordInput.trim().split(/\s+/).length;
    if (!login || !word || (this.state.kind === "context" ? wordCount > 3 : wordCount !== 1)) return "Send a single word or a common compound.";

    if (this.state.kind === "context") {
      if (!isSupportedWord(word)) return "That word is outside the demo vocabulary.";
      if (this.state.contextGuesses.some((entry) => entry.word === word)) return `“${word}” is already on the board.`;
      const rank = getWordRank(this.state.target!, word);
      if (rank === null) return "That word is outside the demo vocabulary.";
      return this.acceptContextGuess(login, displayName, word, rank, getWordSimilarity(this.state.target!, word) ?? 0);
    }

    if (this.state.kind === "wordle") {
      let player = Object.hasOwn(this.state.players, login) ? this.state.players[login] : undefined;
      if (!player) {
        this.join(login, displayName);
        player = this.state.players[login];
      }
      if (!player || !player.alive) return "You have been eliminated from this race.";
      if (player.solved) return "You already solved this round. Wait for the next word.";
      if (word.length !== 5 || !wordleWords.includes(word)) return "That guess is not in the demo Wordle list.";
      const attempt = { word, colors: wordleFeedback(word, this.state.target!), at: Date.now() };
      player.attempts.push(attempt);
      if (word === this.state.target) player.solved = true;
      else if (player.attempts.length >= 6) player.alive = false;
      const remaining = this.activePlayers();
      if (remaining.length === 1) this.finishWordle(remaining[0]!.displayName);
      else if (remaining.length === 0) this.finishWordle(null);
      else if (remaining.every((entry) => entry.solved)) this.advanceWordleRound();
      else this.state.message = word === this.state.target ? `${displayName} solved round ${this.state.round}!` : `${displayName} made a guess.`;
      this.emit();
      return this.state.message;
    }
    return "No game is taking guesses right now.";
  }

  async chatGuessAsync(loginInput: string, displayNameInput: string | undefined, wordInput: string): Promise<string> {
    if (this.state.kind !== "context") return this.chatGuess(loginInput, displayNameInput, wordInput);
    if (!this.semanticSimilarity) {
      const before = this.state.contextGuesses.length;
      const result = this.chatGuess(loginInput, displayNameInput, wordInput);
      if (this.state.phase === "playing" && this.state.contextGuesses.length === before) {
        return result;
      }
      return result;
    }
    if (this.state.phase !== "playing") return "No game is taking guesses right now.";
    if (this.state.endsAt && Date.now() >= this.state.endsAt) {
      this.completeContextRound(null);
      return "Time is up. The next word is coming shortly.";
    }
    const login = cleanLogin(loginInput);
    const displayName = displayNameInput?.trim() || login;
    const word = wordInput.trim().toLocaleLowerCase("en-US").replace(/[^a-z '-]/g, "").replace(/\s+/g, " ").trim();
    if (!login || !word || word.length > 48 || !/^[a-z]+(?:[ '-][a-z]+)*$/.test(word)) return "Send a word or short phrase.";
    const target = this.state.target!;
    const roundId = this.state.contextRoundId;
    const pendingKey = roundId + ":" + word;
    if (this.state.contextGuesses.some((entry) => entry.word === word) || this.pendingContextGuesses.has(pendingKey)) return `“${word}” is already on the board.`;
    if (word === target) return this.acceptContextGuess(login, displayName, word, 1, 1);
    this.pendingContextGuesses.add(pendingKey);
    try {
      const similarity = await this.semanticSimilarity(target, word);
      // A round may have ended or changed while the API request was in flight.
      if (this.state.kind !== "context" || this.state.phase !== "playing" || this.state.contextRoundId !== roundId) return "That round has ended.";
      if (this.state.endsAt && Date.now() >= this.state.endsAt) {
        this.completeContextRound(null);
        return "Time is up. The next word is coming shortly.";
      }
      const rank = Math.max(1, Math.round((1 - similarity) * 500));
      return this.acceptContextGuess(login, displayName, word, rank, similarity);
    } catch (error) {
      if (this.state.contextRoundId !== roundId || this.state.phase !== "playing") return "That round has ended.";
      this.state.message = error instanceof Error ? error.message : "Semantic AI could not score that guess.";
      this.emit();
      return this.state.message;
    } finally {
      this.pendingContextGuesses.delete(pendingKey);
    }
  }

  advanceIfDue(): void {
    if (this.pausedAt !== null) return;
    if (this.state.kind === "context") {
      if (!this.state.endsAt || Date.now() < this.state.endsAt) return;
      if (this.state.phase === "playing") this.completeContextRound(null);
      else if (this.state.phase === "finished") this.startNextContextRound();
      return;
    }
    if (this.state.phase !== "playing" || !this.state.endsAt || Date.now() < this.state.endsAt) return;
    if (this.state.kind === "krillion") {
      const round = this.state;
      round.endsAt = null;
      if (!round.krillionAnswers.length) {
        round.phase = "round-complete";
        round.krillionJudged = true;
        round.message = "Time is up. No answers came in this round.";
        this.emit();
      } else {
        round.phase = "judging";
        round.message = `Time is up. Judging ${round.krillionAnswers.length} answer${round.krillionAnswers.length === 1 ? "" : "s"}…`;
        this.emit();
        void this.resolveKrillionRound(round);
      }
      return;
    }
    if (this.state.kind !== "wordle") return;
    for (const player of Object.values(this.state.players)) {
      if (player.alive && !player.solved) player.alive = false;
    }
    const survivors = this.activePlayers();
    if (survivors.length === 1) this.finishWordle(survivors[0]!.displayName);
    else if (survivors.length === 0) this.finishWordle(null);
    else this.advanceWordleRound();
  }

  publicState(): Record<string, unknown> {
    const { target, krillionAnswers, contextClutchUsers, ...publicState } = this.state;
    const players = Object.values(this.state.players).map((player) => ({
      login: player.login, displayName: player.displayName, alive: player.alive, solved: player.solved,
      attempts: player.attempts,
    })).sort((a, b) => Number(b.alive) - Number(a.alive) || a.displayName.localeCompare(b.displayName));
    return {
      ...publicState,
      paused: this.pausedAt !== null, pausedAt: this.pausedAt,
      contextGuessCount: this.state.contextGuesses.length,
      contextPlayerCount: new Set(this.state.contextGuesses.map((guess) => guess.login)).size,
      contextGuesses: this.state.contextGuesses.slice(0, 20),
      krillionAnswers: this.state.kind === "krillion" && this.state.phase === "round-complete" ? krillionAnswers : [],
      krillionAnswerCount: this.state.kind === "krillion" ? krillionAnswers.length : 0,
      target: this.state.phase === "finished" ? target : undefined, players,
      semanticMode: this.semanticSimilarity ? "ai" : "local", semanticModel: this.semanticSimilarity ? null : semanticModel, supportedWords: lexicon.length,
      community: this.communityStore.summary(this.communityId),
      contextSessionScores: [...this.state.contextSessionScores].sort((a, b) => b.points - a.points || b.solves - a.solves || a.login.localeCompare(b.login)).slice(0, 5),
    };
  }

  controlState(): Record<string, unknown> {
    return { ...this.publicState(), privateTarget: this.state.target,
      bagRemaining: this.communityStore.remaining(this.communityId, this.state.contextNextDifficulty),
      targetCounts: Object.fromEntries(Object.entries(contextDifficultyPools).map(([difficulty, words]) => [difficulty, words.length])),
      storageWarning: this.communityStore.persistenceError };
  }

  private activePlayers(): WordlePlayer[] {
    return Object.values(this.state.players).filter((player) => player.alive);
  }

  private finishWordle(winner: string | null): void {
    this.state.phase = "finished";
    this.state.winner = winner;
    this.state.endsAt = null;
    this.state.message = winner ? `${winner} wins the Wordle race! The word was ${this.state.target}.` : `The race is over. Nobody survived. The word was ${this.state.target}.`;
    this.emit();
  }

  private acceptContextGuess(login: string, displayName: string, word: string, rank: number, similarity: number): string {
    if (!Number.isFinite(similarity)) throw new Error("That guess did not receive a valid similarity score.");
    const state = this.state;
    const scores = state.contextGuesses.map((entry) => entry.similarity).filter((value): value is number => Number.isFinite(value));
    const previousBest = scores.length ? Math.max(...scores) : null;
    const exact = word === state.target;
    const gain = previousBest === null ? 0 : Math.max(0, similarity - previousBest);
    const entry: GuessEntry = { word, by: displayName, login, rank, similarity, at: Date.now(), improvement: gain,
      newBest: !exact && previousBest !== null && gain >= .01 - 1e-9 };
    state.contextGuesses.push(entry);
    state.contextGuesses.sort((a, b) => this.semanticSimilarity
      ? (b.similarity ?? -1) - (a.similarity ?? -1) || a.at - b.at
      : a.rank - b.rank || a.at - b.at);
    if (exact) this.completeContextRound(entry);
    else {
      state.message = this.semanticSimilarity ? `${displayName} guessed “${word}” — similarity ${Math.round(similarity * 100)}%.` : `${displayName} guessed “${word}” — rank #${rank}.`;
      const remaining = (state.endsAt || 0) - Date.now();
      if (state.contextClutchEnabled && previousBest !== null && gain >= .05 - 1e-9 && remaining > 0 && remaining <= 10_000 && state.contextClutchSeconds < 15 && !state.contextClutchUsers.includes(login)) {
        state.contextClutchSeconds += 5;
        state.contextClutchUsers.push(login);
        state.endsAt! += 5_000;
        state.contextClutchEvent = { by: displayName, seconds: 5, at: Date.now() };
        state.message = `Clutch! ${displayName} gained ${Math.round(gain * 100)} similarity points and earned chat 5 more seconds.`;
      }
      this.emit();
    }
    return state.message;
  }

  private contributionAwards(winner: GuessEntry | null): ContributionAward[] {
    const awards: ContributionAward[] = [];
    if (winner?.login) awards.push({ kind: "solver", login: winner.login, displayName: winner.by, points: 100, value: 1 });
    const improvements = this.state.contextGuesses.filter((entry) => entry.newBest && entry.login);
    const leap = [...improvements].sort((a, b) => (b.improvement || 0) - (a.improvement || 0) || a.at - b.at)[0];
    if (leap?.login) awards.push({ kind: "biggestLeap", login: leap.login, displayName: leap.by, points: 50, value: Math.round((leap.improvement || 0) * 1_000) / 10 });
    const helpful = new Map<string, { entry: GuessEntry; count: number; gain: number }>();
    for (const entry of improvements) {
      const score = helpful.get(entry.login!) || { entry, count: 0, gain: 0 };
      score.count += 1;
      score.gain += entry.improvement || 0;
      helpful.set(entry.login!, score);
    }
    const pathfinder = [...helpful.values()].sort((a, b) => b.count - a.count || b.gain - a.gain || a.entry.at - b.entry.at)[0];
    if (pathfinder?.entry.login) awards.push({ kind: "pathfinder", login: pathfinder.entry.login, displayName: pathfinder.entry.by, points: 30, value: pathfinder.count });
    return awards;
  }

  private completeContextRound(winner: GuessEntry | null): void {
    const state = this.state;
    if (state.kind !== "context" || state.phase !== "playing") return;
    state.phase = "finished";
    state.winner = winner?.by || null;
    state.endsAt = Date.now() + CONTEXT_REVEAL_MS;
    if (winner) {
      state.contextStreak += 1;
      state.contextLevel = Math.floor(state.contextStreak / 3) + 1;
      state.contextLevelProgress = state.contextStreak % 3;
      state.message = `${winner.by} found “${state.target}”! Chat streak: ${state.contextStreak} · level ${state.contextLevel}. Next word in ${CONTEXT_REVEAL_MS / 1000} seconds.`;
    } else {
      const endedStreak = state.contextStreak;
      state.contextStreak = 0;
      state.contextLevel = 1;
      state.contextLevelProgress = 0;
      state.message = `Time is up! The word was “${state.target}”.${endedStreak ? ` The ${endedStreak}-round streak ends here.` : ""} Next word in ${CONTEXT_REVEAL_MS / 1000} seconds.`;
    }
    state.contextAwards = this.contributionAwards(winner);
    const participants = [...new Map(state.contextGuesses.filter((entry) => entry.login).map((entry) => [entry.login!, { login: entry.login!, displayName: entry.by }])).values()];
    for (const participant of participants) {
      let score = state.contextSessionScores.find((entry) => entry.login === participant.login);
      if (!score) {
        score = { ...participant, points: 0, solves: 0, biggestLeaps: 0, pathfinders: 0, rounds: 0 };
        state.contextSessionScores.push(score);
      }
      score.rounds += 1;
    }
    for (const award of state.contextAwards) addAward(state.contextSessionScores, award);
    this.communityStore.recordRound(this.communityId, {
      id: state.contextRoundId!, word: state.target!, difficulty: state.contextDifficulty, won: Boolean(winner), streak: state.contextStreak,
      solvedMs: winner ? Math.max(0, winner.at - state.startedAt!) : null, completedAt: Date.now(), awards: state.contextAwards, participants,
    }, this.checkpoint());
    this.emit();
  }

  private startNextContextRound(): void {
    if (this.state.kind !== "context") return;
    const difficulty = this.state.contextNextDifficulty;
    this.state.round += 1;
    this.state.target = this.communityStore.drawTarget(this.communityId, difficulty, contextDifficultyPools[difficulty]);
    this.state.contextDifficulty = difficulty;
    this.state.contextRoundId = randomUUID();
    this.state.contextModelId = semanticModel.id;
    this.state.contextPoolId = contextPoolId;
    this.state.phase = "playing";
    this.state.winner = null;
    this.state.contextGuesses = [];
    this.state.contextAwards = [];
    this.state.contextClutchSeconds = 0;
    this.state.contextClutchUsers = [];
    this.state.contextClutchEvent = null;
    this.state.startedAt = Date.now();
    this.state.endsAt = Date.now() + this.state.durationSeconds * 1000;
    this.state.message = `Round ${this.state.round}: ${this.state.durationSeconds} seconds. Chat level ${this.state.contextLevel} · ${this.state.contextLevelProgress}/3 wins to level up.`;
    this.emit();
  }

  private async resolveKrillionRound(round: GameState): Promise<void> {
    try {
      if (!this.krillionJudge) throw new Error("AI judging is not configured. Add OPENAI_API_KEY and restart the server.");
      const judgements = await this.krillionJudge(round.krillionPrompt!, round.krillionAnswers.map((entry, index) => ({ id: String(index), answer: entry.answer })));
      if (this.state !== round) return;
      const byId = new Map(judgements.map((entry) => [entry.id, entry]));
      const duplicates = new Map<string, number>();
      for (const entry of round.krillionAnswers) {
        const key = entry.answer.toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/g, " ").trim();
        duplicates.set(key, (duplicates.get(key) || 0) + 1);
      }
      round.krillionAnswers.forEach((entry, index) => {
        const result = byId.get(String(index));
        const relevance = Math.max(0, Math.min(100, Math.round(result?.relevance ?? 0)));
        const exactDuplicate = (duplicates.get(entry.answer.toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/g, " ").trim()) || 0) > 1;
        const novelty = exactDuplicate ? 0 : Math.max(0, Math.min(100, Math.round(result?.novelty ?? 0)));
        entry.relevance = relevance;
        entry.novelty = novelty;
        entry.score = relevance < 50 ? 0 : Math.round(relevance * 0.7 + novelty * 0.3);
        entry.reason = result?.reason?.slice(0, 140) || (relevance < 50 ? "Off topic" : "On topic");
      });
      round.krillionAnswers.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || (b.relevance ?? 0) - (a.relevance ?? 0) || a.at - b.at);
      round.phase = "round-complete";
      round.krillionJudged = true;
      const winner = round.krillionAnswers[0];
      round.message = winner ? `${winner.displayName} wins with “${winner.answer}” (${winner.score} points)!` : "Judging complete.";
      this.emit();
    } catch (error) {
      if (this.state !== round) return;
      round.phase = "round-complete";
      round.krillionJudged = false;
      round.message = error instanceof Error ? `${error.message} Answers are saved; retry judging after fixing it.` : "AI judging failed. Answers are saved; retry from controls.";
      this.emit();
    }
  }

  private advanceWordleRound(): void {
    this.state.round += 1;
    this.state.target = choose(wordleAnswers.filter((word) => word !== this.state.target));
    for (const player of this.activePlayers()) {
      player.solved = false;
      player.attempts = [];
    }
    this.state.startedAt = Date.now();
    this.state.endsAt = Date.now() + this.state.durationSeconds * 1000;
    this.state.message = `Round ${this.state.round}: survivors get a fresh word.`;
    this.emit();
  }

  private emit(): void { this.onChange?.(); }
}

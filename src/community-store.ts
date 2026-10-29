import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { ContextDifficulty } from "./embeddings.ts";
import type { AppDatabase } from "./database.ts";

export type ContributionAward = {
  kind: "solver" | "biggestLeap" | "pathfinder";
  login: string;
  displayName: string;
  points: number;
  value: number;
};
export type ContributorScore = { login: string; displayName: string; points: number; solves: number; biggestLeaps: number; pathfinders: number; rounds: number };
export type HuntRoundResult = {
  id: string; word: string; difficulty: ContextDifficulty; won: boolean; streak: number;
  solvedMs: number | null; completedAt: number; awards: ContributionAward[];
  participants: Array<{ login: string; displayName: string }>;
  closestGuesses?: Array<{ word: string; by: string; rank: number; similarity?: number }>;
  guessCount?: number; mode?: "rounds" | "marathon"; theme?: string; marathonSolves?: number;
};
type FastestSolve = { ms: number; by: string; word: string; difficulty: ContextDifficulty };
export type CommunityRecords = { rounds: number; wins: number; bestStreak: number; fastestSolve: FastestSolve | null; bestMarathonWords?: number };
type WordBag = { signature: string; remaining: string[]; lastWord: string | null; cycle: number };
type CommunityData = {
  version: 1; id: string; name: string; records: CommunityRecords;
  players: Record<string, ContributorScore>; bags: Partial<Record<ContextDifficulty, WordBag>>;
  recentRounds: HuntRoundResult[];
};
export type CommunitySummary = CommunityRecords & { id: string; name: string; contributors: number; leaderboard: ContributorScore[] };

export function addAward(scores: ContributorScore[], award: ContributionAward): void {
  let score = scores.find((entry) => entry.login === award.login);
  if (!score) {
    score = { login: award.login, displayName: award.displayName, points: 0, solves: 0, biggestLeaps: 0, pathfinders: 0, rounds: 0 };
    scores.push(score);
  }
  score.displayName = award.displayName;
  score.points += award.points;
  if (award.kind === "solver") score.solves += 1;
  if (award.kind === "biggestLeap") score.biggestLeaps += 1;
  if (award.kind === "pathfinder") score.pathfinders += 1;
  scores.sort((a, b) => b.points - a.points || b.solves - a.solves || a.login.localeCompare(b.login));
}

/** One local server owns these atomic JSON files; no cross-process writers. */
export class CommunityStore {
  private readonly cache = new Map<string, CommunityData>();
  private readonly directory?: string;
  private readonly random: () => number;
  private readonly database?: AppDatabase;
  readonly onError?: (error: unknown) => void;
  persistenceError: string | null = null;

  constructor(directory?: string, random: () => number = Math.random, onError?: (error: unknown) => void, database?: AppDatabase) {
    this.directory = directory;
    this.random = random;
    this.onError = onError;
    this.database = database;
    if (directory) mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  private path(id: string): string {
    const filename = /^[a-zA-Z0-9_-]{1,80}$/.test(id) ? id : createHash("sha256").update(id).digest("hex");
    return join(this.directory!, filename + ".json");
  }

  private data(id: string): CommunityData {
    const cached = this.cache.get(id);
    if (cached) return cached;
    let data: CommunityData = {
      version: 1, id, name: id === "local-demo" ? "Local demo" : "Your community",
      records: { rounds: 0, wins: 0, bestStreak: 0, fastestSolve: null },
      players: {}, bags: {}, recentRounds: [],
    };
    if (this.database) data = this.database.loadCommunity(id) || data;
    if (this.directory && existsSync(this.path(id))) {
      const saved = JSON.parse(readFileSync(this.path(id), "utf8"));
      if (saved.version !== 1 || saved.id !== id || !saved.records || !saved.players || !saved.bags || !Array.isArray(saved.recentRounds)) {
        throw new Error("Community records could not be read. Preserve the file before resetting it: " + this.path(id));
      }
      data = saved;
    }
    this.cache.set(id, data);
    return data;
  }

  private save(data: CommunityData): void {
    if (this.database) { this.database.saveCommunity(data.id, data); return; }
    if (!this.directory) return;
    try {
      const path = this.path(data.id);
      writeFileSync(path + ".tmp", JSON.stringify(data), { mode: 0o600 });
      chmodSync(path + ".tmp", 0o600);
      renameSync(path + ".tmp", path);
      this.persistenceError = null;
    } catch (error) {
      this.persistenceError = "Community records could not be saved to disk.";
      this.onError?.(error);
    }
  }

  setName(id: string, name: string): void {
    const data = this.data(id);
    if (data.name !== name) { data.name = name; this.save(data); }
  }

  summary(id: string): CommunitySummary {
    const data = this.data(id);
    return structuredClone({ ...data.records, id, name: data.name, contributors: Object.keys(data.players).length,
      leaderboard: Object.values(data.players).sort((a, b) => b.points - a.points || b.solves - a.solves || a.login.localeCompare(b.login)).slice(0, 5) });
  }

  availableTargets(id: string, difficulty: ContextDifficulty, words: string[]): string[] {
    const bag = this.data(id).bags[difficulty];
    const signature = createHash("sha256").update(words.join("\n")).digest("hex");
    return bag?.signature === signature && bag.remaining.length ? [...bag.remaining] : [...words];
  }

  history(id: string, offset = 0, limit = 20): { rounds: HuntRoundResult[]; total: number; hasMore: boolean } {
    const rounds = [...this.data(id).recentRounds].reverse();
    offset = Math.max(0, Math.min(200, Math.floor(offset) || 0));
    limit = Math.max(1, Math.min(20, Math.floor(limit) || 20));
    return { rounds: structuredClone(rounds.slice(offset, offset + limit)), total: rounds.length, hasMore: offset + limit < rounds.length };
  }

  drawTarget(id: string, difficulty: ContextDifficulty, words: string[], manualWord?: string, eligible?: string[]): string {
    if (!words.length) throw new Error("This difficulty has no target words installed.");
    if (manualWord && !words.includes(manualWord)) throw new Error("That word is not in the target list.");
    const data = this.data(id);
    const signature = createHash("sha256").update(words.join("\n")).digest("hex");
    let bag = data.bags[difficulty];
    if (!bag || bag.signature !== signature || !bag.remaining.length) {
      const previous = bag?.lastWord || null;
      const shuffled = [...words];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(this.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
      }
      if (shuffled.length > 1 && shuffled[shuffled.length - 1] === previous) [shuffled[0], shuffled[shuffled.length - 1]] = [shuffled[shuffled.length - 1]!, shuffled[0]!];
      bag = { signature, remaining: shuffled, lastWord: previous, cycle: (bag?.cycle || 0) + 1 };
      data.bags[difficulty] = bag;
    }
    const eligibleSet = eligible ? new Set(eligible) : null;
    const candidates = eligibleSet ? bag.remaining.filter((word) => eligibleSet.has(word)) : bag.remaining;
    if (!manualWord && !candidates.length) throw new Error("This theme has no unused answers left.");
    const word = manualWord || candidates[candidates.length - 1]!;
    bag.remaining = bag.remaining.filter((candidate) => candidate !== word);
    bag.lastWord = word;
    this.save(data);
    return word;
  }

  remaining(id: string, difficulty: ContextDifficulty): number | null {
    return this.data(id).bags[difficulty]?.remaining.length ?? null;
  }

  recordRound(id: string, result: HuntRoundResult, checkpoint?: unknown): void {
    if (this.database) {
      const before = structuredClone(this.data(id));
      try {
        this.database.transaction(() => {
          if (this.database!.claimRound(id, result.id)) this.applyRound(id, result);
          if (checkpoint) this.database!.saveSnapshot(id, checkpoint);
        });
      } catch (error) { this.cache.set(id, before); throw error; }
      return;
    }
    this.applyRound(id, result);
  }

  forget(id: string): void { this.cache.delete(id); }

  private applyRound(id: string, result: HuntRoundResult): void {
    const data = this.data(id);
    if (data.recentRounds.some((round) => round.id === result.id)) return;
    data.records.rounds += 1;
    if (result.won) data.records.wins += 1;
    data.records.bestStreak = Math.max(data.records.bestStreak, result.streak);
    if (result.mode === "marathon") data.records.bestMarathonWords = Math.max(data.records.bestMarathonWords || 0, result.marathonSolves || 0);
    if (result.won && result.solvedMs !== null && (!data.records.fastestSolve || result.solvedMs < data.records.fastestSolve.ms)) {
      data.records.fastestSolve = { ms: result.solvedMs, by: result.awards.find((award) => award.kind === "solver")?.displayName || "Chat", word: result.word, difficulty: result.difficulty };
    }
    for (const participant of result.participants) {
      if (!Object.hasOwn(data.players, participant.login)) Object.defineProperty(data.players, participant.login, {
        value: { ...participant, points: 0, solves: 0, biggestLeaps: 0, pathfinders: 0, rounds: 0 }, writable: true, enumerable: true, configurable: true,
      });
      const score = data.players[participant.login]!;
      score.displayName = participant.displayName;
      score.rounds += 1;
    }
    const scores = Object.values(data.players);
    for (const award of result.awards) addAward(scores, award);
    data.players = Object.fromEntries(scores.map((score) => [score.login, score]));
    data.recentRounds.push(structuredClone(result));
    data.recentRounds = data.recentRounds.slice(-200);
    this.save(data);
  }
}

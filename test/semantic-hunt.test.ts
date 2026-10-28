import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CommunityStore } from "../src/community-store.ts";
import { GameService } from "../src/game.ts";
import { contextDifficultyPools, contextWordPool } from "../src/embeddings.ts";

function directory(t: any): string {
  const path = mkdtempSync(join(tmpdir(), "brb-community-test-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

test("shuffled word bags do not repeat until exhausted, survive restarts, and isolate communities", (t) => {
  const path = directory(t);
  const words = ["ocean", "forest", "tiger", "pizza"];
  const first = new CommunityStore(path, () => .4);
  const used = [first.drawTarget("alpha", "easy", words)];
  const restored = new CommunityStore(path, () => .4);
  for (let i = 0; i < 3; i++) used.push(restored.drawTarget("alpha", "easy", words));
  assert.equal(new Set(used).size, words.length);
  assert.notEqual(restored.drawTarget("alpha", "easy", words), used.at(-1));
  assert.equal(restored.remaining("beta", "easy"), null);
  assert.equal(statSync(join(path, "alpha.json")).mode & 0o777, 0o600);
  assert.equal(readFileSync(join(path, "alpha.json"), "utf8").includes("accessToken"), false);
});

test("difficulty pools are disjoint concrete-noun subsets of the guess vocabulary", () => {
  const pools = Object.values(contextDifficultyPools);
  assert.ok(pools.every((pool) => pool.length >= 100));
  assert.equal(pools.flat().length, new Set(pools.flat()).size);
  assert.equal(contextWordPool.includes("quickly"), false);
  assert.equal(contextWordPool.includes("happiness"), false);
  assert.equal(contextWordPool.includes("forest"), true);
  assert.equal(contextWordPool.includes("rainbow"), true);
});

test("contribution awards reward useful improvements separately from the solver, and persist once", async (t) => {
  const path = directory(t);
  const store = new CommunityStore(path);
  const game = new GameService({ communityStore: store, communityId: "alpha", communityName: "Alpha chat" });
  const scores: Record<string, number> = { rock: .1, tree: .25, water: .4, sea: .65 };
  game.semanticSimilarity = async (_target, word) => scores[word]!;
  game.startContext("ocean", 60);
  await game.chatGuessAsync("starter", "Starter", "rock");
  await game.chatGuessAsync("alice", "Alice", "tree");
  await game.chatGuessAsync("bob", "Bob", "water");
  await game.chatGuessAsync("alice", "Alice", "sea");
  await game.chatGuessAsync("bob", "Bob", "sea");
  assert.equal(game.state.contextGuesses.length, 4);
  await game.chatGuessAsync("charlie", "Charlie", "ocean");
  assert.deepEqual(game.state.contextAwards.map((award) => [award.kind, award.login, award.points]), [
    ["solver", "charlie", 100], ["biggestLeap", "alice", 50], ["pathfinder", "alice", 30],
  ]);
  assert.equal(game.state.contextSessionScores.find((score) => score.login === "alice")?.points, 80);
  const restored = new CommunityStore(path);
  const summary = restored.summary("alpha");
  assert.equal(summary.wins, 1);
  assert.equal(summary.rounds, 1);
  assert.equal(summary.bestStreak, 1);
  assert.equal(summary.contributors, 4);
  assert.equal(summary.leaderboard[0]?.login, "charlie");
  assert.equal(summary.fastestSolve?.by, "Charlie");
  assert.equal(restored.summary("beta").wins, 0);
  const saved = JSON.parse(readFileSync(join(path, "alpha.json"), "utf8"));
  restored.recordRound("alpha", saved.recentRounds[0]);
  assert.equal(restored.summary("alpha").wins, 1);
  assert.equal(restored.summary("alpha").leaderboard[0]?.points, 100);
  const publicData = game.publicState();
  assert.equal("bags" in publicData, false);
  assert.equal("contextClutchUsers" in publicData, false);
});

test("clutch bonuses require a real new-best gain, are once per viewer, and cap at 15 seconds", async () => {
  const game = new GameService();
  let score = .1;
  game.semanticSimilarity = async () => score;
  game.startContext("ocean", 60);
  await game.chatGuessAsync("starter", "Starter", "rock");
  game.state.endsAt = Date.now() + 9_000;
  score = .2;
  await game.chatGuessAsync("alice", "Alice", "tree");
  assert.equal(game.state.contextClutchSeconds, 5);
  assert.ok(game.state.endsAt! > Date.now() + 13_000);
  game.state.endsAt = Date.now() + 9_000;
  score = .3;
  await game.chatGuessAsync("alice", "Alice", "water");
  assert.equal(game.state.contextClutchSeconds, 5);
  for (const [login, word] of [["bob", "sea"], ["charlie", "beach"], ["delta", "wave"]]) {
    game.state.endsAt = Date.now() + 9_000;
    score += .1;
    await game.chatGuessAsync(login!, login!, word!);
  }
  assert.equal(game.state.contextClutchSeconds, 15);
  const before = game.state.contextClutchSeconds;
  await game.chatGuessAsync("echo", "Echo", "wave");
  assert.equal(game.state.contextClutchSeconds, before);
  game.updateDuration(120, { clutchEnabled: false, difficulty: "hard" });
  assert.equal(game.state.endsAt, game.state.startedAt! + 135_000);
  assert.equal(game.state.contextNextDifficulty, "hard");
  assert.equal(game.state.contextClutchEnabled, false);
});

test("difficulty changes wait for the next word, while session points continue across rounds", async () => {
  const game = new GameService();
  game.startContext("ocean", 60, { difficulty: "easy" });
  const currentDifficulty = game.state.contextDifficulty;
  game.updateDuration(60, { difficulty: "hard" });
  assert.equal(game.state.contextDifficulty, currentDifficulty);
  game.chatGuess("winner", "Winner", "ocean");
  game.state.endsAt = Date.now() - 1;
  game.advanceIfDue();
  assert.equal(game.state.contextDifficulty, "hard");
  assert.ok(contextDifficultyPools.hard.includes(game.state.target!));
  assert.equal(game.state.contextSessionScores[0]?.points, 100);
  assert.equal(game.state.contextAwards.length, 0);
  assert.equal(game.state.contextClutchSeconds, 0);
});

test("a late AI response cannot award a new round with the same secret", async () => {
  const game = new GameService();
  let resolve!: (value: number) => void;
  game.semanticSimilarity = () => new Promise((done) => { resolve = done; });
  game.startContext("ocean");
  const pending = game.chatGuessAsync("viewer", "Viewer", "sea");
  game.startContext("ocean");
  resolve(.8);
  await pending;
  assert.equal(game.state.contextGuesses.length, 0);
  await game.chatGuessAsync("winner", "Winner", "ocean");
  assert.equal(game.state.winner, "Winner");
});

test("a missed round preserves contribution credit but breaks the current streak", async () => {
  const game = new GameService();
  game.startContext("ocean");
  let similarity = .1;
  game.semanticSimilarity = async () => similarity;
  await game.chatGuessAsync("start", "Start", "rock");
  similarity = .5;
  await game.chatGuessAsync("helper", "Helper", "sea");
  game.state.endsAt = Date.now() - 1;
  game.advanceIfDue();
  assert.equal(game.state.contextStreak, 0);
  assert.equal(game.state.contextAwards.some((award) => award.kind === "solver"), false);
  assert.equal(game.state.contextSessionScores.find((score) => score.login === "helper")?.points, 80);
  assert.equal((game.publicState().community as any).rounds, 1);
});

test("disabled clutch, a late first guess, and an expired round never earn a timer extension", async () => {
  const game = new GameService();
  let score = .1;
  game.semanticSimilarity = async () => score;
  game.startContext("ocean", 60, { clutchEnabled: false });
  game.state.endsAt = Date.now() + 9_000;
  await game.chatGuessAsync("starter", "Starter", "rock");
  score = .5;
  await game.chatGuessAsync("alice", "Alice", "water");
  assert.equal(game.state.contextClutchSeconds, 0);
  game.updateDuration(60, { clutchEnabled: true });
  game.state.endsAt = Date.now() - 1;
  score = .9;
  await game.chatGuessAsync("bob", "Bob", "sea");
  assert.equal(game.state.contextClutchSeconds, 0);
  assert.equal(game.state.phase, "finished");
  assert.equal(game.state.contextGuesses.length, 2);
});

test("switching channel clears live state and keeps each community's records separate", () => {
  const store = new CommunityStore();
  const game = new GameService({ communityStore: store, communityId: "alpha" });
  game.startContext("ocean");
  game.chatGuess("winner", "Winner", "ocean");
  game.setCommunity("beta", "Beta chat");
  assert.equal(game.state.kind, "idle");
  assert.equal((game.publicState().community as any).wins, 0);
  game.setCommunity("alpha", "Alpha chat");
  assert.equal((game.publicState().community as any).wins, 1);
  assert.equal(game.state.contextSessionScores.length, 0);
});

test("storage errors preserve gameplay and expose a control-page warning", (t) => {
  const root = directory(t);
  const data = join(root, "communities");
  let failures = 0;
  const store = new CommunityStore(data, Math.random, () => { failures += 1; });
  rmSync(data, { recursive: true });
  writeFileSync(data, "blocked path");
  const game = new GameService({ communityStore: store, communityId: "alpha" });
  game.startContext("ocean");
  game.chatGuess("winner", "Winner", "ocean");
  assert.equal(game.state.winner, "Winner");
  assert.equal((game.publicState().community as any).wins, 1);
  assert.ok(game.controlState().storageWarning);
  assert.ok(failures >= 1);
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/database.ts";
import { CommunityStore } from "../src/community-store.ts";
import { GameService } from "../src/game.ts";
import { themeWords } from "../src/word-hunt.ts";

const BASE = 1_800_000_000_000;
function fixture(t: any) {
  let now = BASE; t.mock.method(Date, "now", () => now);
  const path = mkdtempSync(join(tmpdir(), "hunt-marathon-"));
  const database = new AppDatabase(path, "test-key");
  const community = new CommunityStore(undefined, Math.random, undefined, database);
  const game = new GameService({ communityStore: community, communityId: "101" });
  t.after(() => { game.dispose(); database.close(); rmSync(path, { recursive: true, force: true }); });
  return { game, community, database, at: (ms: number) => { now = BASE + ms; game.advanceIfDue(); } };
}

test("Marathon banks remaining time plus 15 seconds, pauses between words, ends once, and saves history and personal best", (t) => {
  const { game, community, database, at } = fixture(t);
  game.startContext("tiger", 180, { huntMode: "marathon" });
  at(30_000); game.chatGuess("scout", "Scout", "lion");
  at(31_000); game.chatGuess("solver", "Solver", "tiger");
  assert.equal(game.state.contextMarathonRemainingMs, 164_000);
  assert.equal(game.state.contextMarathonSolves, 1);
  at(38_999); assert.equal(game.state.phase, "finished");
  at(39_000); assert.equal(game.state.round, 2);
  assert.equal(game.state.endsAt! - Date.now(), 164_000);
  const result = community.history("101").rounds[0]!;
  assert.equal(result.word, "tiger"); assert.equal(result.mode, "marathon"); assert.equal(result.guessCount, 2);
  assert.equal(result.closestGuesses?.[0]?.word, "lion");
  assert.equal(community.summary("101").bestMarathonWords, 1);
  at(203_000);
  assert.equal(game.state.contextMarathonEnded, true); assert.equal(game.state.endsAt, null);
  assert.equal(game.state.contextMarathonSolves, 1);
  at(1_000_000); assert.equal(game.state.round, 2); assert.equal(community.summary("101").rounds, 2);
  assert.equal(database.loadSnapshot("101").state.contextMarathonEnded, true);
  const restored = new CommunityStore(undefined, Math.random, undefined, database);
  assert.equal(restored.history("101").rounds[1]?.closestGuesses?.[0]?.word, "lion");
  game.startContext("tiger", 180, { huntMode: "marathon" });
  assert.equal(game.state.contextMarathonSolves, 0); assert.equal(community.summary("101").bestMarathonWords, 1);
});

test("Marathon caps banked time at five minutes and uses solve bonuses instead of clutch extensions", (t) => {
  const { game, at } = fixture(t);
  game.startContext("tiger", 300, { huntMode: "marathon" });
  at(1000); game.chatGuess("solver", "Solver", "tiger");
  assert.equal(game.state.contextMarathonRemainingMs, 300_000);
  game.startContext("tiger", 180, { huntMode: "marathon", clutchEnabled: true });
  at(172_000); game.chatGuess("a", "A", "space"); game.chatGuess("b", "B", "lion");
  assert.equal(game.state.contextClutchSeconds, 0);
  assert.throws(() => game.updateDuration(120), /starting clock/);
});

test("Marathon remaining clock and per-word hint timing survive a paused checkpoint", (t) => {
  const { game, community, at } = fixture(t);
  game.startContext("tiger", 180, { huntMode: "marathon" });
  at(20_000); game.pause();
  const restored = new GameService({ communityStore: community, communityId: "101" }); t.after(() => restored.dispose());
  restored.restore(structuredClone(game.checkpoint()));
  at(600_000); restored.resume();
  assert.equal(restored.state.endsAt! - Date.now(), 160_000);
  assert.equal(restored.publicState().contextHintAt, Date.now() + 10_000);
  at(610_000); restored.advanceIfDue(); assert.equal(restored.publicState().contextHint, "Animals & wildlife");
});

test("theme voting counts one ballot per viewer, supports changes, hides ballots, and draws an unused word in the winning theme", (t) => {
  const { game, community, at } = fixture(t);
  game.startContext("tiger", 60, { themeVoting: true });
  at(10_000); game.chatGuess("solver", "Solver", "tiger");
  const vote = game.state.contextVote!; assert.equal(vote.options.length, 3);
  const winningTheme = vote.options[0]!.id;
  game.voteForTheme("alice", 1); game.voteForTheme("bob", 1);
  game.voteForTheme("alice", 2); game.voteForTheme("charlie", 1);
  game.voteForTheme("bob", 1);
  assert.deepEqual(vote.options.map((option) => option.votes), [2, 1, 0]);
  const publicVote = game.publicState().contextVote as any;
  assert.equal(publicVote.totalVotes, 3); assert.equal(publicVote.ballots, undefined);
  assert.ok(!JSON.stringify(publicVote).includes("alice"));
  at(20_000);
  assert.equal(game.state.phase, "playing"); assert.equal(game.state.contextTheme, winningTheme);
  assert.ok(themeWords([game.state.target!], winningTheme).includes(game.state.target!));
  assert.notEqual(game.state.target, "tiger");
  assert.match(game.voteForTheme("late", 1), /No theme vote/);
  assert.equal(community.summary("101").rounds, 1);
});

test("votes and the between-word clock pause together; no votes falls back to Mystery", (t) => {
  const { game, at } = fixture(t);
  game.startContext("tiger", 180, { huntMode: "marathon", themeVoting: true });
  at(10_000); game.chatGuess("solver", "Solver", "tiger");
  game.pause(); const bank = game.state.contextMarathonRemainingMs;
  at(100_000); assert.equal(game.state.round, 1);
  game.resume(); assert.equal(game.state.contextVote!.endsAt, BASE + 110_000);
  at(110_000); assert.equal(game.state.contextTheme, "mystery");
  assert.equal(game.state.endsAt! - Date.now(), bank);
});

test("theme draws share the master word bag; reviewing a theme cannot reset the no-repeat bag", (t) => {
  const { community } = fixture(t), words = ["tiger", "forest", "ocean", "pizza"];
  const first = community.drawTarget("101", "easy", words, undefined, ["tiger", "forest"]);
  const second = community.drawTarget("101", "easy", words, undefined, ["tiger", "forest"]);
  assert.notEqual(first, second);
  assert.deepEqual(community.availableTargets("101", "easy", words).sort(), ["ocean", "pizza"]);
  assert.throws(() => community.drawTarget("101", "easy", words, undefined, ["tiger", "forest"]), /no unused/);
  assert.ok(["ocean", "pizza"].includes(community.drawTarget("101", "easy", words)));
});

test("history pagination is newest first, bounded, isolated and compatible with older results", (t) => {
  const { community } = fixture(t);
  for (let index = 0; index < 205; index++) community.recordRound("101", { id: "round-" + index, word: "word" + index, difficulty: "easy", won: false, streak: 0, solvedMs: null, completedAt: index, awards: [], participants: [] });
  const first = community.history("101"); assert.equal(first.total, 200); assert.equal(first.rounds.length, 20);
  assert.equal(first.rounds[0]?.word, "word204"); assert.equal(first.hasMore, true);
  assert.equal(community.history("101", 180).hasMore, false);
  assert.equal(community.history("202").total, 0);
  assert.equal(first.rounds[0]?.closestGuesses, undefined);
});

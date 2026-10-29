import test from "node:test";
import assert from "node:assert/strict";
import { GameService } from "../src/game.ts";
import { contextWordPool, getContextCategory } from "../src/embeddings.ts";

function fixture(t: any) {
  let now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  const game = new GameService();
  t.after(() => game.dispose());
  return { game, at: (value: number) => { now = 1_800_000_000_000 + value; game.advanceIfDue(); } };
}

test("every possible answer has a category without repeating the secret itself", () => {
  for (const word of contextWordPool) {
    const category = getContextCategory(word);
    assert.ok(category, word);
    assert.ok(!category.toLowerCase().split(/[^a-z]+/).includes(word), word);
  }
  for (const [word, category] of [["infield", "Sports & games"], ["whiskey", "Food & drink"], ["pew", "Home & furniture"], ["tiger", "Animals & wildlife"], ["turtle", "Animals & wildlife"], ["tuna", "Animals & wildlife"], ["lettuce", "Food & drink"]]) assert.equal(getContextCategory(word!), category);
});

test("category stays private before halfway, then reaches dashboard and overlay without revealing the answer", (t) => {
  const { game, at } = fixture(t);
  game.startContext("whiskey", 60);
  assert.equal(game.publicState().contextHintAt, Date.now() + 30_000);
  at(29_999);
  assert.equal(game.publicState().contextHint, null);
  assert.ok(!JSON.stringify(game.publicState()).includes("Food & drink"));
  at(30_000);
  assert.equal(game.publicState().contextHint, "Food & drink");
  assert.equal(game.controlState().contextHint, "Food & drink");
  assert.equal(game.publicState().contextHintAt, null);
  assert.equal(game.publicState().target, undefined);
  assert.ok(!JSON.stringify(game.publicState()).includes('"whiskey"'));
});

test("hints can be switched off and on without resetting guesses, and revealed hints survive timer edits", (t) => {
  const { game, at } = fixture(t);
  game.startContext("whiskey", 60, { hintsEnabled: false });
  game.chatGuess("a", "A", "drink");
  at(31_000);
  assert.equal(game.publicState().contextHint, null);
  assert.equal(game.publicState().contextHintAt, null);
  game.updateDuration(60, { hintsEnabled: true });
  assert.equal(game.publicState().contextHint, "Food & drink");
  game.updateDuration(300);
  assert.equal(game.publicState().contextHint, "Food & drink");
  assert.equal(game.state.contextGuesses.length, 1);
  game.updateDuration(300, { hintsEnabled: false });
  assert.equal(game.publicState().contextHint, null);
  game.updateDuration(300, { hintsEnabled: true });
  assert.equal(game.publicState().contextHint, "Food & drink");
});

test("editing the timer before reveal moves halfway while clutch time does not", (t) => {
  const { game, at } = fixture(t);
  game.startContext("tiger", 60);
  at(20_000); game.updateDuration(120);
  assert.equal(game.publicState().contextHintAt, 1_800_000_060_000);
  at(30_000); assert.equal(game.publicState().contextHint, null);
  game.state.contextClutchSeconds = 15; game.state.endsAt! += 15_000;
  at(60_000); assert.equal(game.publicState().contextHint, "Animals & wildlife");
});

test("pause and restart preserve the remaining time to reveal and retain an already revealed category", (t) => {
  const { game, at } = fixture(t);
  game.startContext("tiger", 60);
  at(20_000); game.pause();
  const restored = new GameService(); t.after(() => restored.dispose());
  restored.restore(game.checkpoint());
  at(200_000); restored.advanceIfDue();
  assert.equal(restored.publicState().contextHint, null);
  restored.resume();
  assert.equal(restored.publicState().contextHintAt, Date.now() + 10_000);
  at(210_000); restored.advanceIfDue();
  assert.equal(restored.publicState().contextHint, "Animals & wildlife");
  const again = new GameService(); t.after(() => again.dispose());
  again.restore(restored.checkpoint());
  assert.equal(again.publicState().contextHint, "Animals & wildlife");
});

test("the answer reveal and the next round clear the old category; disabled hints remain disabled", (t) => {
  const { game, at } = fixture(t);
  game.startContext("tiger", 60);
  at(30_000); game.chatGuess("solver", "Solver", "tiger");
  assert.equal(game.publicState().contextHint, null);
  at(38_000);
  assert.equal(game.state.round, 2);
  assert.equal(game.state.contextHintRevealed, false);
  assert.equal(game.publicState().contextHint, null);
  game.updateDuration(60, { hintsEnabled: false });
  at(98_000); at(106_000);
  assert.equal(game.state.contextHintsEnabled, false);
  assert.equal(game.publicState().contextHintAt, null);
});

test("Start reveals immediately on the first and subsequent rounds, while disabled hints stay private", (t) => {
  const { game, at } = fixture(t);
  game.startContext("tiger", 60, { hintTiming: "start" });
  assert.equal(game.publicState().contextHint, "Animals & wildlife");
  assert.equal(game.publicState().contextHintAt, null);
  game.chatGuess("solver", "Solver", "tiger");
  at(8_000);
  assert.equal(game.state.round, 2);
  assert.ok(game.publicState().contextHint);
  game.startContext("tiger", 60, { hintTiming: "start", hintsEnabled: false });
  assert.equal(game.publicState().contextHint, null);
  game.updateDuration(60, { hintsEnabled: true });
  assert.equal(game.publicState().contextHint, "Animals & wildlife");
});

test("End reveals at the start of the final quarter for every supported duration", (t) => {
  const { game, at } = fixture(t);
  for (const duration of [30, 45, 60, 120, 180, 300]) {
    at(0);
    game.startContext("whiskey", duration, { hintTiming: "end" });
    const revealMs = duration * 750;
    assert.equal(game.publicState().contextHintAt, Date.now() + revealMs);
    at(revealMs - 1); assert.equal(game.publicState().contextHint, null);
    at(revealMs); assert.equal(game.publicState().contextHint, "Food & drink");
    assert.equal(game.state.phase, "playing");
    game.stop();
  }
});

test("timing edits move unrevealed hints and keep revealed hints visible; invalid choices do not change the game", (t) => {
  const { game, at } = fixture(t);
  game.startContext("tiger", 60);
  at(20_000); game.updateDuration(60, { hintTiming: "end" });
  assert.equal(game.publicState().contextHintAt, 1_800_000_045_000);
  at(30_000); assert.equal(game.publicState().contextHint, null);
  game.updateDuration(60, { hintTiming: "start" });
  assert.equal(game.publicState().contextHint, "Animals & wildlife");
  game.updateDuration(60, { hintTiming: "end" });
  assert.equal(game.publicState().contextHint, "Animals & wildlife");
  const before = structuredClone(game.state);
  assert.throws(() => game.updateDuration(120, { hintTiming: "tomorrow" as any }), /hint timing/);
  assert.deepEqual(game.state, before);
  assert.throws(() => game.startContext("tree", 120, { hintTiming: "constructor" as any }), /hint timing/);
  assert.deepEqual(game.state, before);
});

test("End timing survives restart and pause, and older snapshots keep the Middle default", (t) => {
  const { game, at } = fixture(t);
  game.startContext("tiger", 60, { hintTiming: "end" });
  at(20_000); game.pause();
  const snapshot = structuredClone(game.checkpoint()) as any;
  const restored = new GameService(); t.after(() => restored.dispose());
  restored.restore(snapshot);
  at(200_000); restored.resume();
  assert.equal(restored.state.contextHintTiming, "end");
  assert.equal(restored.publicState().contextHintAt, Date.now() + 25_000);
  at(224_999); restored.advanceIfDue(); assert.equal(restored.publicState().contextHint, null);
  at(225_000); restored.advanceIfDue(); assert.equal(restored.publicState().contextHint, "Animals & wildlife");
  delete snapshot.state.contextHintTiming;
  restored.restore(snapshot);
  assert.equal(restored.state.contextHintTiming, "middle");
});

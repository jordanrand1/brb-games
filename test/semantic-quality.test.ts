import test from "node:test";
import assert from "node:assert/strict";
import { contextWordPool, contextDifficultyPools, lexicon, semanticModel, getWordRank, getWordSimilarity } from "../src/embeddings.ts";
import { GameService } from "../src/game.ts";

const rank = (target: string, guess: string) => {
  const value = getWordRank(target, guess); assert.notEqual(value, null, `${guess} needs a vector`); return value!;
};
const similarity = (target: string, guess: string) => getWordSimilarity(target, guess)!;

test("commonsense model preserves the animal-to-big-cat trail and rejects unrelated space words", () => {
  assert.match(semanticModel.id, /^numberbatch-en-19\.08-/);
  assert.ok(rank("tiger", "animal") < 300);
  assert.ok(rank("tiger", "jungle") < rank("tiger", "animal"));
  assert.ok(rank("tiger", "lion") < rank("tiger", "jungle"));
  assert.ok(rank("tiger", "lion") <= 10);
  assert.ok(rank("tiger", "space") > 5000);
  assert.ok(similarity("tiger", "animal") > similarity("tiger", "space") + .2);
});

test("beach, sand, bucket and pail form a usable trail with bucket as a near-synonym", () => {
  for (const word of ["pail", "bucket", "beach", "sand", "sandcastle", "seashell"]) assert.ok(lexicon.includes(word));
  assert.ok(rank("pail", "sand") < rank("pail", "beach"));
  assert.ok(rank("pail", "bucket") < rank("pail", "sand"));
  assert.ok(rank("pail", "bucket") <= 3);
  assert.ok(similarity("pail", "bucket") > .8);
  assert.ok(rank("bucket", "sand") < rank("bucket", "space"));
});

test("independent everyday topics have sensible related and unrelated neighbors", () => {
  for (const [target, related, unrelated] of [
    ["ocean", "sea", "computer"], ["computer", "keyboard", "tree"],
    ["guitar", "piano", "potato"], ["apple", "fruit", "rocket"],
    ["bicycle", "wheel", "coffee"], ["dog", "puppy", "keyboard"],
  ]) {
    assert.ok(rank(target!, related!) < rank(target!, unrelated!), `${target}: ${related} should rank ahead of ${unrelated}`);
    assert.ok(similarity(target!, related!) > similarity(target!, unrelated!) + .1);
    assert.equal(rank(target!, target!), 1);
  }
});

test("expanded vocabulary retains thousands of answers without rare-noun loopholes", () => {
  assert.equal(lexicon.length, 30_000);
  assert.ok(contextWordPool.length > 2000);
  for (const word of ["dead", "found", "national", "following", "people", "government", "innovation", "john", "mike", "well"]) assert.ok(!contextWordPool.includes(word), `${word} must not become a secret through an obscure noun sense`);
  for (const word of ["tiger", "bucket", "pail", "sandcastle", "seashell"]) assert.ok(contextDifficultyPools.easy.includes(word));
  assert.ok(lexicon.includes("dead"), "non-noun clues can still be guesses");
});

test("a familiar compound can be guessed with natural spacing", () => {
  const game = new GameService();
  try {
    game.startContext("sandcastle");
    game.chatGuess("builder", "Builder", "Sand castle!");
    assert.equal(game.state.winner, "Builder");
    assert.equal(game.state.contextGuesses[0]?.word, "sandcastle");
    assert.equal(game.state.contextGuesses[0]?.rank, 1);
  } finally { game.dispose(); }
});

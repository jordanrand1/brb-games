import test from "node:test";
import assert from "node:assert/strict";
import { GameService } from "../src/game.ts";
import { getWordRank, getWordSimilarity, lexicon } from "../src/embeddings.ts";
import { canControlChannelMessage } from "../src/twitch-chat.ts";

test("semantic ranks are deterministic and order related words ahead of unrelated words", () => {
  const first = getWordRank("ocean", "sea");
  const again = getWordRank("ocean", "sea");
  const unrelated = getWordRank("ocean", "computer");
  assert.equal(first, again);
  assert.ok(first !== null && unrelated !== null && first < unrelated);
  assert.ok(lexicon.length > 100);
  assert.ok(getWordSimilarity("ocean", "sea")! > getWordSimilarity("ocean", "computer")!);
  assert.equal(getWordSimilarity("ocean", "ocean"), 1);
});

test("context guesses are unique across chatters and the exact answer ends the round", () => {
  const game = new GameService();
  game.startContext("ocean");
  const first = game.chatGuess("viewer_one", "ViewerOne", "sea");
  assert.match(first, /rank #/);
  game.chatGuess("viewer_two", "ViewerTwo", "sea");
  assert.equal(game.state.contextGuesses.length, 1);
  assert.ok(Number.isFinite(game.state.contextGuesses[0]?.similarity));
  assert.equal(game.publicState().target, undefined);
  game.chatGuess("viewer_three", "ViewerThree", "ocean");
  assert.equal(game.state.phase, "finished");
  assert.equal(game.state.winner, "ViewerThree");
  assert.equal(game.publicState().target, "ocean");
});

test("Wordle keeps personal boards and advances when all live players solve", () => {
  const game = new GameService();
  game.startWordle(45, "apple");
  game.join("alpha", "Alpha");
  game.join("beta", "Beta");
  assert.equal(game.publicState().target, undefined);
  game.chatGuess("alpha", "Alpha", "apple");
  assert.equal(game.state.players.alpha?.solved, true);
  assert.equal(game.state.round, 1);
  game.chatGuess("beta", "Beta", "apple");
  assert.equal(game.state.round, 2);
  assert.equal(game.state.phase, "playing");
  assert.notEqual(game.state.target, "apple");
  assert.equal(game.state.players.alpha?.attempts.length, 0);
});

test("Wordle eliminates a player after six misses and declares the remaining player", () => {
  const game = new GameService();
  game.startWordle(60, "apple");
  game.join("champion", "Champion");
  game.join("challenger", "Challenger");
  for (const guess of ["beach", "bread", "charm", "cloud", "dance", "dream"]) {
    game.chatGuess("challenger", "Challenger", guess);
  }
  assert.equal(game.state.players.challenger?.alive, false);
  assert.equal(game.state.phase, "finished");
  assert.equal(game.state.winner, "Champion");
});

test("Wordle timeout eliminates unsolved players and advances surviving solvers", () => {
  const game = new GameService();
  game.startWordle(30, "apple");
  game.join("survivor", "Survivor");
  game.join("timed_out", "TimedOut");
  game.chatGuess("survivor", "Survivor", "apple");
  game.state.endsAt = Date.now() - 1;
  game.advanceIfDue();
  assert.equal(game.state.players.timed_out?.alive, false);
  assert.equal(game.state.phase, "finished");
  assert.equal(game.state.winner, "Survivor");
});

test("only the channel broadcaster or a moderator badge can control a Twitch game", () => {
  assert.equal(canControlChannelMessage({ chatter_user_id: "10", broadcaster_user_id: "10", badges: [] }), true);
  assert.equal(canControlChannelMessage({ chatter_user_id: "20", broadcaster_user_id: "10", badges: [{ set_id: "moderator" }] }), true);
  assert.equal(canControlChannelMessage({ chatter_user_id: "20", broadcaster_user_id: "10", badges: [{ set_id: "subscriber" }] }), false);
  assert.equal(canControlChannelMessage(null), false);
});

test("editing a live timer preserves guesses and keeps elapsed round time", () => {
  const game = new GameService();
  game.startContext("ocean", 60);
  game.chatGuess("viewer", "Viewer", "sea");
  const startedAt = game.state.startedAt!;
  game.updateDuration(300);
  assert.equal(game.state.durationSeconds, 300);
  assert.equal(game.state.endsAt, startedAt + 300_000);
  assert.equal(game.state.contextGuesses.length, 1);
  assert.equal(game.state.target, "ocean");
  assert.throws(() => game.updateDuration(999));
  game.state.startedAt = Date.now() - 40_000;
  game.updateDuration(30);
  assert.equal(game.state.phase, "finished");
  assert.equal(game.publicState().target, "ocean");
});

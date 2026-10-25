// Checks for the default strategy. Run with `npm test`.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import { chooseWord, decideBid, wordScore } from "./strategy-premium.js";

const rack = (letters: string) => {
  const r = new Map<string, number>();
  for (const c of letters) r.set(c, (r.get(c) ?? 0) + 1);
  return r;
};

test("chooseWord picks the longest word the rack can spell", () => {
  const dictionary = ["TACT", "CAT", "AT"];
  assert.equal(chooseWord({ myRack: rack("TACT"), dictionary }), "TACT");
  assert.equal(chooseWord({ myRack: rack("CATX"), dictionary }), "CAT");
  assert.equal(chooseWord({ myRack: rack("CX"), dictionary }), null);
});

// The bot can't see a match move on while it searches, so a slow search
// means bids on closed auctions and words from letters it already spent.
test("chooseWord searches the whole wordlist well within an auction", () => {
  const dictionary = fs
    .readFileSync(
      new URL("../../spacetimedb/wordlist.txt", import.meta.url),
      "utf8",
    )
    .split("\n")
    .map((l) => l.trim().toUpperCase())
    .filter((l) => l.length >= 2)
    .sort((a, b) => b.length - a.length);
  // The largest rack an admin can set, with almost nothing to spell.
  const myRack = rack("BCDFGHJKLMNPQRSTVWXZ");
  chooseWord({ myRack: new Map(), dictionary }); // The runner warms the index before connecting.
  const start = performance.now();
  chooseWord({ myRack, dictionary });
  assert.ok(performance.now() - start < 100, "a search took 100 ms or more");
});

test("scores rewards with the server's length multipliers and rounding", () => {
  assert.equal(wordScore("CAT"), 5);
  assert.equal(wordScore("TACT"), 9);
  assert.equal(wordScore("QUIZ"), 33);
  assert.equal(wordScore("QUIZZED"), 105);
});

test("saves short words for bonuses, then cashes out before the bag empties", () => {
  const ctx = { myRack: rack("TACT"), dictionary: ["TACT", "CAT", "AT"], myBalance: 100 };
  assert.equal(chooseWord({ ...ctx, bagRemaining: 50 }), null);
  assert.equal(chooseWord({ ...ctx, bagRemaining: 4 }), "TACT");
  assert.equal(chooseWord({ ...ctx, myBalance: 4, bagRemaining: 50 }), "TACT");
});

test("picks score over length, counts repeats, and preserves the rack", () => {
  const ctx = { myRack: rack("QUIZCATS"), dictionary: ["CATS", "QUIZ", "QUIZZES"] };
  assert.equal(chooseWord(ctx), "QUIZ");
  assert.equal(ctx.myRack.get("Z"), 1);
});

test("completion letters earn a premium and bids obey the budget and auction type", () => {
  const ctx = { myRack: rack("QUIZZE"), dictionary: ["QUIZZED"], myBalance: 100, bagRemaining: 30, letter: "D" };
  assert.ok(decideBid(ctx) > decideBid({ ...ctx, letter: "O" }));
  assert.ok(decideBid({ ...ctx, auctionType: "FirstPrice" }) <= decideBid(ctx));
  assert.equal(decideBid({ ...ctx, myBalance: 0 }), 0);
  assert.equal(decideBid({ ...ctx, bagRemaining: 0 }), 0);
  assert.equal(decideBid({ ...ctx, bagRemaining: 1 }), 100);
  assert.equal(decideBid({ ...ctx, bagRemaining: 1, letter: "O" }), 0);
  assert.equal(decideBid({ ...ctx, opponentBalances: [0, 0] }), 1);
  for (const balance of [1, 2, 5, 20, 100]) {
    const bid = decideBid({ ...ctx, myBalance: balance });
    assert.ok(Number.isInteger(bid) && bid >= 0 && bid <= balance);
  }
});


test("does not freeze affordable bids behind a percentage of the remaining balance", () => {
  const ctx = { myRack: rack("AEIN"), dictionary: ["TRAIN"], myBalance: 22, bagRemaining: 30, letter: "R" };
  assert.equal(decideBid(ctx), 14);
  assert.equal(decideBid({ ...ctx, myBalance: 12 }), 12);
});

test("can spend its balance on a letter whose completed word pays it back", () => {
  const ctx = { myRack: rack("QUIZZE"), dictionary: ["QUIZZED"], myBalance: 22, bagRemaining: 30, letter: "D" };
  assert.equal(decideBid(ctx), 22);
  assert.equal(decideBid({ ...ctx, auctionType: "FirstPrice" }), 22);
  assert.equal(decideBid({ ...ctx, opponentBalances: [5, 7] }), 8);
});


test("values an expensive tile that leaves a high-scoring seven-letter word one purchase away", () => {
  const ctx = { myRack: rack("CODIS"), dictionary: ["CODFISH"], myBalance: 100, bagRemaining: 40, letter: "F" };
  assert.equal(wordScore("CODFISH"), 48);
  assert.equal(decideBid(ctx), 33);
  assert.equal(decideBid({ ...ctx, letter: "H" }), 33);
  assert.equal(decideBid({ ...ctx, myBalance: 20 }), 20);
  assert.equal(decideBid({ ...ctx, bagRemaining: 15 }), 17);
  assert.equal(ctx.myRack.has("F"), false);
});

test("does not plan words exceeding the shared bag's letter supply", () => {
  const ctx = { myRack: rack("QUIES"), dictionary: ["QUIZZES"], myBalance: 100, bagRemaining: 40, letter: "Z" };
  assert.equal(decideBid(ctx), 1);
});

test("the speculative premium requires a seven-letter reward of at least 45", () => {
  const ctx = { myRack: rack("SOMEA"), dictionary: ["AWESOME"], myBalance: 100, bagRemaining: 40, letter: "W" };
  assert.equal(wordScore("AWESOME"), 36);
  assert.equal(decideBid(ctx), 17);
});

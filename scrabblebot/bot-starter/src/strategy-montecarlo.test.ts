import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { chooseWord, decideBid, sampleFuture } from "./strategy-montecarlo.js";

const rack = (text: string) => {
  const result = new Map<string, number>();
  for (const c of text) result.set(c, (result.get(c) ?? 0) + 1);
  return result;
};

test("Monte Carlo preserves duplicate tile requirements and dictionary tie order", () => {
  const dictionary = ["CATS", "ACTS", "BALLOON", "BALL", "ON"];
  assert.equal(chooseWord({ dictionary, myRack: rack("CATS"), bagRemaining: 0 }), "CATS");
  assert.equal(chooseWord({ dictionary, myRack: rack("BALLON"), bagRemaining: 0 }), "BALL");
  assert.equal(chooseWord({ dictionary, myRack: rack("BALLOON"), bagRemaining: 0 }), "BALLOON");
  assert.equal(chooseWord({ dictionary: ["A!", "ÅT", "AT"], myRack: rack("ABCDEFGHIJKLMNOPQRSTUVWXYZ"), bagRemaining: 0 }), "AT");
});

test("Monte Carlo bids stay affordable and skip the unusable final tile", () => {
  const dictionary = ["CARTER", "CARTERS", "AT", "ON", "BALL", "BALLOON", "QUIZ"];
  const myRack = rack("CARTER"), before = [...myRack];
  for (const myBalance of [0, 1, 9, 13, 40, 100]) for (const bagRemaining of [0, 1, 5, 6, 30, 67]) {
    for (const letter of ["A", "F", "Q"]) for (const auctionType of ["Vickrey", "FirstPrice"]) {
      const ctx = { dictionary, myRack, myBalance, bagRemaining, letter, auctionType };
      const bid = decideBid(ctx);
      assert.ok(Number.isInteger(bid) && bid >= 0 && bid <= myBalance);
      if (bagRemaining === 0) assert.equal(bid, 0);
      assert.equal(decideBid(ctx), bid);
    }
  }
  assert.deepEqual([...myRack], before);
});

test("warmed Monte Carlo decisions meet the auction timing budget", () => {
  const dictionary = readFileSync(new URL("../../spacetimedb/wordlist.txt", import.meta.url), "utf8")
    .split("\n").map(w => w.trim().toUpperCase()).filter(w => w.length >= 2).sort((a, b) => b.length - a.length);
  chooseWord({ dictionary, myRack: new Map() });
  for (const letter of ["A", "F", "Q"]) {
    const counts = [9, 2, 2, 4, 12, 2, 3, 2, 9, 1, 1, 4, 2, 6, 8, 2, 1, 6, 4, 6, 4, 2, 2, 1, 2, 1];
    const remaining = new Map(counts.map((n, i) => [String.fromCharCode(65 + i), n]));
    for (const c of "AEINRAEEGLOT" + letter) remaining.set(c, remaining.get(c)! - 1);
    for (const remainingLetters of [undefined, remaining]) {
      const start = performance.now();
      decideBid({ dictionary, myRack: rack("AEINR"), myBalance: 100, bagRemaining: 60, letter, remainingLetters });
      assert.ok(performance.now() - start < 100, "Decision exceeded 100ms");
    }
  }
});


test("conditioned Monte Carlo futures respect counts and keep deterministic shared prefixes", () => {
  const remainingLetters = new Map([["E", 2], ["X", 1]]);
  const before = [...remainingLetters];
  const full = sampleFuture(123, 20, remainingLetters);
  const short = sampleFuture(123, 1, remainingLetters);
  for (let k = 0; k < full.length; k++) {
    assert.equal(full[k].length, 3);
    assert.equal(full[k].filter(c => c === 4).length, 2);
    assert.equal(full[k].filter(c => c === 23).length, 1);
    assert.deepEqual(short[k], full[k].slice(0, 1));
  }
  assert.deepEqual(sampleFuture(123, 20, remainingLetters), full);
  assert.ok(sampleFuture(123, 5, new Map()).every(d => d.length === 0));
  assert.deepEqual([...remainingLetters], before);
  const ctx = { dictionary: ["CARTER", "CARTERS"], myRack: rack("CARTER"), myBalance: 100, bagRemaining: 30, remainingLetters: new Map<string, number>() };
  assert.equal(chooseWord(ctx), "CARTER");
});

test("Monte Carlo keeps frozen legacy decisions when remaining counts are omitted", () => {
  const dictionary = ["OX", "CART", "CARTER", "CARTERS", "TRACE", "REACT", "CARE", "RACE", "AT", "ON", "QUIZ", "QUIET", "QUIETS", "EXIT", "EXITED", "EXISTED", "SPEAR", "PEAR", "SPARE"];
  for (const [letters, bagRemaining, letter, expected] of [
    ["CARTE", 60, "R", 8], ["QUIE", 40, "T", 34], ["EXITED", 40, "S", 20], ["CARTER", 30, "S", 16],
  ] as const) {
    const ctx = { dictionary, myRack: rack(letters), myBalance: 100, bagRemaining };
    assert.equal(chooseWord(ctx), null);
    assert.equal(decideBid({ ...ctx, letter }), expected);
  }
});

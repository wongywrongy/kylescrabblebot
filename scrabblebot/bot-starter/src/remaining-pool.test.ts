import assert from "node:assert/strict";
import { test } from "node:test";
import { remainingPool } from "./remaining-pool.js";

test("public draws and our initial rack leave opponents' private tiles uncertain", () => {
  const initial = new Map([["A", 2], ["E", 1], ["I", 1], ["X", 1]]);
  const pool = remainingPool(initial, ["Q"], 67, 25)!;
  assert.equal(pool.get("A"), 7);
  assert.equal(pool.get("X"), 0);
  assert.equal(pool.get("Q"), 0);
  assert.equal([...pool.values()].reduce((sum, n) => sum + n, 0), 92);
  assert.equal(initial.get("X"), 1);
  assert.equal(remainingPool(initial, ["Q", "E"], 66, 25)?.get("E"), 10);
});

test("incomplete or duplicated history falls back instead of inventing a bag", () => {
  const initial = new Map([["A", 5]]);
  assert.equal(remainingPool(initial, ["Q", "Q"], 66, 25), undefined);
  assert.equal(remainingPool(initial, [], 67, 25), undefined);
  assert.equal(remainingPool(initial, ["?"], 67, 25), undefined);
});

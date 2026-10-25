import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import * as original from './strategy-mc.js';
import * as credited from './experiment-inventory-mc.js';
import * as fast from './experiment-mc-fast.js';

const rack = (letters: string) => { const result = new Map<string, number>(); for (const c of letters) result.set(c, (result.get(c) ?? 0) + 1); return result; };
const canSpell = (word: string, tiles: Map<string, number>) => { const rest = new Map(tiles); for (const c of word) { if (!(rest.get(c) ?? 0)) return false; rest.set(c, rest.get(c)! - 1); } return true; };
const small = [...new Set(['CARTER', 'CARTERS', 'BALLOON', 'BALLOONS', 'QUIZ', 'QUIZZED', 'JINX', 'JINXED', 'OX', 'BOX', 'BOXES', 'VEX', 'VEXED', 'TAXI', 'TAXIS', 'CATS', 'ACTS', 'CAST', 'SCAT', 'AT', 'ON', 'NO', 'IN', 'TONE', 'NOTE', 'STONE', 'TONES', 'NOTES', 'ABCDEFG'])];
const timings: Record<string, number[]> = {};
const time = <T>(name: string, run: () => T): T => { const t = performance.now(), value = run(); (timings[name] ??= []).push(performance.now() - t); return value; };
let checked = 0;
const differences: any[] = [], malformed: any[] = [];

function check(dictionary: string[], letters: string, balance: number, bagRemaining: number, letter: string, timed = false) {
  const myRack = rack(letters), before = [...myRack], dictionaryBefore = [...dictionary];
  const ctx = { dictionary, myRack, myBalance: balance, bagRemaining };
  const choose = (name: string, run: () => string | null) => timed ? time(name, run) : run();
  const a = choose('original-word', () => original.chooseWord(ctx));
  const b = choose('fast-word', () => fast.chooseWord(ctx));
  assert.equal(b, a);
  const c = choose('credited-word', () => credited.chooseWord(ctx));
  const d = choose('fast-credited-word', () => fast.chooseWord(ctx, true));
  assert.equal(d, c);
  for (const word of [a, b, c, d]) if (word) { assert.ok(dictionary.includes(word)); assert.ok(canSpell(word, myRack)); }
  if (a !== c) differences.push({ letters, balance, bagRemaining, original: a, credited: c });
  const bids: Record<string, number> = {};
  for (const auctionType of ['Vickrey', 'FirstPrice']) {
    const input = { ...ctx, letter, auctionType };
    const run = (name: string, f: () => number) => timed ? time(name, f) : f();
    const x = run('original-bid', () => original.decideBid(input));
    const y = run('fast-bid', () => fast.decideBid(input));
    assert.equal(y, x);
    assert.ok(Number.isInteger(y) && y >= 0 && y <= balance);
    if (bagRemaining === 0) assert.equal(y, 0);
    bids[auctionType] = y;
  }
  assert.ok(bids.FirstPrice <= bids.Vickrey);
  assert.deepEqual([...myRack], before);
  assert.deepEqual(dictionary, dictionaryBefore);
  // Other matches and credit policy calls must not alter this context's deterministic draws.
  fast.decideBid({ ...ctx, myRack: rack('AEINR'), letter: 'X', bagRemaining: 17 });
  assert.equal(fast.decideBid({ ...ctx, letter, auctionType: 'Vickrey' }), bids.Vickrey);
  checked++;
}

if (!process.argv.includes('--full-only')) {
  for (const letters of ['', 'AEINR', 'CARTER', 'BALLON', 'BALLOON', 'QUIZ', 'AEIOU', 'JQXZ', 'TONES', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'])
    for (const balance of [0, 1, 9, 13, 40, 100, 300])
      for (const [bag, letter] of [[0, 'S'], [1, 'A'], [5, 'Q'], [6, 'F'], [20, 'X'], [67, 'E']] as const)
        check(small, letters, balance, bag, letter);
  for (const dictionary of [['A!', 'AT'], ['aT', 'AT'], ['ÅT', 'AT'], ['Q!', 'AT'], ['', 'A', 'AT']]) for (const letters of ['AQT', 'ABCDEFGHIJKLMNOPRSTUVWX']) {
    const ctx = { dictionary, myRack: rack(letters), myBalance: 100, bagRemaining: 0 };
    const a = original.chooseWord(ctx), b = fast.chooseWord(ctx);
    malformed.push({ dictionary, letters, original: a, fast: b, validOriginal: !a || /^[A-Z]{2,}$/.test(a) && canSpell(a, ctx.myRack), validFast: !b || /^[A-Z]{2,}$/.test(b) && canSpell(b, ctx.myRack) });
  }
}

if (!process.argv.includes('--small-only')) {
  const raw = fs.readFileSync('../spacetimedb/wordlist.txt', 'utf8').split('\n').map(w => w.trim().toUpperCase()).filter(w => w.length >= 2);
  const dictionary = [...raw].sort((a, b) => b.length - a.length);
  assert.ok(dictionary.every(w => /^[A-Z]{2,}$/.test(w)));
  time('cold-fast-index', () => fast.chooseWord({ dictionary, myRack: new Map() }));
  original.chooseWord({ dictionary, myRack: new Map() }); credited.chooseWord({ dictionary, myRack: new Map() });
  for (const [letters, balance, bag, letter] of [
    ['AEINR', 100, 67, 'F'], ['CARTER', 13, 30, 'S'], ['BALLOON', 40, 20, 'S'],
    ['JQXZ', 300, 67, 'A'], ['AEIOU', 9, 6, 'T'], ['AEINRST', 100, 5, 'Q'],
    ['AEINRST', 1, 1, 'X'], ['AEINRST', 100, 0, 'E'],
    ['BCDDFFGGHJKLLMNPQRSTVWXY', 100, 30, 'A'], ['BCDDFFGGHJKLLMNPQRSTVWXY', 300, 67, 'Z'],
    ['AAABCDEEEFGHIIKLMNORSTUV', 100, 20, 'Q'], ['AAABCDEEEFGHIIKLMNORSTUV', 300, 67, 'Z'],
  ] as const) check(dictionary, letters, balance, bag, letter, true);
  // Source-order and runner-order ties must agree separately, not just by score.
  for (const ordered of [raw, dictionary]) for (const letters of ['CATS', 'AEINRST', 'BALLOON'])
    check(ordered, letters, 40, 0, 'E');
}

const percentiles = Object.fromEntries(Object.entries(timings).map(([key, values]) => {
  values.sort((a, b) => a - b);
  return [key, { count: values.length, p50Ms: values[Math.floor(values.length * .5)], p95Ms: values[Math.floor(values.length * .95)], p99Ms: values[Math.floor(values.length * .99)], maxMs: values.at(-1), over100ms: values.filter(t => t >= 100).length }];
}));
const hashes = Object.fromEntries(['strategy-mc.ts', 'experiment-inventory-mc.ts', 'experiment-mc-fast.ts', 'experiment-mc-validation.ts'].map(f => [f, crypto.createHash('sha256').update(fs.readFileSync(`src/${f}`)).digest('hex')]));
const out = { checked, differences, malformed, timing: percentiles, hashes, settings: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('MC_'))) };
fs.writeFileSync(`runs/research-mc-validation${process.argv.includes('--small-only') ? '-small' : ''}.json`, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));

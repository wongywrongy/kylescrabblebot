import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import * as baseline from './baseline.js';
import * as current from './experiment-pacing-cap45.js';
import * as candidate from './strategy-candidate.js';
import { createPolicy, type Policy, type Variant } from './experiment-pacing-strategies.js';

const dictionary = fs.readFileSync('../spacetimedb/wordlist.txt', 'utf8').split('\n').map(w => w.trim().toUpperCase()).filter(w => w.length >= 2).sort((a, b) => b.length - a.length);
const ids = ['631', '634', '639', '643', '647', '651', '655', '664', '668', '672'];
const matches: any[] = [];
for (const dir of fs.readdirSync('runs')) {
  const root = path.join('runs', dir);
  if (!fs.statSync(root).isDirectory()) continue;
  const events = fs.readFileSync(path.join(root, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  for (const f of fs.readdirSync(root).filter(f => /^match-\d+\.json$/.test(f))) {
    const match = JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
    if (!ids.includes(match.matchId)) continue;
    const start = events.find(e => e.event === 'match_start' && e.data.match.id === match.matchId)?.data;
    assert.ok(start && Number(start.participant.score) === 0);
    matches.push({ match, start });
  }
}
matches.sort((a, b) => ids.indexOf(a.match.matchId) - ids.indexOf(b.match.matchId));
assert.deepEqual(matches.map(m => m.match.matchId), ids);

const testCtx = { dictionary: ['AT'], myRack: new Map([['A', 1]]), myBalance: 100, bagRemaining: 67, letter: 'T' };
const paced = createPolicy('pace');
const first = paced.decideBid(testCtx);
assert.equal(paced.multiplier!(), 0);
paced.observe!(0);
assert.ok(paced.decideBid(testCtx) >= first);
assert.ok(paced.multiplier!() < 0);
assert.equal(createPolicy('pace').multiplier!(), 0);
assert.equal(createPolicy('pace').decideBid({ ...testCtx, bagRemaining: 0 }), 0);
assert.equal(createPolicy('spend-3').decideBid({ ...testCtx, letter: 'Q' }), 0);
assert.equal(createPolicy('short').chooseWord({ dictionary: ['AT', 'QAT'], myRack: new Map([['A', 1], ['T', 1], ['Q', 1]]) }), 'QAT');

const times: Record<string, number[]> = {};
function run(name: string, factory: () => Policy) {
  times[name] = [];
  const results = matches.map(({ match, start }) => {
    const policy = factory(), rack = new Map<string, number>(Object.entries(start.rack));
    let score = 0, balance = Number(start.participant.balance), acquired = 0, spent = 0, scoreAt20 = 0;
    const played: string[] = [], muTrace: number[] = [];
    const bids = new Map<string, number>(match.topBids.map((a: any) => [a.auctionId, Number(a.topBid)]));
    const auctions = [...match.auctions].sort((a, b) => Number(BigInt(a.auctionId) - BigInt(b.auctionId)));
    for (let i = 0; i < auctions.length; i++) {
      const a = auctions[i], bagRemaining = auctions.length - i - 1;
      const ctx = { dictionary, myRack: rack, myBalance: balance, bagRemaining };
      let word: string | null;
      while (true) {
        const t = performance.now(); word = policy.chooseWord({ ...ctx, myBalance: balance });
        if (i > 0) times[name].push(performance.now() - t);
        if (!word) break;
        for (const c of word) { assert.ok((rack.get(c) ?? 0) > 0); rack.set(c, rack.get(c)! - 1); }
        const reward = current.wordScore(word); balance += reward; score += reward; played.push(word);
      }
      if (i === 20) scoreAt20 = score;
      const t = performance.now();
      const bid = policy.decideBid({ ...ctx, myBalance: balance, letter: a.letter, auctionType: match.match.auctionType.tag });
      if (i > 0) times[name].push(performance.now() - t);
      assert.ok(Number.isInteger(bid) && bid >= 0 && bid <= balance);
      if (bagRemaining === 0 && name !== 'legacy-baseline') assert.equal(bid, 0);
      const opponentBid = a.winnerBotId === match.botId ? Number(a.paid) : bids.get(a.auctionId)!;
      assert.ok(Number.isFinite(opponentBid));
      let price = 0;
      if (bid > 0 && (a.winnerBotId == null || bid > opponentBid)) {
        price = match.match.auctionType.tag === 'FirstPrice' ? bid : Math.max(1, opponentBid);
        assert.ok(price <= balance); balance -= price; spent += price; acquired++; rack.set(a.letter, (rack.get(a.letter) ?? 0) + 1);
      }
      policy.observe?.(price); muTrace.push(policy.multiplier?.() ?? 0);
    }
    return { match: match.matchId, score, spent, balance, acquired, unusedTiles: [...rack.values()].reduce((a, b) => a + b, 0), scoreAt20, played, meanWordLength: played.reduce((n, w) => n + w.length, 0) / Math.max(1, played.length), muTrace };
  });
  const mean: Record<string, number> = {};
  for (const key of ['score', 'spent', 'balance', 'acquired', 'unusedTiles', 'scoreAt20', 'meanWordLength'] as const) mean[key] = results.reduce((n, r) => n + r[key], 0) / results.length;
  return { name, mean, results };
}
const variants: Variant[] = ['pace', 'pace-no-ramp', 'spend-1.5', 'spend-2', 'spend-3', 'frontload', 'short', 'hold6', 'short-unpaced', 'hold6-unpaced', 'completion-unpaced'];
const results = [run('legacy-baseline', () => baseline), run('current-cap45', () => current), run('uncapped', () => candidate), ...variants.map(v => run(v, () => createPolicy(v)))];
const hypotheses: Record<Variant, string> = {
  pace: 'A: prior-result dual multiplier replaces the cash reserve; retain the existing usable-tile endgame ramp.',
  'pace-no-ramp': 'A literal multiplier across all usable auctions; no existing endgame ramp.',
  'spend-1.5': 'B: bid 1.5 times balance/auctionsRemaining; skip uncompleted J/Q/X/Z.',
  'spend-2': 'B: bid 2 times balance/auctionsRemaining; skip uncompleted J/Q/X/Z.',
  'spend-3': 'B: bid 3 times balance/auctionsRemaining; skip uncompleted J/Q/X/Z.',
  frontload: 'C: first 20 auctions bid (0.6*100/20)*(value/16), then A. Fixed meanValue=16 approximates the unchanged common-letter base; no fitted parameters.',
  short: 'E: A bids; immediately play the highest-scoring playable word scoring at least 6.',
  hold6: 'F: completion-only bids with A pacing; play only 6+ letters until last five auctions.',
  'short-unpaced': 'Matched control: E immediate word policy with uncapped bidding and no pacing.',
  'hold6-unpaced': 'Matched control: F word policy with uncapped bidding and no pacing or completion-only restriction.',
  'completion-unpaced': 'Matched control: completion-only bids, existing hold policy, no pacing.',
};
const comparisons = results.map(result => ({
  name: result.name,
  decision: ['legacy-baseline', 'current-cap45', 'uncapped'].includes(result.name) ? 'control' : 'reject for live shortlist: lower diagnostic score than uncapped',
  source: ['legacy-baseline', 'current-cap45', 'uncapped'].includes(result.name) ? result.name : `src/experiment-pacing-strategies.ts#createPolicy(${result.name})`,
  hypothesis: hypotheses[result.name as Variant],
  paired: ['current-cap45', 'uncapped'].map(controlName => {
    const control = results.find(r => r.name === controlName)!;
    const deltas = result.results.map((r, i) => r.score - control.results[i].score);
    return { control: controlName, meanScoreDelta: deltas.reduce((a, b) => a + b, 0) / deltas.length, improved: deltas.filter(n => n > 0).length, tied: deltas.filter(n => n === 0).length, worse: deltas.filter(n => n < 0).length };
  }),
}));
// Fixed sensitivity grid, selected only from the other six matches in each fold.
const grid = [0.005, 0.01, 0.02, 0.04, 0.08].map(e => ({ epsilon: e, ...run(`pace-eps-${e}`, () => createPolicy('pace', e)) }));
const loo = matches.map(({ match }, i) => {
  const best = [...grid].sort((a, b) => b.results.reduce((s, r, j) => s + (i === j ? 0 : r.score), 0) - a.results.reduce((s, r, j) => s + (i === j ? 0 : r.score), 0) || a.epsilon - b.epsilon)[0];
  return { match: match.matchId, epsilon: best.epsilon, score: best.results[i].score };
});
const chrono = [...grid].sort((a, b) => b.results.slice(0, 7).reduce((s, r) => s + r.score, 0) - a.results.slice(0, 7).reduce((s, r) => s + r.score, 0) || a.epsilon - b.epsilon)[0];
const timing = Object.fromEntries(Object.entries(times).map(([k, v]) => { v.sort((a, b) => a - b); return [k, { maxMs: v.at(-1), p95Ms: v[Math.floor(v.length * 0.95)] }]; }));
for (const value of Object.values(timing)) assert.ok(value.maxMs! < 100);
const hashes = Object.fromEntries(['baseline.ts', 'experiment-pacing-cap45.ts', 'strategy-candidate.ts', 'experiment-pacing-strategies.ts', 'experiment-pacing-replay.ts'].map(f => [f, crypto.createHash('sha256').update(fs.readFileSync(`src/${f}`)).digest('hex')]));
const output = { diagnostic: 'Frozen opponent bids and tile order; counterfactual opponent cash/racks are not reconstructed. Equal bids conservatively lose. No live deployment or connections.', frozenMatches: ids, hashes, results, comparisons, sensitivity: grid, leaveOneMatchOut: { results: loo, mean: loo.reduce((s, r) => s + r.score, 0) / loo.length }, chronological: { train: ids.slice(0, 7), test: ids.slice(7), epsilon: chrono.epsilon, testMean: chrono.results.slice(7).reduce((s, r) => s + r.score, 0) / 3 }, timing };
fs.writeFileSync('runs/research-pacing-results.json', JSON.stringify(output, null, 2));
console.log(JSON.stringify({ results: results.map(({ name, mean }) => ({ name, ...mean })), sensitivity: grid.map(({ epsilon, mean }) => ({ epsilon, score: mean.score })), loo: output.leaveOneMatchOut, chronological: output.chronological, timing }, null, 2));

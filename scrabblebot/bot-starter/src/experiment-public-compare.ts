// Replay policies against frozen opponent bids from runs/public-history.json.
// Usage: node --import tsx src/sim-public.ts src/strategy.ts [more policies...] [--seeds N] [--min 400]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { wordScore } from './strategy.js';

const args = process.argv.slice(2);
const flag = (n: string, d: number) => { const i = args.indexOf(n); return i >= 0 ? Number(args[i + 1]) : d; };
const SEEDS = flag('--seeds', 1), MIN_ID = flag('--min', 400);
const files = args.filter(a => a.endsWith('.ts'));
const dictionary = fs.readFileSync('../spacetimedb/wordlist.txt', 'utf8').split('\n').map(w => w.trim().toUpperCase()).filter(w => w.length >= 2).sort((a, b) => b.length - a.length);
const hist = JSON.parse(fs.readFileSync('runs/public-history.json', 'utf8'));
const sim = new Set(hist.bots.filter((b: any) => b.isSimulated).map((b: any) => b.id));
const parts = new Map<string, any[]>();
for (const p of hist.participants) (parts.get(p.matchId) ?? parts.set(p.matchId, []).get(p.matchId)!).push(p);
const topBid = new Map<string, number>(hist.topBids.map((t: any) => [t.auctionId, Number(t.topBid)]));
const auctionsBy = new Map<string, any[]>();
for (const a of hist.auctions) (auctionsBy.get(a.matchId) ?? auctionsBy.set(a.matchId, []).get(a.matchId)!).push(a);
const matches = hist.matches.filter((m: any) => m.status.tag === 'Ended' && m.auctionType.tag === 'Vickrey' && Number(m.id) >= MIN_ID
  && (parts.get(m.id) ?? []).filter(p => !sim.has(p.botId)).length >= 4)
  .map((m: any) => ({ id: m.id, auctions: auctionsBy.get(m.id)!.sort((a, b) => Number(BigInt(a.auctionId) - BigInt(b.auctionId))), scores: parts.get(m.id)!.map(p => Number(p.score)).sort((a, b) => b - a) }));
const BAG = 'A9B2C2D4E12F2G3H2I9J1K1L4M2N6O8P2Q1R6S4T6U4V2W2X1Y2Z1'.match(/[A-Z]\d+/g)!.flatMap(x => x[0].repeat(Number(x.slice(1))).split(''));
function rng(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }

const hash = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const hashes = Object.fromEntries([...files, 'src/sim-public.ts', 'src/experiment-public-compare.ts', 'src/experiment-face-policy.ts', 'runs/public-history.json'].map(f => [f, hash(f)]));
const results: any[] = [];
for (const file of files) {
  const policy = await import(path.resolve(file));
  const t0 = performance.now();
  const rows: any[] = [];
  let maxWarmMs = 0;
  const timings: number[] = [];
  let slowest: any;
  const timed = (started: number, i: number, kind: string, rack: Map<string, number>, bagRemaining: number) => {
    if (i === 0) return;
    const elapsed = performance.now() - started;
    timings.push(elapsed);
    if (elapsed > maxWarmMs) { maxWarmMs = elapsed; slowest = { kind, rack: Object.fromEntries(rack), bagRemaining }; }
  };
  for (const m of matches) for (let seed = 0; seed < SEEDS; seed++) {
    const r = rng(Number(m.id) * 1000 + seed);
    // Starting rack: 5 tiles drawn from the bag minus the letters that were auctioned.
    const pool = [...BAG]; for (const a of m.auctions) { const i = pool.indexOf(a.letter); if (i >= 0) pool.splice(i, 1); }
    const rack = new Map<string, number>();
    for (let n = 0; n < 5 && pool.length; n++) { const i = Math.floor(r() * pool.length); const c = pool.splice(i, 1)[0]; rack.set(c, (rack.get(c) ?? 0) + 1); }
    let score = 0, balance = 100, spent = 0, acquired = 0; const played: string[] = [];
    for (let i = 0; i < m.auctions.length; i++) {
      const a = m.auctions[i], bagRemaining = m.auctions.length - i - 1;
      let word: string | null;
      while (true) {
        const started = performance.now();
        word = policy.chooseWord({ dictionary, myRack: rack, myBalance: balance, bagRemaining });
        timed(started, i, 'chooseWord', rack, bagRemaining);
        if (!word) break;
        for (const c of word) { if ((rack.get(c) ?? 0) <= 0) throw new Error(`${file}: ${word} not in rack`); rack.set(c, rack.get(c)! - 1); }
        const reward = wordScore(word); balance += reward; score += reward; played.push(word);
      }
      const started = performance.now();
      const bid = policy.decideBid({ dictionary, myRack: rack, myBalance: balance, bagRemaining, letter: a.letter, auctionType: 'Vickrey' });
      timed(started, i, 'decideBid', rack, bagRemaining);
      if (bagRemaining === 0) assert.equal(bid, 0);
      if (!Number.isInteger(bid) || bid < 0 || bid > balance) throw new Error(`${file}: bad bid ${bid} balance ${balance}`);
      const opp = topBid.get(a.auctionId) ?? 0;
      if (bid > 0 && bid > opp) { const price = Math.max(1, opp); balance -= price; spent += price; acquired++; rack.set(a.letter, (rack.get(a.letter) ?? 0) + 1); }
    }
    const place = 1 + m.scores.filter((s: number) => s > score).length;
    assert.equal(balance, 100 + score - spent);
    rows.push({ match: m.id, seed, score, place, win: place === 1 ? 1 : 0, spent, acquired, balance, words: played.length, long: played.filter(w => w.length >= 7).length, tiles: [...rack.values()].reduce((a, b) => a + b, 0) });
  }
  const mean = (k: string) => rows.reduce((n, r) => n + r[k], 0) / rows.length;
  const out: Record<string, number> = {};
  for (const k of ['score', 'win', 'place', 'spent', 'acquired', 'balance', 'words', 'long', 'tiles']) out[k] = +mean(k).toFixed(2);
  console.log(path.basename(file).padEnd(28), JSON.stringify(out), `${rows.length} games, ${((performance.now() - t0) / rows.length).toFixed(1)}ms/game`);
  timings.sort((a, b) => a - b);
  results.push({ file, mean: out, rows, timing: { maxWarmMs, p95Ms: timings[Math.floor(timings.length * 0.95)], p99Ms: timings[Math.floor(timings.length * 0.99)], over100ms: timings.filter(t => t >= 100).length, slowest } });
  fs.writeFileSync('runs/research-public-simulation.json', JSON.stringify({ status: 'partial', hashes, results }, null, 2));
}
const current = results[0];
const paired = results.slice(1).map(policy => {
  const deltas = policy.rows.map((r: any, i: number) => { assert.equal(r.match, current.rows[i].match); assert.equal(r.seed, current.rows[i].seed); return r.score - current.rows[i].score; });
  const byMatch = new Map<string, number[]>();
  policy.rows.forEach((r: any, i: number) => { const values = byMatch.get(r.match) ?? []; values.push(deltas[i]); byMatch.set(r.match, values); });
  const clusters = [...byMatch].map(([match, values]) => ({ match, delta: values.reduce((a, b) => a + b, 0) / values.length }));
  const mean = clusters.reduce((s, r) => s + r.delta, 0) / clusters.length;
  const se = Math.sqrt(clusters.reduce((s, r) => s + (r.delta - mean) ** 2, 0) / (clusters.length - 1) / clusters.length);
  const sliceMean = (lo: number, hi: number) => { const slice = clusters.filter(r => Number(r.match) >= lo && Number(r.match) <= hi); return slice.reduce((s, r) => s + r.delta, 0) / slice.length; };
  return { file: policy.file, meanScoreDelta: mean, approximate95ClusterInterval: [mean - 1.96 * se, mean + 1.96 * se], betterMatchMeans: clusters.filter(r => r.delta > 0).length, tiedMatchMeans: clusters.filter(r => r.delta === 0).length, worseMatchMeans: clusters.filter(r => r.delta < 0).length, early600to649: sliceMean(600, 649), late650to698: sliceMean(650, 698), clusters };
});
for (const [file, before] of Object.entries(hashes)) assert.equal(hash(file), before, `${file} changed during experiment`);
const out = { diagnostic: 'Synthetic fifth-tile rack samples from bag minus all future auction draws; policy never receives future draws or bids. Frozen opponents retain original racks, budgets and scores; effectively adds a seventh player. Equal bids lose. Results are diagnostic, not causal or live placement estimates.', seeds: SEEDS, minMatchId: MIN_ID, matches: matches.map((m: any) => m.id), hashes, results, paired };
fs.writeFileSync('runs/research-public-simulation.json', JSON.stringify(out, null, 2));
console.log('paired', JSON.stringify(paired.map(({ clusters, ...p }) => p)));

// Public simulation with the same starting racks and market rules as sim-public.ts, plus paired rows and timing.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { wordScore, LETTER_VALUE } from './experiment-mc-fast.js';
import { remainingPool } from './remaining-pool.js';

const [policyFile, outputFile, historyFile = 'runs/public-history.json', minId = '600', maxId = '698'] = process.argv.slice(2);
assert.ok(policyFile && outputFile);
const policy = await import(path.resolve(policyFile));
const historyText = fs.readFileSync(historyFile, 'utf8'), history = JSON.parse(historyText);
const dictionaryText = fs.readFileSync('../spacetimedb/wordlist.txt', 'utf8');
const dictionary = dictionaryText.split('\n').map(w => w.trim().toUpperCase()).filter(w => w.length >= 2).sort((a, b) => b.length - a.length);
const simulated = new Set(history.bots.filter((b: any) => b.isSimulated).map((b: any) => b.id));
const participants = new Map<string, any[]>(), auctions = new Map<string, any[]>();
for (const p of history.participants) (participants.get(p.matchId) ?? participants.set(p.matchId, []).get(p.matchId)!).push(p);
for (const a of history.auctions) (auctions.get(a.matchId) ?? auctions.set(a.matchId, []).get(a.matchId)!).push(a);
const topBid = new Map<string, number>(history.topBids.map((a: any) => [a.auctionId, Number(a.topBid)]));
const matches: any[] = history.matches.filter((m: any) => Number(m.id) >= Number(minId) && Number(m.id) <= Number(maxId) && m.status.tag === 'Ended' && m.auctionType.tag === 'Vickrey' && (participants.get(m.id) ?? []).filter(p => !simulated.has(p.botId)).length >= 4).sort((a: any, b: any) => Number(a.id) - Number(b.id));
assert.ok(matches.length > 0);
const bag = 'A9B2C2D4E12F2G3H2I9J1K1L4M2N6O8P2Q1R6S4T6U4V2W2X1Y2Z1'.match(/[A-Z]\d+/g)!.flatMap(x => [...x[0].repeat(Number(x.slice(1)))]);
function rng(seed: number) { let state = seed >>> 0; return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; }; }
const started = performance.now();
policy.chooseWord({ dictionary, myRack: new Map() });
const coldIndexMs = performance.now() - started;
const wordTimes: number[] = [], bidTimes: number[] = [];
const results = matches.map((match: any) => {
  const market = [...auctions.get(match.id)!].sort((a, b) => Number(BigInt(a.auctionId) - BigInt(b.auctionId)));
  const pool = [...bag], random = rng(Number(match.id) * 1000), rack = new Map<string, number>();
  for (const a of market) { const i = pool.indexOf(a.letter); if (i >= 0) pool.splice(i, 1); }
  for (let n = 0; n < 5 && pool.length; n++) { const c = pool.splice(Math.floor(random() * pool.length), 1)[0]; rack.set(c, (rack.get(c) ?? 0) + 1); }
  const initialRack = Object.fromEntries(rack);
  let score = 0, balance = 100, spent = 0, acquired = 0, usedFace = 0, usedTiles = 0, wonFace = 0, firstWordRound = 68, cashPoorAuctions = 0;
  const played: string[] = [], won: string[] = [];
  for (let i = 0; i < market.length; i++) {
    const a = market[i], bagRemaining = market.length - i - 1;
    const remainingLetters = policy.config?.observedTiles ? remainingPool(new Map(Object.entries(initialRack)), market.slice(0, i + 1).map((draw: any) => draw.letter), bagRemaining, 25) : undefined;
    if (policy.config?.observedTiles) assert.ok(remainingLetters);
    while (true) {
      const start = performance.now(), word = policy.chooseWord({ dictionary, myRack: rack, myBalance: balance, bagRemaining, remainingLetters });
      wordTimes.push(performance.now() - start);
      if (!word) break;
      if (!played.length) firstWordRound = i + 1;
      for (const c of word) { assert.ok((rack.get(c) ?? 0) > 0); rack.set(c, rack.get(c)! - 1); usedFace += LETTER_VALUE[c]; usedTiles++; }
      const reward = wordScore(word); score += reward; balance += reward; played.push(word);
    }
    if (balance < 10) cashPoorAuctions++;
    const start = performance.now(), bid = policy.decideBid({ dictionary, myRack: rack, myBalance: balance, bagRemaining, remainingLetters, letter: a.letter, auctionType: 'Vickrey' });
    bidTimes.push(performance.now() - start);
    assert.ok(Number.isInteger(bid) && bid >= 0 && bid <= balance);
    if (bagRemaining === 0) assert.equal(bid, 0);
    const opponentBid = topBid.get(a.auctionId) ?? 0;
    if (bid > 0 && bid > opponentBid) { const price = Math.max(1, opponentBid); assert.ok(price <= balance); spent += price; balance -= price; acquired++; wonFace += LETTER_VALUE[a.letter]; won.push(a.letter); rack.set(a.letter, (rack.get(a.letter) ?? 0) + 1); }
  }
  const scores = participants.get(match.id)!.map(p => Number(p.score)), place = 1 + scores.filter(s => s > score).length;
  return { match: match.id, score, place, win: Number(place === 1), top3: Number(place <= 3), balance, spent, acquired, firstWordRound, cashPoorAuctions, wonFace, usedFace, usedTiles, words: played.length, longWords: played.filter(w => w.length >= 7).length, unusedTiles: [...rack.values()].reduce((a, b) => a + b, 0), played, won: won.join(''), initialRack };
});
function summary(rows: typeof results) {
  const fields = ['score', 'place', 'win', 'top3', 'balance', 'spent', 'acquired', 'firstWordRound', 'cashPoorAuctions', 'words', 'longWords', 'unusedTiles'] as const;
  const means = Object.fromEntries(fields.map(field => [field, rows.reduce((s, r) => s + r[field], 0) / rows.length]));
  const scores = rows.map(r => r.score).sort((a, b) => a - b), sum = (field: 'wonFace' | 'acquired' | 'usedFace' | 'usedTiles' | 'score' | 'words') => rows.reduce((s, r) => s + r[field], 0);
  const middle = Math.floor(scores.length / 2), medianScore = scores.length % 2 ? scores[middle] : (scores[middle - 1] + scores[middle]) / 2;
  return { count: rows.length, ...means, medianScore, minScore: scores[0], scores100: scores.filter(s => s >= 100).length, meanWonFace: sum('wonFace') / Math.max(1, sum('acquired')), meanUsedFace: sum('usedFace') / Math.max(1, sum('usedTiles')), rewardPerUsedTile: sum('score') / Math.max(1, sum('usedTiles')), meanWordBase: sum('usedFace') / Math.max(1, sum('words')) };
}
function timings(values: number[]) {
  values.sort((a, b) => a - b);
  return { count: values.length, p50Ms: values[Math.floor(values.length * 0.5)], p95Ms: values[Math.floor(values.length * 0.95)], p99Ms: values[Math.floor(values.length * 0.99)], maxMs: values.at(-1), over100ms: values.filter(t => t >= 100).length };
}
const config = Object.fromEntries(Object.entries({ MC_K: 24, MC_LAMBDA: 0.5, MC_PRICE: 13, MC_WIN: 0.25, MC_END: 5, MC_PACE: 0.5, MC_PACE_MAX: 2.5 }).map(([key, fallback]) => [key, Number(process.env[key] ?? fallback)]));
const hash = (text: string) => crypto.createHash('sha256').update(text).digest('hex');
const sourceHashes = Object.fromEntries([...new Set([policyFile, 'src/experiment-mc-fast.ts', 'src/experiment-inventory-public.ts', 'src/remaining-pool.ts'])].map(file => [file, hash(fs.readFileSync(file, 'utf8'))]));
const half = Math.floor(results.length / 2);
const output = { diagnostic: 'Fixed recorded rival bids/order; synthetic starting racks from bag minus auctioned letters, seed matchId*1000; extra seventh bot, fixed opponent scores and no market reactions. Diagnostic ranks/wins are not causal live performance.', policy: policyFile, policyConfig: policy.config, historyFile, minId: Number(minId), maxId: Number(maxId), config, configHash: hash(JSON.stringify(config)), sourceHashes, historyHash: hash(historyText), dictionaryHash: hash(dictionaryText), all: summary(results), firstHalf: summary(results.slice(0, half)), secondHalf: summary(results.slice(half)), timing: { coldIndexMs, word: timings(wordTimes), bid: timings(bidTimes), wallMs: performance.now() - started }, results };
fs.writeFileSync(outputFile, JSON.stringify(output, null, 2));
console.log(JSON.stringify({ policy: output.policy, config, all: output.all, firstHalf: output.firstHalf, secondHalf: output.secondHalf, timing: output.timing }, null, 2));

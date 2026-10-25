import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import * as mc from './strategy-montecarlo.js';
import { remainingPool } from './remaining-pool.js';
import { knownInitialTiles, type InitialObservation } from './experiment-known-initial.js';

const fileHash = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const inputs = ['src/strategy-montecarlo.ts', 'src/remaining-pool.ts', 'src/experiment-known-initial.ts', 'src/experiment-known-initial-replay.ts', '../spacetimedb/wordlist.txt', 'runs/research-known-initial.json'];
const hashes = Object.fromEntries(inputs.map(f => [f, fileHash(f)]));
const frozen = JSON.parse(fs.readFileSync('runs/research-known-initial.json', 'utf8'));
assert.deepEqual(mc.config, { MC_K: 24, MC_LAMBDA: 0.5, MC_PRICE: 13, MC_WIN: 0.25, MC_END: 5, MC_PACE: 0.5, MC_PACE_MAX: 2.5 });
const dictionary = fs.readFileSync('../spacetimedb/wordlist.txt', 'utf8').split('\n').map(w => w.trim().toUpperCase()).filter(w => w.length >= 2).sort((a, b) => b.length - a.length);
const cold = performance.now(); mc.chooseWord({ dictionary, myRack: new Map() });
const coldIndexMs = performance.now() - cold;
const micros = (v: any) => BigInt(v.__timestamp_micros_since_unix_epoch__);
const timings: Record<string, number[]> = {};
const timed = <T>(name: string, run: () => T): T => { const start = performance.now(), result = run(); (timings[name] ??= []).push(performance.now() - start); return result; };
const results: any[] = [];

for (const source of frozen.sources) {
  const file = path.join('runs', source.run, `match-${source.match}.json`);
  assert.equal(fileHash(file), source.fileHash);
  const m = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(m.match.auctionType.tag, 'Vickrey');
  const auctions = [...m.auctions].sort((a, b) => Number(BigInt(a.auctionId) - BigInt(b.auctionId)));
  const initial = new Map<string, number>(Object.entries(source.ownInitial));
  assert.equal([...initial.values()].reduce((a, b) => a + b, 0), 5);
  const opponents = m.participants.filter((p: any) => p.botId !== m.botId).map((p: any) => p.botId);
  assert.equal(opponents.length, 5);
  const observations: InitialObservation[] = [
    ...auctions.filter(a => a.winnerBotId && a.winnerBotId !== m.botId).map(a => ({ at: micros(a.closedAt), botId: a.winnerBotId, kind: 'award' as const, letter: a.letter })),
    ...m.words.filter((w: any) => w.botId !== m.botId).map((w: any) => ({ at: micros(w.playedAt), botId: w.botId, kind: 'word' as const, word: w.word })),
  ];
  const top = new Map<string, number>(m.topBids.map((a: any) => [a.auctionId, Number(a.topBid)]));
  const frames = auctions.map((auction, i) => {
    const opening = i ? micros(auctions[i - 1].closedAt) : micros(m.match.startedAt);
    const closing = micros(auction.closedAt), bagRemaining = auctions.length - i - 1;
    const baseline = remainingPool(initial, auctions.slice(0, i + 1).map(a => a.letter), bagRemaining, 25)!;
    assert.ok(baseline);
    const points = [...new Set([opening, ...observations.filter(e => e.kind === 'word' && e.at > opening && e.at < closing).map(e => e.at)])].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
    const stages = points.map(cutoff => {
      const inferred = timed('inference', () => knownInitialTiles(observations, opponents, cutoff));
      assert.ok(inferred);
      const refined = new Map(baseline);
      let known = 0;
      for (const counts of inferred.values()) for (const [c, n] of counts) { known += n; refined.set(c, refined.get(c)! - n); }
      assert.ok([...refined.values()].every(n => n >= 0));
      assert.equal([...refined.values()].reduce((a, b) => a + b, 0), bagRemaining + 25 - known);
      return { cutoff: cutoff.toString(), refined, known };
    });
    const opponentBid = auction.winnerBotId === m.botId ? Number(auction.paid) : top.get(auction.auctionId)!;
    assert.ok(Number.isFinite(opponentBid));
    return { auction, bagRemaining, baseline, stages, opponentBid };
  });
  const run = (name: 'baseline' | 'refined') => {
    const rack = new Map(initial), played: any[] = [], trace: any[] = [];
    let balance = 100, score = 0, spent = 0, acquired = 0;
    const checkpoints: Record<string, any> = {};
    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i];
      let bid = 0;
      for (const stage of frame.stages) {
        const remainingLetters = name === 'baseline' ? frame.baseline : stage.refined;
        while (true) {
          const word = timed(`${name}-word`, () => mc.chooseWord({ dictionary, myRack: rack, myBalance: balance, bagRemaining: frame.bagRemaining, remainingLetters }));
          if (!word) break;
          for (const c of word) { assert.ok((rack.get(c) ?? 0) > 0); rack.set(c, rack.get(c)! - 1); }
          const reward = mc.wordScore(word); score += reward; balance += reward;
          played.push({ word, reward, beforeAuction: frame.auction.auctionId, cutoffMicros: stage.cutoff });
        }
        bid = timed(`${name}-bid`, () => mc.decideBid({ dictionary, myRack: rack, myBalance: balance, bagRemaining: frame.bagRemaining, remainingLetters, letter: frame.auction.letter, auctionType: 'Vickrey' }));
        assert.ok(Number.isInteger(bid) && bid >= 0 && bid <= balance);
        if (frame.bagRemaining === 0) assert.equal(bid, 0);
      }
      const won = bid > 0 && bid > frame.opponentBid;
      const paid = won ? Math.max(1, frame.opponentBid) : 0;
      assert.ok(paid <= balance);
      if (won) { balance -= paid; spent += paid; acquired++; rack.set(frame.auction.letter, (rack.get(frame.auction.letter) ?? 0) + 1); }
      trace.push({ auction: frame.auction.auctionId, letter: frame.auction.letter, bagRemaining: frame.bagRemaining, bid, opponentBid: frame.opponentBid, won, paid, score, balance, knownInitial: frame.stages.at(-1)!.known });
      if ([20, 40, 60].includes(i + 1)) checkpoints[String(i + 1)] = { score, balance, spent, acquired };
    }
    const unusedTiles = [...rack.values()].reduce((a, b) => a + b, 0);
    assert.equal(balance, 100 + score - spent);
    assert.equal(5 + acquired, played.reduce((sum, w) => sum + w.word.length, 0) + unusedTiles);
    const historicalOtherScores = m.participants.filter((p: any) => p.botId !== m.botId).map((p: any) => Number(p.score));
    const diagnosticPlace = 1 + historicalOtherScores.filter((s: number) => s > score).length;
    return { score, balance, spent, acquired, unusedTiles, words: played.length, longWords: played.filter(w => w.word.length >= 7).length, meanWordLength: played.reduce((sum, w) => sum + w.word.length, 0) / Math.max(1, played.length), diagnosticPlace, diagnosticWin: diagnosticPlace === 1 ? 1 : 0, checkpoints, played, rack: Object.fromEntries([...rack].filter(([, n]) => n)), trace };
  };
  const baseline = run('baseline'), refined = run('refined');
  results.push({ match: m.matchId, sourceRun: source.run, baseline, refined, scoreDelta: refined.score - baseline.score, spendDelta: refined.spent - baseline.spent });
}
const metrics = ['score', 'spent', 'balance', 'acquired', 'unusedTiles', 'words', 'longWords', 'meanWordLength', 'diagnosticPlace', 'diagnosticWin'];
const means = Object.fromEntries(['baseline', 'refined'].map(name => [name, Object.fromEntries(metrics.map(k => [k, results.reduce((sum, r) => sum + r[name][k], 0) / results.length]))]));
const delta = results.reduce((s, r) => s + r.scoreDelta, 0) / results.length;
const se = Math.sqrt(results.reduce((s, r) => s + (r.scoreDelta - delta) ** 2, 0) / (results.length - 1) / results.length);
const slices = Object.fromEntries(([['oldest30', results.slice(0, 30)], ['latest15', results.slice(30)]] as const).map(([name, rr]) => [name, { matches: rr.length, meanScoreDelta: rr.reduce((s: number, r: any) => s + r.scoreDelta, 0) / rr.length }]));
const paired = { meanScoreDelta: delta, approximate95MatchInterval: [delta - 1.96 * se, delta + 1.96 * se], improved: results.filter(r => r.scoreDelta > 0).length, tied: results.filter(r => r.scoreDelta === 0).length, worse: results.filter(r => r.scoreDelta < 0).length, slices };
const timing = Object.fromEntries(Object.entries(timings).map(([key, v]) => { v.sort((a, b) => a - b); return [key, { count: v.length, p50Ms: v[Math.floor(v.length * .5)], p95Ms: v[Math.floor(v.length * .95)], p99Ms: v[Math.floor(v.length * .99)], maxMs: v.at(-1), over100ms: v.filter(t => t >= 100).length }]; }));
for (const file of inputs) assert.equal(fileHash(file), hashes[file]);
const out = { diagnostic: 'Paired replay replacing our recorded seat with the actual five-tile initial rack, five original opponents, fixed auction order and fixed opponent bids. Opponent public awards/words/budgets/scores remain factual and DO NOT react to changed purchases; inference remains tied to each factual prefix. Immediate own-word play/requotation occurs at offers and factual rival word events; network and retry delays are omitted. Vickrey opponent threshold is paid when we originally won, archived highest otherwise; equal bids conservatively lose. Diagnostic score/place changes are not causal live-performance estimates. No tuning; unchanged deterministic MC seeds/config.', config: mc.config, matches: results.map(r => r.match), hashes, coldIndexMs, means, paired, timing, results };
fs.writeFileSync('runs/research-known-initial-replay.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify({ means, paired, timing, coldIndexMs }, null, 2));

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import * as mc from './strategy-montecarlo.js';
import { remainingPool } from './remaining-pool.js';
import { knownInitialTiles, type InitialObservation } from './experiment-known-initial.js';

const hash = (text: string) => crypto.createHash('sha256').update(text).digest('hex');
const fileHash = (file: string) => hash(fs.readFileSync(file, 'utf8'));
const inputs = ['src/strategy-montecarlo.ts', 'src/remaining-pool.ts', 'src/experiment-known-initial.ts', 'src/experiment-known-initial-shadow.ts', '../spacetimedb/wordlist.txt'];
const hashes = Object.fromEntries(inputs.map(file => [file, fileHash(file)]));
const frozen = JSON.parse(fs.readFileSync('runs/research-known-initial.json', 'utf8'));
assert.deepEqual(mc.config, { MC_K: 24, MC_LAMBDA: 0.5, MC_PRICE: 13, MC_WIN: 0.25, MC_END: 5, MC_PACE: 0.5, MC_PACE_MAX: 2.5 });
const dictionary = fs.readFileSync('../spacetimedb/wordlist.txt', 'utf8').split('\n').map(w => w.trim().toUpperCase()).filter(w => w.length >= 2).sort((a, b) => b.length - a.length);
const warm = performance.now(); mc.chooseWord({ dictionary, myRack: new Map() });
const coldIndexMs = performance.now() - warm;
const micros = (t: any) => BigInt(t.__timestamp_micros_since_unix_epoch__);
const times: Record<string, number[]> = {};
const timed = <T>(name: string, run: () => T): T => { const t = performance.now(), result = run(); (times[name] ??= []).push(performance.now() - t); return result; };
const rows: any[] = [], logs: any[] = [];
for (const run of [...new Set<string>(frozen.sources.map((s: any) => s.run))]) {
  const root = path.join('runs', run), raw = fs.readFileSync(path.join(root, 'events.jsonl'), 'utf8');
  const events = raw.split('\n').filter(Boolean).map(line => JSON.parse(line));
  logs.push({ run, bytesAtRead: raw.length, hashAtRead: hash(raw) });
  for (const s of frozen.sources.filter((s: any) => s.run === run)) {
    const file = path.join(root, `match-${s.match}.json`);
    assert.equal(fileHash(file), s.fileHash);
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    const auctions = [...m.auctions].sort((a, b) => Number(BigInt(a.auctionId) - BigInt(b.auctionId)));
    const initial = new Map<string, number>(Object.entries(s.ownInitial));
    const opponents = m.participants.filter((p: any) => p.botId !== m.botId).map((p: any) => p.botId);
    const observations: InitialObservation[] = [
      ...auctions.filter(a => a.winnerBotId && a.winnerBotId !== m.botId).map(a => ({ at: micros(a.closedAt), kind: 'award' as const, botId: a.winnerBotId, letter: a.letter })),
      ...m.words.filter((w: any) => w.botId !== m.botId).map((w: any) => ({ at: micros(w.playedAt), kind: 'word' as const, botId: w.botId, word: w.word })),
    ];
    // Full future draws validate the bound only; this oracle never reaches a quote.
    const actualInitialOracle = remainingPool(initial, auctions.map(a => a.letter), 0, 25)!;
    let knownWordCutoff = micros(m.match.startedAt);
    for (const e of events) {
      if (e.data.matchId !== m.matchId) continue;
      if (e.event === 'word_play') { const at = micros(e.data.playedAt); if (at > knownWordCutoff) knownWordCutoff = at; }
      if (e.event !== 'bid') continue;
      const b = e.data, at = auctions.findIndex(a => a.auctionId === b.auctionId);
      assert.ok(at >= 0);
      const opening = at ? micros(auctions[at - 1].closedAt) : micros(m.match.startedAt);
      const cutoff = knownWordCutoff > opening ? knownWordCutoff : opening;
      assert.ok(cutoff < micros(auctions[at].closedAt));
      const bagRemaining = auctions.length - at - 1;
      const baseline = remainingPool(initial, auctions.slice(0, at + 1).map(a => a.letter), bagRemaining, 25)!;
      assert.ok(baseline);
      const inferred = timed('inference', () => knownInitialTiles(observations, opponents, cutoff));
      assert.ok(inferred, `invalid prefix ${m.matchId}/${b.auctionId}`);
      const refined = new Map(baseline), aggregate = new Map<string, number>();
      for (const counts of inferred.values()) for (const [c, n] of counts) {
        aggregate.set(c, (aggregate.get(c) ?? 0) + n); refined.set(c, refined.get(c)! - n);
      }
      const knownCount = [...aggregate.values()].reduce((a, b) => a + b, 0);
      for (const [c, n] of aggregate) assert.ok(n <= actualInitialOracle.get(c)!);
      assert.ok([...refined.values()].every(n => n >= 0));
      assert.equal([...refined.values()].reduce((a, b) => a + b, 0), bagRemaining + 25 - knownCount);
      const rack = new Map<string, number>(Object.entries(b.rack));
      const ctx = { dictionary, myRack: rack, myBalance: Number(b.balance), bagRemaining, letter: b.letter, auctionType: m.match.auctionType.tag };
      const outputs: Record<string, { bid: number; word: string | null }> = {};
      // Alternate evaluation order so the second policy does not always get warmer caches.
      for (const name of rows.length % 2 ? ['refined', 'baseline'] : ['baseline', 'refined']) {
        const remainingLetters = name === 'baseline' ? baseline : refined;
        const bid = timed(`${name}-bid`, () => mc.decideBid({ ...ctx, remainingLetters }));
        const word = timed(`${name}-word`, () => mc.chooseWord({ ...ctx, remainingLetters }));
        assert.ok(Number.isInteger(bid) && bid >= 0 && bid <= ctx.myBalance);
        if (bagRemaining === 0) assert.equal(bid, 0);
        if (word) { const rest = new Map(rack); for (const c of word) { assert.ok((rest.get(c) ?? 0) > 0); rest.set(c, rest.get(c)! - 1); } }
        outputs[name] = { bid, word };
      }
      const a = auctions[at], top = m.topBids.find((t: any) => t.auctionId === a.auctionId);
      const threshold = m.match.auctionType.tag === 'Vickrey' ? Number(a.winnerBotId === m.botId ? a.paid : top.topBid) : null;
      rows.push({ run, match: m.matchId, auction: b.auctionId, letter: b.letter, bagRemaining, cutoffMicros: cutoff.toString(), balance: ctx.myBalance, rack: b.rack, knownInitial: knownCount, unknownInitial: 25 - knownCount, newExclusions: [...refined].filter(([c, n]) => n === 0 && baseline.get(c)! > 0).map(([c]) => c), baseline: outputs.baseline, refined: outputs.refined, bidDelta: outputs.refined.bid - outputs.baseline.bid, wordChanged: outputs.refined.word !== outputs.baseline.word, archivedThreshold: threshold, baselineStrictlyAboveThreshold: threshold !== null && outputs.baseline.bid > threshold, refinedStrictlyAboveThreshold: threshold !== null && outputs.refined.bid > threshold });
    }
  }
}
const summary = (rs: any[]) => ({ contexts: rs.length, bidChanged: rs.filter(r => r.bidDelta !== 0).length, raised: rs.filter(r => r.bidDelta > 0).length, lowered: rs.filter(r => r.bidDelta < 0).length, meanBidDelta: rs.reduce((a, r) => a + r.bidDelta, 0) / Math.max(1, rs.length), baselineMeanBid: rs.reduce((a, r) => a + r.baseline.bid, 0) / Math.max(1, rs.length), refinedMeanBid: rs.reduce((a, r) => a + r.refined.bid, 0) / Math.max(1, rs.length), positiveToZero: rs.filter(r => r.baseline.bid > 0 && r.refined.bid === 0).length, zeroToPositive: rs.filter(r => r.baseline.bid === 0 && r.refined.bid > 0).length, wordChanged: rs.filter(r => r.wordChanged).length, newlyAboveArchivedThreshold: rs.filter(r => !r.baselineStrictlyAboveThreshold && r.refinedStrictlyAboveThreshold).length, noLongerAboveArchivedThreshold: rs.filter(r => r.baselineStrictlyAboveThreshold && !r.refinedStrictlyAboveThreshold).length });
const groups = {
  all: summary(rows), late: summary(rows.filter(r => r.bagRemaining >= 6 && r.bagRemaining <= 28)),
  lateRare: summary(rows.filter(r => r.bagRemaining >= 6 && r.bagRemaining <= 28 && 'JQXZ'.includes(r.letter))),
  lateHighFace: summary(rows.filter(r => r.bagRemaining >= 6 && r.bagRemaining <= 28 && 'FHKVWY'.includes(r.letter))),
  endgame: summary(rows.filter(r => r.bagRemaining <= 5)),
};
const timing = Object.fromEntries(Object.entries(times).map(([key, v]) => { v.sort((a, b) => a - b); return [key, { count: v.length, p50Ms: v[Math.floor(v.length * .5)], p95Ms: v[Math.floor(v.length * .95)], p99Ms: v[Math.floor(v.length * .99)], maxMs: v.at(-1), over100ms: v.filter(n => n >= 100).length }]; }));
for (const file of inputs) assert.equal(fileHash(file), hashes[file], `${file} changed during diagnostic`);
const out = { diagnostic: 'Paired shadow bid and word decisions on actual logged bid states. Recorded racks/cash/actions remain fixed; no score or live win estimate. Prefix-only observed public knowledge; same MC config, dictionary ordering and deterministic random-number seeds. Archived price thresholds used only after quoting, with ties conservatively below the threshold. Full future initial aggregate used only for bound validation. Late means6–28bagRemaining; endgame<=5 ignores sampled futures for bids.', config: mc.config, matches: frozen.sources.map((s: any) => s.match), hashes, logs, coldIndexMs, groups, timing, rows };
fs.writeFileSync('runs/research-known-initial-shadow.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify({ groups, timing, coldIndexMs }, null, 2));

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { cap1, premium, createCashflowPolicy } from './experiment-cashflow-policy.js';

const dictionary = fs.readFileSync('../spacetimedb/wordlist.txt', 'utf8').split('\n').map(w => w.trim().toUpperCase()).filter(w => w.length >= 2).sort((a, b) => b.length - a.length);
const ids = ['631', '634', '639', '643', '647', '651', '655', '664', '668', '672', '685', '689', '693'];
const matches: any[] = [];
for (const dir of fs.readdirSync('runs')) {
  const root = path.join('runs', dir);
  if (!fs.statSync(root).isDirectory()) continue;
  const events = fs.readFileSync(path.join(root, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  for (const f of fs.readdirSync(root).filter(f => /^match-\d+\.json$/.test(f))) {
    const source = fs.readFileSync(path.join(root, f), 'utf8'), match = JSON.parse(source);
    if (!ids.includes(match.matchId)) continue;
    const start = events.find(e => e.event === 'match_start' && e.data.match.id === match.matchId)?.data;
    assert.ok(start && Number(start.participant.score) === 0 && match.match.status.tag === 'Ended');
    matches.push({ match, start, sourceHash: crypto.createHash('sha256').update(source).digest('hex') });
  }
}
matches.sort((a, b) => ids.indexOf(a.match.matchId) - ids.indexOf(b.match.matchId));
assert.deepEqual(matches.map(m => m.match.matchId), ids);

const coldIndexMs = Object.fromEntries([['cap1', cap1], ['premium', premium]].map(([name, base]) => {
  const t = performance.now();
  (base as typeof cap1).chooseWord({ dictionary, myRack: new Map() });
  return [name as string, performance.now() - t];
}));
const observedRack = new Map<string, number>();
for (const c of 'PREOTA') observedRack.set(c, (observedRack.get(c) ?? 0) + 1);
const observedContext = { dictionary, myRack: observedRack, myBalance: 44, bagRemaining: 31, letter: 'G' };
const observedFixture = { base: cap1.decideBid(observedContext), before: cap1.chooseWord(observedContext), after: cap1.chooseWord({ ...observedContext, myRack: new Map([...observedRack, ['G', 1]]) }), floors: [0.6, 0.8, 1].map(factor => ({ factor, bid: createCashflowPolicy(cap1, factor).decideBid(observedContext) })) };
assert.equal(observedFixture.base, 13);
assert.equal(observedFixture.before, null);
assert.equal(observedFixture.after, 'PORTAGE');
assert.deepEqual(observedFixture.floors.map(f => f.bid), [18, 24, 30]);

const timings: Record<string, number[]> = {};
function run(name: string, policy: ReturnType<typeof createCashflowPolicy>, repeatLiquidation = false) {
  timings[name] = [];
  const results = matches.map(({ match, start }) => {
    const rack = new Map<string, number>(Object.entries(start.rack));
    let balance = Number(start.participant.balance), score = 0, acquired = 0, spent = 0, changedBids = 0;
    const played: string[] = [], floorWins: string[] = [];
    const bids = new Map<string, number>(match.topBids.map((a: any) => [a.auctionId, Number(a.topBid)]));
    const auctions = [...match.auctions].sort((a, b) => Number(BigInt(a.auctionId) - BigInt(b.auctionId)));
    for (let i = 0; i < auctions.length; i++) {
      const a = auctions[i], bagRemaining = auctions.length - i - 1;
      let word: string | null;
      do {
        const t = performance.now();
        word = policy.chooseWord({ dictionary, myRack: rack, myBalance: balance, bagRemaining });
        timings[name].push(performance.now() - t);
        if (!word) break;
        for (const c of word) { assert.ok((rack.get(c) ?? 0) > 0); rack.set(c, rack.get(c)! - 1); }
        const reward = cap1.wordScore(word); score += reward; balance += reward; played.push(word);
      } while (repeatLiquidation);
      const ctx = { dictionary, myRack: rack, myBalance: balance, bagRemaining, letter: a.letter, auctionType: match.match.auctionType.tag };
      const t = performance.now(), bid = policy.decideBid(ctx);
      timings[name].push(performance.now() - t);
      assert.ok(Number.isInteger(bid) && bid >= 0 && bid <= balance);
      if (bagRemaining === 0) assert.equal(bid, 0);
      const reference = (name.includes('premium') ? premium : cap1).decideBid(ctx);
      if (bid > reference) changedBids++;
      const opponentBid = a.winnerBotId === match.botId ? Number(a.paid) : bids.get(a.auctionId)!;
      assert.ok(Number.isFinite(opponentBid));
      if (bid > 0 && (a.winnerBotId == null || bid > opponentBid)) {
        const price = match.match.auctionType.tag === 'FirstPrice' ? bid : Math.max(1, opponentBid);
        assert.ok(price <= balance); balance -= price; spent += price; acquired++;
        rack.set(a.letter, (rack.get(a.letter) ?? 0) + 1);
        if (bid > reference && reference <= opponentBid) floorWins.push(`${i + 1}:${a.letter}:${bid}:${opponentBid}`);
      }
    }
    return { match: match.matchId, score, balance, spent, acquired, changedBids, floorWins, played, unusedTiles: [...rack.values()].reduce((a, b) => a + b, 0) };
  });
  const mean = (rows: typeof results) => rows.reduce((n, r) => n + r.score, 0) / rows.length;
  return { name, mean: mean(results), trainMean: mean(results.slice(0, 10)), holdoutMean: mean(results.slice(10)), scores100: results.filter(r => r.score >= 100).length, minimumScore: Math.min(...results.map(r => r.score)), results };
}
const policies = [
  { name: 'cap1', policy: cap1 }, { name: 'premium', policy: premium },
  ...[0.6, 0.8, 1].flatMap(factor => [cap1, premium].map(base => ({ name: `${base === cap1 ? 'cap1' : 'premium'}-cashflow-${factor}`, policy: createCashflowPolicy(base, factor) }))),
];
const results = policies.map(({ name, policy }) => run(name, policy));
// Previous research allowed sequential rack liquidation; retain that replay only as a sensitivity check.
const repeatedLiquidation = policies.map(({ name, policy }) => run(`${name}-repeat`, policy, true));
const chronological = ['cap1', 'premium'].map(base => {
  const selected = results.filter(r => r.name.startsWith(`${base}-cashflow`)).sort((a, b) => b.trainMean - a.trainMean || a.name.localeCompare(b.name))[0];
  return { base, train: ids.slice(0, 10), holdout: ids.slice(10), selected: selected.name, trainMean: selected.trainMean, holdoutMean: selected.holdoutMean, baselineHoldoutMean: results.find(r => r.name === base)!.holdoutMean };
});
const timing = Object.fromEntries(Object.entries(timings).map(([name, times]) => {
  times.sort((a, b) => a - b);
  return [name, { maxMs: times.at(-1), p95Ms: times[Math.floor(times.length * 0.95)] }];
}));
for (const value of Object.values(timing)) assert.ok(value.maxMs! < 100);
const hashes = Object.fromEntries(['strategy-candidate.ts', 'strategy-premium.ts', 'experiment-cashflow-policy.ts', 'experiment-cashflow-replay.ts'].map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(`src/${file}`)).digest('hex')]));
const output = { diagnostic: 'Frozen tile order and rival bids, conservative equal-bid losses. Counterfactual opponent balances and racks are not reconstructed. One submission per auction in primary replay. Not causal evidence; no live connections or deployment.', frozenMatches: matches.map(({ match, sourceHash }) => ({ id: match.matchId, sourceHash })), hashes, observedFixture, results, chronological, repeatedLiquidation, coldIndexMs, timing };
fs.writeFileSync('runs/research-cashflow-results.json', JSON.stringify(output, null, 2));
console.log(JSON.stringify({ results: results.map(({ results, ...summary }) => summary), chronological, repeat: repeatedLiquidation.map(({ results, ...summary }) => summary), timing }, null, 2));

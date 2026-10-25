import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import * as premium from './strategy-premium.js';
import * as face from './experiment-face-policy.js';
import { createHighFaceCashflowPolicy } from './experiment-face-cashflow.js';

const dictionary = fs.readFileSync('../spacetimedb/wordlist.txt', 'utf8').split('\n').map(w => w.trim().toUpperCase()).filter(w => w.length >= 2).sort((a, b) => b.length - a.length);
const ids = ['631', '634', '639', '643', '647', '651', '655', '664', '668', '672', '685', '689', '693', '702'];
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
const coldIndexMs = Object.fromEntries([['premium', premium], ['face', face]].map(([name, policy]) => {
  const t = performance.now();
  (policy as typeof premium).chooseWord({ dictionary, myRack: new Map() });
  return [name as string, performance.now() - t];
}));
const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const timings: Record<string, number[]> = {};
function run(name: string, extraFace?: number, override?: ReturnType<typeof createHighFaceCashflowPolicy>) {
  const policy = override ?? (extraFace === undefined ? premium : { chooseWord: face.chooseWord, decideBid: (ctx: face.BidContext) => face.decideBid(ctx, extraFace) });
  const times: number[] = [];
  const results = matches.map(({ match, start }) => {
    const rack = new Map<string, number>(Object.entries(start.rack));
    let balance = Number(start.participant.balance), score = 0, acquired = 0, spent = 0, wonFace = 0, usedFace = 0, usedTiles = 0, floorRaises = 0;
    const played: string[] = [], wonLetters: string[] = [];
    const bids = new Map<string, number>(match.topBids.map((a: any) => [a.auctionId, Number(a.topBid)]));
    const auctions = [...match.auctions].sort((a, b) => Number(BigInt(a.auctionId) - BigInt(b.auctionId)));
    for (let i = 0; i < auctions.length; i++) {
      const a = auctions[i], bagRemaining = auctions.length - i - 1;
      const tWord = performance.now();
      const word = policy.chooseWord({ dictionary, myRack: rack, myBalance: balance, bagRemaining });
      times.push(performance.now() - tWord);
      if (word) {
        for (const c of word) {
          assert.ok((rack.get(c) ?? 0) > 0); rack.set(c, rack.get(c)! - 1);
          usedFace += premium.LETTER_VALUE[c]; usedTiles++;
        }
        const reward = premium.wordScore(word); score += reward; balance += reward; played.push(word);
      }
      const tBid = performance.now();
      const ctx = { dictionary, myRack: rack, myBalance: balance, bagRemaining, letter: a.letter, auctionType: match.match.auctionType.tag };
      const bid = policy.decideBid(ctx);
      times.push(performance.now() - tBid);
      if (override && bid > (extraFace === undefined ? premium.decideBid(ctx) : face.decideBid(ctx, extraFace))) floorRaises++;
      assert.ok(Number.isInteger(bid) && bid >= 0 && bid <= balance);
      if (bagRemaining === 0) assert.equal(bid, 0);
      const opponentBid = a.winnerBotId === match.botId ? Number(a.paid) : bids.get(a.auctionId)!;
      assert.ok(Number.isFinite(opponentBid));
      if (bid > 0 && (a.winnerBotId == null || bid > opponentBid)) {
        const price = match.match.auctionType.tag === 'FirstPrice' ? bid : Math.max(1, opponentBid);
        assert.ok(price <= balance); balance -= price; spent += price; acquired++; wonFace += premium.LETTER_VALUE[a.letter]; wonLetters.push(a.letter);
        rack.set(a.letter, (rack.get(a.letter) ?? 0) + 1);
      }
    }
    return { match: match.matchId, score, balance, spent, acquired, wonFace, floorRaises, meanWonFace: wonFace / Math.max(1, acquired), usedFace, usedTiles, meanUsedFace: usedFace / Math.max(1, usedTiles), rewardPerUsedTile: score / Math.max(1, usedTiles), meanWordBase: usedFace / Math.max(1, played.length), meanWordLength: usedTiles / Math.max(1, played.length), played, wonLetters: wonLetters.join(''), unusedTiles: [...rack.values()].reduce((a, b) => a + b, 0) };
  });
  const summarize = (rows: typeof results) => ({ count: rows.length, score: mean(rows.map(r => r.score)), medianScore: median(rows.map(r => r.score)), scores100: rows.filter(r => r.score >= 100).length, minScore: Math.min(...rows.map(r => r.score)), spent: mean(rows.map(r => r.spent)), acquired: mean(rows.map(r => r.acquired)), meanWonFace: rows.reduce((s, r) => s + r.wonFace, 0) / rows.reduce((s, r) => s + r.acquired, 0), meanUsedFace: rows.reduce((s, r) => s + r.usedFace, 0) / rows.reduce((s, r) => s + r.usedTiles, 0), rewardPerUsedTile: rows.reduce((s, r) => s + r.score, 0) / rows.reduce((s, r) => s + r.usedTiles, 0), meanWordBase: rows.reduce((s, r) => s + r.usedFace, 0) / rows.reduce((s, r) => s + r.played.length, 0), meanWordLength: rows.reduce((s, r) => s + r.usedTiles, 0) / rows.reduce((s, r) => s + r.played.length, 0) });
  timings[name] = times;
  return { name, extraFace: extraFace ?? 0, all: summarize(results), train: summarize(results.slice(0, 10)), holdout: summarize(results.slice(10)), results };
}
const face25 = { ...premium, chooseWord: face.chooseWord, decideBid: (ctx: face.BidContext) => face.decideBid(ctx, 0.5) };
const results = [run('premium'), ...[0.5, 1, 2].map(extra => run(`face-${2 + extra}`, extra)), run('premium-high-face-cashflow', undefined, createHighFaceCashflowPolicy()), run('face-2.5-high-face-cashflow', 0.5, createHighFaceCashflowPolicy(face25))];
const chosen = [...results.slice(1, 4)].sort((a, b) => b.train.score - a.train.score || a.extraFace - b.extraFace)[0];
const timing = Object.fromEntries(Object.entries(timings).map(([name, times]) => {
  times.sort((a, b) => a - b);
  const stats = { maxMs: times.at(-1)!, p95Ms: times[Math.floor(times.length * 0.95)] };
  assert.ok(stats.maxMs < 100);
  return [name, stats];
}));
const hashes = Object.fromEntries(['strategy-premium.ts', 'experiment-face-policy.ts', 'experiment-face-cashflow.ts', 'experiment-cashflow-policy.ts', 'experiment-face-replay.ts', 'experiment-face.test.ts'].map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(`src/${file}`)).digest('hex')]));
const output = { diagnostic: 'Frozen rival bids/order; equal bids conservatively lose. One word per auction. Counterfactual opponent cash/racks/score and market reactions are not reconstructed, so relative-win effects of denying rivals expensive letters are unmeasured. No live connections/deployment.', protocol: 'Face coefficients were fixed before replay. Restricted high-face cashflow and its face2.5 combination were added after seeing coefficient results; their holdout is exploratory.', change: 'Generic value becomes (2+extraFace)*face + (9-extraFace), preserving face1 prices; common/vowel/duplicate modifiers, completion and speculative premium, rare JQXZ gate, first-price shading and caps retain their original ordering. Restricted cashflow floors apply only to face>=4 with newly playable reward>=30.', frozenMatches: matches.map(({ match, sourceHash }) => ({ id: match.matchId, sourceHash })), hashes, results, chronological: { train: ids.slice(0, 10), holdoutMatches: ids.slice(10), selectedOnTrain: chosen.name, holdout: chosen.holdout, baselineHoldout: results[0].holdout }, coldIndexMs, timing };
fs.writeFileSync('runs/research-face.json', JSON.stringify(output, null, 2));
console.log(JSON.stringify({ results: results.map(({ results, ...summary }) => summary), chronological: output.chronological, timing }, null, 2));

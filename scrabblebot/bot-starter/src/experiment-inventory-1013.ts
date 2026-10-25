import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import * as original from './strategy-mc.js';
import * as baseline from './experiment-mc-fast.js';
import * as pool from './experiment-planner-mc-pool.js';
import * as market from './experiment-inventory-market.js';
import { remainingPool } from './remaining-pool.js';

const historyFile = 'runs/public-history-20261024-0933.json';
const eventsFile = 'runs/2026-10-24T09-25-54.560Z-montecarlo/events.jsonl';
const historyText = fs.readFileSync(historyFile, 'utf8'), history = JSON.parse(historyText);
const events = fs.readFileSync(eventsFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
const start = events.find(e => e.event === 'match_start' && e.data.match.id === '1013').data;
const bidEvent = events.find(e => e.event === 'bid' && e.data.auctionId === '100288').data;
const auctions = history.auctions.filter((a: any) => a.matchId === '1013').sort((a: any, b: any) => Number(BigInt(a.auctionId) - BigInt(b.auctionId)));
const topBids = new Map<string, number>(history.topBids.map((a: any) => [a.auctionId, Number(a.topBid)]));
const dictionary = fs.readFileSync('../spacetimedb/wordlist.txt', 'utf8').split('\n').map(w => w.trim().toUpperCase()).filter(w => w.length >= 2).sort((a, b) => b.length - a.length);
const initialRack = new Map<string, number>(Object.entries(start.rack));
const zIndex = auctions.findIndex((a: any) => a.auctionId === '100288');
assert.equal(zIndex, 59);
const zContext = { dictionary, myRack: new Map<string, number>(Object.entries(bidEvent.rack)), myBalance: bidEvent.balance, bagRemaining: 8, letter: 'Z', auctionType: 'Vickrey', remainingLetters: remainingPool(initialRack, auctions.slice(0, 60).map((a: any) => a.letter), 8, 25) };
assert.ok(zContext.remainingLetters);
assert.equal(zContext.myBalance, 32);
assert.equal(bidEvent.amount, 31);
assert.equal(baseline.wordScore('ZINGERS'), 51);
assert.ok(dictionary.includes('ZINGERS'));
assert.ok(27 + 13 > zContext.myBalance);
const policies = [{ name: 'original-MC-fast-equivalent', policy: baseline }, { name: 'pool-MC', policy: pool }, { name: 'actual-market', policy: market }];
for (const p of [...policies, { name: 'original-scan', policy: original }]) p.policy.chooseWord({ dictionary, myRack: new Map() });
const quote = (name: string, policy: typeof baseline) => ({ name, wordBeforeZ: policy.chooseWord(zContext), bidZ: policy.decideBid(zContext) });
const quotes = [...policies.map(p => quote(p.name, p.policy)), quote('original-scan', original)];
assert.equal(quotes[0].bidZ, quotes[3].bidZ);
assert.equal(quotes[0].bidZ, 31);

function replay(name: string, policy: typeof baseline, fork = false, skipZ = false) {
  const rack = fork ? new Map(zContext.myRack) : new Map(initialRack);
  let score = fork ? 36 : 0, balance = fork ? 32 : 100, spent = fork ? 104 : 0;
  const played: string[] = fork ? ['OBOVATE'] : [], actions: any[] = [];
  for (let i = fork ? zIndex : 0; i < auctions.length; i++) {
    const a = auctions[i], bagRemaining = auctions.length - i - 1;
    const remainingLetters = remainingPool(initialRack, auctions.slice(0, i + 1).map((a: any) => a.letter), bagRemaining, 25);
    assert.ok(remainingLetters);
    let word: string | null;
    while ((word = policy.chooseWord({ dictionary, myRack: rack, myBalance: balance, bagRemaining, remainingLetters } as any))) {
      for (const c of word) { assert.ok((rack.get(c) ?? 0) > 0); rack.set(c, rack.get(c)! - 1); }
      const reward = baseline.wordScore(word); score += reward; balance += reward; played.push(word);
      actions.push({ round: i + 1, type: 'word', word, reward, balance, rack: Object.fromEntries([...rack].filter(([, n]) => n)) });
    }
    const context = { dictionary, myRack: rack, myBalance: balance, bagRemaining, remainingLetters, letter: a.letter, auctionType: 'Vickrey' };
    const bid = skipZ && i === zIndex ? 0 : policy.decideBid(context);
    assert.ok(Number.isInteger(bid) && bid >= 0 && bid <= balance);
    if (bagRemaining === 0) assert.equal(bid, 0);
    // Remove our original winning bid from the historical competition: paid is the highest rival bid.
    const threshold = a.winnerBotId === '26' ? Number(a.paid) : topBids.get(a.auctionId)!;
    assert.ok(Number.isFinite(threshold));
    const won = bid > 0 && bid > threshold;
    if (won) { const price = Math.max(1, threshold); assert.ok(price <= balance); balance -= price; spent += price; rack.set(a.letter, (rack.get(a.letter) ?? 0) + 1); }
    actions.push({ round: i + 1, type: 'bid', auctionId: a.auctionId, letter: a.letter, bid, threshold, won, balance, rack: Object.fromEntries([...rack].filter(([, n]) => n)) });
  }
  assert.equal(100 + score - spent, balance);
  return { name, score, balance, spent, rack: Object.fromEntries([...rack].filter(([, n]) => n)), played, actions };
}
const full = policies.map(p => replay(p.name, p.policy));
const forks = [...policies.map(p => replay(p.name, p.policy, true)), replay('original-MC-skipZ-only', baseline, true, true)];
const ownWords = history.words.filter((w: any) => w.matchId === '1013' && w.botId === '26');
const observed = { score: 48, beforeZ: { balance: 32, rack: bidEvent.rack, bid: 31, paid: 27, bagRemaining: 8 }, words: ownWords.map((w: any) => ({ word: w.word, reward: Number(w.totalReward) })), beforeI: { cashBeforeGENUS: 5, cashAfterGENUS: 17, bidBeforeGENUS: 5, bidAfterGENUS: 17, paid: 13 }, final: { balance: 4, rack: { R: 1, Z: 1, I: 1 } } };
assert.equal(ownWords.reduce((s: number, w: any) => s + Number(w.totalReward), 0), observed.score);
const hash = (text: string) => crypto.createHash('sha256').update(text).digest('hex');
const files = ['src/experiment-inventory-1013.ts', 'src/strategy-mc.ts', 'src/experiment-mc-fast.ts', 'src/experiment-planner-mc-pool.ts', 'src/experiment-inventory-market.ts', 'src/remaining-pool.ts'];
const result = { diagnostic: 'Exact recorded Z context and real five-tile starting rack. Policies receive only the public prefix for pool conditioning; fixed subsequent auctions/rival bids and conservative tie losses. Counterfactual opponents do not react. Full replays can diverge before Z; conditional forks isolate the recorded pre-Z state. Instant sequential liquidation ignores SDK event latency.', historyFile, historyHash: hash(historyText), eventsFile, config: { MC_K: 24, MC_LAMBDA: 0.5, MC_PRICE: 13, MC_WIN: 0.25, MC_END: 5, MC_PACE: 0.5, MC_PACE_MAX: 2.5 }, sourceHashes: Object.fromEntries(files.map(f => [f, hash(fs.readFileSync(f, 'utf8'))])), observed, target: { word: 'ZINGERS', score: 51, validDictionaryWord: true, unusedTile: 'U', requiredPurchases: 40, availableCash: 32, cashDeficit: 8 }, quotes, full, forks };
fs.writeFileSync('runs/research-inventory-1013-audit.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify({ observed, quotes, full: full.map(({ actions, ...r }) => r), forks: forks.map(({ actions, ...r }) => r) }, null, 2));

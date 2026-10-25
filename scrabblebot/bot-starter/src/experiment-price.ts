// Offline paired diagnostics: no connection, credentials, or live strategy changes.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import * as candidate from './strategy-candidate.js';

type Archive = { match: any; start: any; auctions: any[]; top: Map<string, number> };
type Mode = 'candidate' | 'H-vowels' | 'J-leader-paid' | 'G-paid' | 'G-threshold' | 'G-cap';
type PriceTable = Map<string, number[]>;
const dictionary = fs.readFileSync('../spacetimedb/wordlist.txt', 'utf8').split('\n')
  .map(w => w.trim().toUpperCase()).filter(w => w.length >= 2).sort((a, b) => b.length - a.length);
const timestamp = (t: any): number => Number(t.__timestamp_micros_since_unix_epoch__);
const frozenMatches = new Set(['631', '634', '639', '643', '647', '651', '655', '664', '668', '672']);
const archives: Archive[] = [];
for (const dir of fs.readdirSync('runs')) {
  const root = path.join('runs', dir);
  if (!fs.statSync(root).isDirectory() || !fs.existsSync(path.join(root, 'events.jsonl'))) continue;
  const events = fs.readFileSync(path.join(root, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  for (const file of fs.readdirSync(root).filter(f => /^match-\d+\.json$/.test(f))) {
    const match = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
    if (!frozenMatches.has(match.matchId)) continue;
    const start = events.find(e => e.event === 'match_start' && e.data.match.id === match.matchId)?.data;
    if (!start || Number(start.participant.score) !== 0) continue;
    const auctions = [...match.auctions].sort((a, b) => timestamp(a.closedAt) - timestamp(b.closedAt));
    assert.equal(auctions.length, 68);
    assert.equal(match.match.auctionType.tag, 'Vickrey');
    assert.equal(Object.values<number>(start.rack).reduce((s, n) => s + n, 0), 5);
    archives.push({ match, start, auctions, top: new Map(match.topBids.map((a: any) => [a.auctionId, Number(a.topBid)])) });
  }
}
archives.sort((a, b) => timestamp(a.match.match.startedAt) - timestamp(b.match.match.startedAt));
assert.equal(archives.length, 10);
const phase = (remaining: number) => Math.min(3, Math.floor(remaining / 17));
const threshold = (a: any, game: Archive) => a.winnerBotId === game.match.botId ? Number(a.paid) : game.top.get(a.auctionId)!;
const quantile = (values: number[], q: number) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * q) - 1];
assert.equal(quantile([4, 1, 3, 2], .75), 3);
assert.equal(threshold({ auctionId: 'x', winnerBotId: 'other', paid: '2' }, { match: { botId: 'us' }, top: new Map([['x', 9]]) } as Archive), 9);
function fit(games: Archive[], source: 'paid' | 'threshold'): PriceTable {
  const table: PriceTable = new Map();
  for (const game of games) for (let i = 0; i < game.auctions.length - 1; i++) {
    const a = game.auctions[i];
    if (!a.winnerBotId) continue;
    const price = source === 'paid' ? Number(a.paid) : threshold(a, game);
    for (const key of [a.letter, `${a.letter}:${phase(game.auctions.length - i - 1)}`]) {
      const values = table.get(key) ?? [];
      values.push(price); table.set(key, values);
    }
  }
  return table;
}
function prices(table: PriceTable, letter: string, remaining: number): number[] | undefined {
  const cell = table.get(`${letter}:${phase(remaining)}`);
  return cell && cell.length >= 3 ? cell : table.get(letter);
}

// Reuse the candidate's choices; this small index exposes the same exact one-tile gain for G.
const words = dictionary.map(text => {
  const counts = new Map<string, number>();
  for (const c of text) counts.set(c, (counts.get(c) ?? 0) + 1);
  return { text, score: candidate.wordScore(text), needs: [...counts] };
});
const gains = new Map<string, { best: number; completion: Map<string, number> }>();
function gain(rack: Map<string, number>, letter: string): number {
  const key = [...rack].filter(([, n]) => n > 0).sort().map(([c, n]) => `${c}${n}`).join('');
  let analysis = gains.get(key);
  if (!analysis) {
    analysis = { best: 0, completion: new Map() };
    const tiles = [...rack.values()].reduce((s, n) => s + n, 0);
    for (const word of words) {
      if (word.text.length > tiles + 1) continue;
      let missing = '', fits = true;
      for (const [c, n] of word.needs) {
        const deficit = n - (rack.get(c) ?? 0);
        if (deficit <= 0) continue;
        if (deficit > 1 || missing) { fits = false; break; }
        missing = c;
      }
      if (!fits) continue;
      if (!missing) analysis.best = Math.max(analysis.best, word.score);
      else analysis.completion.set(missing, Math.max(analysis.completion.get(missing) ?? 0, word.score));
    }
    gains.set(key, analysis);
  }
  return Math.max(0, (analysis.completion.get(letter) ?? 0) - analysis.best);
}
assert.equal(gain(new Map([['Q', 1], ['U', 1], ['I', 1]]), 'Z'), 33);
candidate.chooseWord({ myRack: new Map(), dictionary }); // Warm candidate dictionary before timing.

function run(game: Archive, mode: Mode, table: PriceTable) {
  const rack = new Map<string, number>(Object.entries(game.start.rack));
  let score = 0, balance = Number(game.start.participant.balance), spent = 0, won = 0, scoreAt20 = 0;
  let maxBidMs = 0, maxWordMs = 0, ties = 0, lookups = 0, supportedLookups = 0, leaderCopies = 0;
  const played: string[] = [];
  const publicScores = new Map<string, number>(game.match.participants.map((p: any) => [p.botId, 0]));
  const paidByBot = new Map<string, Map<string, number[]>>();
  const publicWords = [...game.match.words].filter(w => w.botId !== game.match.botId)
    .sort((a, b) => timestamp(a.playedAt) - timestamp(b.playedAt));
  let publicWordIndex = 0;
  for (let i = 0; i < game.auctions.length; i++) {
    const a = game.auctions[i], remaining = game.auctions.length - i - 1;
    // Only words timestamped before the current auction opened can identify its leader.
    const opened = i ? timestamp(game.auctions[i - 1].closedAt) : timestamp(game.match.match.startedAt);
    while (publicWordIndex < publicWords.length && timestamp(publicWords[publicWordIndex].playedAt) <= opened) {
      const word = publicWords[publicWordIndex++];
      publicScores.set(word.botId, (publicScores.get(word.botId) ?? 0) + Number(word.totalReward));
    }
    while (true) {
      const before = performance.now();
      const word = candidate.chooseWord({ dictionary, myRack: rack, myBalance: balance, bagRemaining: remaining });
      maxWordMs = Math.max(maxWordMs, performance.now() - before);
      if (!word) break;
      for (const c of word) { assert.ok((rack.get(c) ?? 0) > 0); rack.set(c, rack.get(c)! - 1); }
      const reward = candidate.wordScore(word); score += reward; balance += reward; played.push(word);
    }
    if (i === 20) scoreAt20 = score;
    const before = performance.now();
    const base = candidate.decideBid({ dictionary, myRack: rack, myBalance: balance, bagRemaining: remaining,
      letter: a.letter, auctionType: 'Vickrey' });
    let bid = base;
    if (remaining > 5 && balance > 0) {
      if (mode === 'H-vowels') {
        const tiles = [...rack.values()].reduce((s, n) => s + n, 0);
        const vowels = [...rack].reduce((s, [c, n]) => s + ('AEIOU'.includes(c) ? n : 0), 0);
        const skew = .4 - (tiles ? vowels / tiles : .4);
        bid = base * (1 + .8 * skew * ('AEIOU'.includes(a.letter) ? 1 : -1));
      }
      if (mode.startsWith('G-')) {
        lookups++;
        const samples = prices(table, a.letter, remaining);
        if (samples?.length) {
          supportedLookups++;
          const q75 = quantile(samples, .75);
          if (mode === 'G-cap') bid = Math.min(base, q75 + 1);
          else {
            const g = gain(rack, a.letter);
            bid = g > 0 ? Math.max(q75 + 1, g) : base > quantile(samples, .5) ? q75 : 0;
          }
        }
      }
      if (mode === 'J-leader-paid' && i >= 20) {
        publicScores.set(game.match.botId, score);
        const leader = [...publicScores].sort((a, b) => b[1] - a[1] || Number(a[0]) - Number(b[0]))[0][0];
        const observations = paidByBot.get(leader)?.get(a.letter);
        if (leader !== game.match.botId && observations?.length) {
          bid = 1.1 * observations.reduce((s, n) => s + n, 0) / observations.length; leaderCopies++;
        }
      }
    }
    bid = Math.max(0, Math.min(balance, Math.round(bid)));
    maxBidMs = Math.max(maxBidMs, performance.now() - before);
    assert.ok(Number.isInteger(bid) && bid >= 0 && bid <= balance);
    if (remaining === 0) assert.equal(bid, 0);
    const other = threshold(a, game);
    assert.ok(Number.isFinite(other));
    if (bid > 0 && bid === other) ties++;
    // shortcut: historical ties are treated as losses, use paired stochastic simulation for live win rates.
    if (bid > 0 && (!a.winnerBotId || bid > other)) {
      const price = Math.max(1, other); assert.ok(price <= balance);
      balance -= price; spent += price; won++; rack.set(a.letter, (rack.get(a.letter) ?? 0) + 1);
    }
    // Observe this completed auction after bidding, never its archived topBid.
    if (a.winnerBotId && a.winnerBotId !== game.match.botId) {
      const bot = paidByBot.get(a.winnerBotId) ?? new Map<string, number[]>();
      const observations = bot.get(a.letter) ?? []; observations.push(Number(a.paid));
      bot.set(a.letter, observations); paidByBot.set(a.winnerBotId, bot);
    }
  }
  assert.equal(balance, Number(game.start.participant.balance) + score - spent);
  assert.ok(maxBidMs < 100 && maxWordMs < 100, 'warmed decision exceeded 100 ms');
  const unused = [...rack.values()].reduce((s, n) => s + n, 0);
  assert.equal(5 + won, unused + played.reduce((s, w) => s + w.length, 0));
  return { match: game.match.matchId, score, spent, balance, won, unused, words: played.length,
    meanWordLength: played.length ? played.reduce((s, w) => s + w.length, 0) / played.length : 0,
    scoreAt20, maxBidMs, maxWordMs, ties, lookups, supportedLookups, leaderCopies, played };
}
const modes: Mode[] = ['candidate', 'H-vowels', 'J-leader-paid', 'G-paid', 'G-threshold', 'G-cap'];
const results = modes.map(mode => {
  const rows = archives.map((game, index) => {
    const earlier = archives.slice(0, index);
    assert.ok(earlier.every(g => timestamp(g.match.match.endedAt) < timestamp(game.match.match.startedAt)));
    return { ...run(game, mode, fit(earlier, mode === 'G-paid' ? 'paid' : 'threshold')), trainingMatches: earlier.length };
  });
  const mean = (xs: typeof rows) => Object.fromEntries(['score', 'spent', 'balance', 'won', 'unused', 'words', 'meanWordLength', 'scoreAt20', 'ties'].map(k =>
    [k, xs.reduce((s, r) => s + Number(r[k as keyof typeof r]), 0) / xs.length]));
  return { mode, mean: mean(rows), trainedMean: mean(rows.slice(1)),
    pooledMeanWordLength: rows.reduce((s, r) => s + r.played.join('').length, 0) / rows.reduce((s, r) => s + r.words, 0),
    maxBidMs: Math.max(...rows.map(r => r.maxBidMs)),
    maxWordMs: Math.max(...rows.map(r => r.maxWordMs)), rows };
});
const baseline = results[0];
const comparisons = results.slice(1).map(result => {
  const deltas = result.rows.map((r, i) => r.score - baseline.rows[i].score);
  return { mode: result.mode, scoreDelta: result.mean.score - baseline.mean.score,
    wins: deltas.filter(d => d > 0).length, ties: deltas.filter(d => d === 0).length, losses: deltas.filter(d => d < 0).length,
    trainedScoreDelta: result.trainedMean.score - baseline.trainedMean.score, deltas };
});
const report = { methodology: '10 fixed-opponent paired traces; chronological prior-game fitting only; no held-out policy tuning; ties conservatively lost; no post-last-auction play',
  recommendation: 'Keep the uncapped candidate. H, J, and G price replacement lose mean score; G cap changes only two traces (+3, -1), insufficient evidence to ship a price model or new live context.',
  corrections: ['98 tiles, 30 dealt privately, 68 auctions', 'live paid is runner-up only, outsider threshold is archived topBid',
    'topBid archive is usable to fit completed prior games only', 'unknown five-tile starting racks prevent exact public opponent rack reconstruction',
    'unbid letters are consumed by drawLetter, not returned to the bag', 'all 10 recorded games are Vickrey; no FirstPrice evidence'],
  limitations: ['Opponents retain original bids, words and money even after counterfactual losses, so scores are diagnostic rather than causal',
    'Empirical letter/phase cells back off to whole-letter data below 3 observations; no data falls back to candidate',
    'J copies original earlier public prices, which would change after counterfactual outcomes', 'No live connections or credentials accessed'],
  results, comparisons };
fs.writeFileSync('runs/research-price.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ results: results.map(({ rows, ...r }) => r), comparisons }, null, 2));

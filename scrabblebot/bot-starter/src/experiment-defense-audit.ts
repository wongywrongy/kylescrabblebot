import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { wordScore } from './strategy-candidate.js';

const micros = (v: any) => BigInt(v.__timestamp_micros_since_unix_epoch__);
const dictionary = fs.readFileSync('../spacetimedb/wordlist.txt', 'utf8').split('\n').map(w => w.trim().toUpperCase()).filter(w => /^[A-Z]{2,}$/.test(w));
const byLength: { text: string; score: number; needs: [string, number][] }[][] = [];
for (const text of dictionary) {
  const counts = new Map<string, number>();
  for (const c of text) counts.set(c, (counts.get(c) ?? 0) + 1);
  (byLength[text.length] ??= []).push({ text, score: wordScore(text), needs: [...counts] });
}
type Player = { botId: string; score: number; cash: number; acquired: Map<string, number>; used: Map<string, number>; lower: Map<string, number>; initialBudget: number };
function stateAt(m: any, cutoff: bigint): Player[] {
  const states = new Map<string, Player>(m.participants.map((p: any) => [p.botId, { botId: p.botId, score: 0, cash: 100, acquired: new Map(), used: new Map(), lower: new Map(), initialBudget: 5 }]));
  for (const a of m.auctions) if (a.winnerBotId && micros(a.closedAt) <= cutoff) {
    const s = states.get(a.winnerBotId)!; s.cash -= Number(a.paid); s.acquired.set(a.letter, (s.acquired.get(a.letter) ?? 0) + 1);
  }
  for (const w of m.words) if (micros(w.playedAt) <= cutoff) {
    const s = states.get(w.botId)!; s.score += Number(w.totalReward); s.cash += Number(w.totalReward);
    for (const c of w.word) s.used.set(c, (s.used.get(c) ?? 0) + 1);
  }
  for (const s of states.values()) for (const c of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    const net = (s.acquired.get(c) ?? 0) - (s.used.get(c) ?? 0);
    if (net > 0) s.lower.set(c, net);
    else s.initialBudget += net;
  }
  for (const s of states.values()) assert.ok(s.initialBudget >= 0 && s.initialBudget <= 5);
  return [...states.values()];
}
const caches = new Map<string, { playable: number; completion: { text: string; score: number } | null }>();
function guaranteed(rack: Map<string, number>, letter: string) {
  const key = letter + [...rack].sort().join();
  const cached = caches.get(key); if (cached) return cached;
  const tiles = [...rack.values()].reduce((a, b) => a + b, 0);
  let playable = 0, completion: { text: string; score: number } | null = null;
  for (let len = 2; len <= tiles + 1; len++) for (const w of byLength[len] ?? []) {
    let deficit = 0, missing = '';
    for (const [c, n] of w.needs) { const d = Math.max(0, n - (rack.get(c) ?? 0)); deficit += d; if (d) missing = c; if (deficit > 1) break; }
    if (deficit === 0) playable = Math.max(playable, w.score);
    else if (deficit === 1 && missing === letter && w.score > (completion?.score ?? 0)) completion = { text: w.text, score: w.score };
  }
  const result = { playable, completion }; caches.set(key, result); return result;
}
assert.deepEqual(guaranteed(new Map([['A', 1]]), 'T').completion, { text: 'AT', score: 2 });
assert.equal(guaranteed(new Map(), 'T').completion, null);

const evidence = new Map<string, any>();
let ownZeroContexts = 0, ownCashMismatches = 0, ownMatches = 0, publicMatches = 0, publicContexts = 0;
function inspect(source: string, m: any, auction: any, cutoff: bigint, defenderId: string, extra: any = {}) {
  const states = stateAt(m, cutoff), me = states.find(p => p.botId === defenderId)!;
  if (extra.cash !== undefined && me.cash !== extra.cash) ownCashMismatches++;
  if (me.cash <= 0) return;
  const leading = states.every(p => p.score <= me.score);
  for (const opp of states) {
    if (opp.botId === me.botId || opp.score >= me.score || opp.cash <= 0) continue;
    const possible = guaranteed(opp.lower, auction.letter), word = possible.completion;
    if (!word || opp.score + word.score <= me.score || opp.score + possible.playable > me.score) continue;
    const top = Number(m.topBids.find((t: any) => t.auctionId === auction.auctionId)?.topBid ?? 0);
    const key = [source, m.matchId, auction.auctionId, me.botId, opp.botId].join(':');
    if (!evidence.has(key)) evidence.set(key, { source, match: m.matchId, auction: auction.auctionId, letter: auction.letter, bagRemaining: extra.bagRemaining, defender: me.botId, defenderScore: me.score, cash: me.cash, leading, target: opp.botId, targetScore: opp.score, targetCash: opp.cash, lowerRack: Object.fromEntries(opp.lower), hiddenInitialBudget: opp.initialBudget, lowerRackExact: opp.initialBudget === 0, guaranteedCompletion: word, prospectiveScore: opp.score + word.score, guaranteedAlreadyPlayable: possible.playable, bidToExcludeTarget: opp.cash + 1, canExcludeTargetAtAnyBid: me.cash > opp.cash, historicalTargetWon: auction.winnerBotId === opp.botId, historicalTopBid: top, retrospectivelyAffordableOutbid: me.cash > top, defenderFinalScore: Number(m.participants.find((p: any) => p.botId === me.botId).score), targetFinalScore: Number(m.participants.find((p: any) => p.botId === opp.botId).score), ...extra });
  }
}

for (const dir of fs.readdirSync('runs')) {
  const root = path.join('runs', dir); if (!fs.statSync(root).isDirectory()) continue;
  const eventFile = path.join(root, 'events.jsonl'); if (!fs.existsSync(eventFile)) continue;
  const events = fs.readFileSync(eventFile, 'utf8').split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  for (const file of fs.readdirSync(root).filter(f => /^match-\d+\.json$/.test(f))) {
    const m = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
    if (m.match.startingRackSize !== 5) continue;
    ownMatches++;
    const auctions = [...m.auctions].sort((a, b) => Number(BigInt(a.auctionId) - BigInt(b.auctionId)));
    for (let i = 0; i < events.length; i++) {
      const e = events[i], d = e.data;
      if (e.event !== 'bid' || d.matchId !== m.matchId || d.amount !== 0 || d.balance <= 0) continue;
      const at = auctions.findIndex(a => a.auctionId === d.auctionId), bagRemaining = auctions.length - at - 1;
      if (bagRemaining < 1 || bagRemaining > 3) continue;
      ownZeroContexts++;
      let cutoff = micros(auctions[at - 1].closedAt);
      for (const earlier of events.slice(0, i)) if (earlier.event === 'word_play' && earlier.data.matchId === m.matchId && micros(earlier.data.playedAt) > cutoff) cutoff = micros(earlier.data.playedAt);
      inspect('own-recorded', m, auctions[at], cutoff, m.botId, { run: dir, cash: d.balance, bid: 0, bagRemaining, observedAt: e.at });
    }
  }
}

const hist = JSON.parse(fs.readFileSync('runs/public-history-latest.json', 'utf8'));
const simulated = new Set(hist.bots.filter((b: any) => b.isSimulated).map((b: any) => b.id));
const groups = (rows: any[], key: string) => { const m = new Map<string, any[]>(); for (const r of rows) { const list = m.get(r[key]) ?? []; list.push(r); m.set(r[key], list); } return m; };
const participants = groups(hist.participants, 'matchId'), auctionsBy = groups(hist.auctions, 'matchId'), wordsBy = groups(hist.words, 'matchId');
const top = new Map(hist.topBids.map((a: any) => [a.auctionId, a]));
for (const match of hist.matches) {
  if (Number(match.id) < 600 || match.status.tag !== 'Ended' || match.auctionType.tag !== 'Vickrey') continue;
  const ps = participants.get(match.id)!;
  if (ps.filter(p => !simulated.has(p.botId)).length < 4) continue;
  publicMatches++;
  const auctions = auctionsBy.get(match.id)!.sort((a, b) => Number(BigInt(a.auctionId) - BigInt(b.auctionId)));
  const m = { matchId: match.id, match, participants: ps, auctions, words: wordsBy.get(match.id) ?? [], topBids: auctions.map(a => top.get(a.auctionId)) };
  for (let at = Math.max(1, auctions.length - 4); at < auctions.length - 1; at++) {
    const a = auctions[at], opening = micros(auctions[at - 1].closedAt), close = micros(a.closedAt);
    const points = [...new Set([opening, ...m.words.map(w => micros(w.playedAt)).filter(t => t > opening && t < close)])];
    for (const cutoff of points) for (const p of ps.filter(p => !simulated.has(p.botId))) {
      publicContexts++; inspect('public-upper-bound-own-bid-unknown', m, a, cutoff, p.botId, { bagRemaining: auctions.length - at - 1 });
    }
  }
}
const rows = [...evidence.values()];
const summarize = (rs: any[]) => ({ opportunities: rs.length, matches: new Set(rs.map(r => r.match)).size, leading: rs.filter(r => r.leading).length, lastUsableAuction: rs.filter(r => r.bagRemaining === 1).length, exactRack: rs.filter(r => r.lowerRackExact).length, historicallyWonByThreat: rs.filter(r => r.historicalTargetWon).length, retrospectivelyAffordable: rs.filter(r => r.retrospectivelyAffordableOutbid).length, finalThreatBeatDefender: rs.filter(r => r.targetFinalScore > r.defenderFinalScore).length, leadingAndHistoricalThreatWonAndAffordable: rs.filter(r => r.leading && r.historicalTargetWon && r.retrospectivelyAffordableOutbid).length });
const out = { diagnostic: 'Only guaranteed lower-bound words: rack[c]=max(acquired[c]-used[c],0); hidden initial budget=5-sum(max(used[c]-acquired[c],0)). Completion requires the offered letter in this lower bound, not necessarily the true hidden rack. Public analysis does not know losing bids, so it is an upper bound without the own-bid0 gate. Archived prices used only for retrospective affordability. Denial may fail if a hidden initial copy or a later copy of the letter exists.', ownMatches, ownZeroContexts, ownCashMismatches, publicMatches, publicContexts, own: summarize(rows.filter(r => r.source === 'own-recorded')), public: summarize(rows.filter(r => r.source !== 'own-recorded')), rows };
fs.writeFileSync('runs/research-defense-opportunities.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));

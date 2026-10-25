// Build a behavioural-cloning dataset from live history: for each auction, each teacher bot's reconstructed state and its bid (exact when it won, censored upper bound otherwise).
// Usage: node --max-old-space-size=8000 --import tsx src/clone-dataset.ts runs/check-history.json runs/clone/train.jsonl <minId> <maxId> [maxPlace=2.6] [minMatches=40]
import fs from 'node:fs';
import { LETTER_VALUE } from './strategy-market.js';
const [historyFile, outFile, minId = '0', maxId = '99999999', maxPlace = '2.6', minMatches = '40'] = process.argv.slice(2);
const h = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
const t = (x: any) => Number(x.__timestamp_micros_since_unix_epoch__);
const inRange = (m: any) => Number(m.id) >= Number(minId) && Number(m.id) <= Number(maxId) && m.status.tag === 'Ended' && m.auctionType.tag === 'Vickrey';
const matches = h.matches.filter(inRange);
const ids = new Set(matches.map((m: any) => m.id));
const parts = new Map<string, any[]>(), aucs = new Map<string, any[]>(), words = new Map<string, any[]>();
const push = (map: Map<string, any[]>, k: string, v: any) => (map.get(k) ?? map.set(k, []).get(k)!).push(v);
for (const p of h.participants) if (ids.has(p.matchId)) push(parts, p.matchId, p);
for (const a of h.auctions) if (ids.has(a.matchId)) push(aucs, a.matchId, a);
for (const w of h.words) if (ids.has(w.matchId)) push(words, w.matchId, w);
const topBid = new Map<string, number>(h.topBids.map((a: any) => [a.auctionId, Number(a.topBid)]));
// Teachers: bots with low mean place over the range.
const perf = new Map<string, { m: number; place: number }>();
for (const [mid, ps] of parts) { const sorted = [...ps].sort((a, b) => Number(b.score) - Number(a.score)); sorted.forEach((p, i) => { const s = perf.get(p.botId) ?? { m: 0, place: 0 }; s.m++; s.place += i + 1; perf.set(p.botId, s); }); }
const name = Object.fromEntries(h.bots.map((b: any) => [b.id, b.name]));
const teachers = new Set([...perf].filter(([, s]) => s.m >= Number(minMatches) && s.place / s.m <= Number(maxPlace)).map(([id]) => id));
console.error('teachers', [...teachers].map(id => `${name[id]}(${(perf.get(id)!.place / perf.get(id)!.m).toFixed(2)},${perf.get(id)!.m})`).join(' '));
const out = fs.createWriteStream(outFile);
let rows = 0, wins = 0;
for (const m of matches) {
  const market = [...(aucs.get(m.id) ?? [])].sort((a, b) => Number(BigInt(a.auctionId) - BigInt(b.auctionId)));
  const ws = [...(words.get(m.id) ?? [])].sort((a, b) => t(a.playedAt) - t(b.playedAt));
  for (const p of parts.get(m.id) ?? []) {
    if (!teachers.has(p.botId)) continue;
    // Initial rack inferred retrospectively: letters this bot played that it never bought (unplayed initial tiles stay unknown).
    const bought = new Map<string, number>(), played = new Map<string, number>();
    for (const a of market) if (a.winnerBotId === p.botId) bought.set(a.letter, (bought.get(a.letter) ?? 0) + 1);
    for (const w of ws) if (w.botId === p.botId) for (const c of w.word) played.set(c, (played.get(c) ?? 0) + 1);
    const rack = new Map<string, number>();
    for (const [c, n] of played) if (n > (bought.get(c) ?? 0)) rack.set(c, n - (bought.get(c) ?? 0));
    let cash = 100, score = 0, wi = 0;
    const mine = ws.filter(w => w.botId === p.botId);
    for (let i = 0; i < market.length; i++) {
      const a = market[i], closed = t(a.closedAt);
      // Words played before this auction closed (same-timestamp words are played after the previous auction's close, before this one).
      while (wi < mine.length && t(mine[wi].playedAt) < closed) { const w = mine[wi++]; cash += Number(w.totalReward); score += Number(w.totalReward); for (const c of w.word) { const n = (rack.get(c) ?? 0) - 1; if (n > 0) rack.set(c, n); else rack.delete(c); } }
      const won = a.winnerBotId === p.botId, bid = won ? topBid.get(a.auctionId) ?? Number(a.paid) : Number(a.paid);
      const rackArr = Array(26).fill(0); for (const [c, n] of rack) rackArr[c.charCodeAt(0) - 65] = n;
      out.write(JSON.stringify({ l: a.letter.charCodeAt(0) - 65, face: LETTER_VALUE[a.letter], bag: market.length - i - 1, cash, score, rack: rackArr, won: won ? 1 : 0, bid, bot: p.botId }) + '\n');
      rows++; if (won) wins++;
      if (won) { cash -= Number(a.paid); rack.set(a.letter, (rack.get(a.letter) ?? 0) + 1); }
    }
  }
}
out.end(); console.error(`matches ${matches.length} rows ${rows} wins ${wins}`);

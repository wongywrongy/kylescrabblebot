// Reactive self-play: six policy modules bid against each other with live Vickrey rules, so rivals respond to our bids.
// Usage: node --import tsx src/sim-selfplay.ts --matches 200 --seed 1 --out runs/x.json seat1.ts seat2.ts ... (6 seats; a seat repeats if fewer are given)
import fs from 'node:fs';
import path from 'node:path';
import { wordScore, LETTER_VALUE } from './strategy-trained-market.js';
import { remainingPool } from './remaining-pool.js';
const args = process.argv.slice(2);
const flag = (n: string, d: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const MATCHES = Number(flag('--matches', '100')), SEED = Number(flag('--seed', '1')), OUT = flag('--out', '');
const files = args.filter(a => a.endsWith('.ts'));
if (!files.length) throw new Error('Give at least one policy module');
const seats = Array.from({ length: 6 }, (_, i) => files[i % files.length]);
const modules = new Map<string, any>();
for (const f of new Set(seats)) modules.set(f, await import(path.resolve(f)));
const dictionary = fs.readFileSync('../spacetimedb/wordlist.txt', 'utf8').split('\n').map(w => w.trim().toUpperCase()).filter(w => w.length >= 2).sort((a, b) => b.length - a.length);
for (const m of modules.values()) m.chooseWord({ dictionary, myRack: new Map() });
const BAG = 'A9B2C2D4E12F2G3H2I9J1K1L4M2N6O8P2Q1R6S4T6U4V2W2X1Y2Z1'.match(/[A-Z]\d+/g)!.flatMap(x => [...x[0].repeat(Number(x.slice(1)))]);
function rng(seed: number) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; }; }
const TRACE = process.env.TRACE_OUT ? fs.createWriteStream(process.env.TRACE_OUT) : null;
const totals = seats.map(() => ({ score: 0, place: 0, wins: 0, bottom2: 0, tiles: 0, spent: 0 }));
for (let g = 0; g < MATCHES; g++) {
  const random = rng(SEED * 100003 + g);
  const pool = [...BAG];
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  // Rotate seats each game so no policy owns a tie-break position.
  const order = seats.map((_, i) => (i + g) % 6);
  const racks = order.map(() => new Map<string, number>()), initial: Map<string, number>[] = [];
  for (const r of racks) { for (let n = 0; n < 5; n++) { const c = pool.pop()!; r.set(c, (r.get(c) ?? 0) + 1); } initial.push(new Map(r)); }
  const balance = order.map(() => 100), score = order.map(() => 0), tiles = order.map(() => 0), spent = order.map(() => 0);
  const auctions = pool.splice(0, 68);
  const drawn: string[] = [], trace: any[] = [];
  for (let i = 0; i < auctions.length; i++) {
    const letter = auctions[i], bagRemaining = auctions.length - i - 1;
    drawn.push(letter);
    const bids = order.map((seat, k) => {
      const mod = modules.get(seats[seat]);
      const remainingLetters = mod.config?.observedTiles ? remainingPool(initial[k], drawn, bagRemaining, 25) : undefined;
      let word: string | null;
      while ((word = mod.chooseWord({ dictionary, myRack: racks[k], myBalance: balance[k], bagRemaining, remainingLetters }))) {
        for (const c of word) { if ((racks[k].get(c) ?? 0) <= 0) throw new Error(`${seats[seat]} played ${word} without tiles`); racks[k].set(c, racks[k].get(c)! - 1); }
        const reward = wordScore(word); score[k] += reward; balance[k] += reward;
      }
      const opponentBalances = balance.filter((_, j) => j !== k);
      if (TRACE) { const rack = Array(26).fill(0); for (const [c, n] of racks[k]) rack[c.charCodeAt(0) - 65] = n; trace.push({ k, rack, cash: balance[k], bag: bagRemaining, score: score[k], opp: opponentBalances.reduce((a, b) => a + b, 0) / 5, letter }); }
      const bid = mod.decideBid({ dictionary, myRack: racks[k], myBalance: balance[k], bagRemaining, remainingLetters, letter, auctionType: 'Vickrey', opponentBalances });
      if (!Number.isInteger(bid) || bid < 0 || bid > balance[k]) throw new Error(`${seats[seat]} bid ${bid} with ${balance[k]}`);
      return bid;
    });
    const top = Math.max(...bids);
    if (top <= 0) continue;
    const winners = bids.map((b, k) => b === top ? k : -1).filter(k => k >= 0);
    const w = winners[Math.floor(random() * winners.length)];
    const second = Math.max(0, ...bids.filter((_, k) => k !== w));
    const price = Math.max(1, winners.length > 1 ? top : second);
    balance[w] -= price; spent[w] += price; tiles[w]++;
    racks[w].set(letter, (racks[w].get(letter) ?? 0) + 1);
  }
  // Final word plays with the bag empty.
  order.forEach((seat, k) => { const mod = modules.get(seats[seat]); let word: string | null; while ((word = mod.chooseWord({ dictionary, myRack: racks[k], myBalance: balance[k], bagRemaining: 0 }))) { for (const c of word) racks[k].set(c, racks[k].get(c)! - 1); const reward = wordScore(word); score[k] += reward; balance[k] += reward; } });
  if (TRACE) for (const r of trace) TRACE.write(JSON.stringify({ ...r, final: score[r.k], place: 1 + score.filter(s => s > score[r.k]).length }) + '\n');
  order.forEach((seat, k) => { const place = 1 + score.filter(s => s > score[k]).length; const t = totals[seat]; t.score += score[k]; t.place += place; t.wins += Number(place === 1); t.bottom2 += Number(place >= 5); t.tiles += tiles[k]; t.spent += spent[k]; });
}
const summary = seats.map((f, i) => ({ seat: i, policy: f, meanScore: +(totals[i].score / MATCHES).toFixed(2), meanPlace: +(totals[i].place / MATCHES).toFixed(3), winRate: +(totals[i].wins / MATCHES).toFixed(3), bottom2Rate: +(totals[i].bottom2 / MATCHES).toFixed(3), tiles: +(totals[i].tiles / MATCHES).toFixed(1), spent: +(totals[i].spent / MATCHES).toFixed(0) }));
const byPolicy: Record<string, any> = {};
for (const s of summary) { const b = byPolicy[s.policy] ??= { policy: s.policy, seats: 0, meanScore: 0, meanPlace: 0, winRate: 0, bottom2Rate: 0 }; b.seats++; for (const k of ['meanScore', 'meanPlace', 'winRate', 'bottom2Rate'] as const) b[k] += s[k]; }
const table = Object.values(byPolicy).map((b: any) => ({ policy: b.policy, seats: b.seats, meanScore: +(b.meanScore / b.seats).toFixed(2), meanPlace: +(b.meanPlace / b.seats).toFixed(3), winRate: +(b.winRate / b.seats).toFixed(3), bottom2Rate: +(b.bottom2Rate / b.seats).toFixed(3) }));
console.table(table);
if (OUT) fs.writeFileSync(OUT, JSON.stringify({ matches: MATCHES, seed: SEED, seats, summary, table, env: { BID_UPLIFT_FACTOR: process.env.BID_UPLIFT_FACTOR, PREMIUM_FACTOR: process.env.PREMIUM_FACTOR, CHEAP_FACTOR: process.env.CHEAP_FACTOR, HOLD_UNTIL: process.env.HOLD_UNTIL } }, null, 2));

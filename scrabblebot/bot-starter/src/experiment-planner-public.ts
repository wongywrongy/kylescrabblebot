// Replay policies against frozen opponent bids from runs/public-history.json.
// Usage: node --import tsx src/sim-public.ts src/strategy.ts [more policies...] [--seeds N] [--min 400]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { wordScore } from './strategy.js';

const args = process.argv.slice(2);
const flag = (n: string, d: number) => { const i = args.indexOf(n); return i >= 0 ? Number(args[i + 1]) : d; };
const SEEDS = flag('--seeds', 1), MIN_ID = flag('--min', 400);
const shardArg = [0,1];
const files = args.filter(a => a.endsWith('.ts'));
const dictionary = fs.readFileSync('../spacetimedb/wordlist.txt', 'utf8').split('\n').map(w => w.trim().toUpperCase()).filter(w => w.length >= 2).sort((a, b) => b.length - a.length);
const hist = JSON.parse(fs.readFileSync('runs/public-history.json', 'utf8'));
const sim = new Set(hist.bots.filter((b: any) => b.isSimulated).map((b: any) => b.id));
const parts = new Map<string, any[]>();
for (const p of hist.participants) (parts.get(p.matchId) ?? parts.set(p.matchId, []).get(p.matchId)!).push(p);
const topBid = new Map<string, number>(hist.topBids.map((t: any) => [t.auctionId, Number(t.topBid)]));
const auctionsBy = new Map<string, any[]>();
for (const a of hist.auctions) (auctionsBy.get(a.matchId) ?? auctionsBy.set(a.matchId, []).get(a.matchId)!).push(a);
const matches = hist.matches.filter((m: any) => m.status.tag === 'Ended' && m.auctionType.tag === 'Vickrey' && Number(m.id) >= MIN_ID && Number(m.id) <= 698
  && (parts.get(m.id) ?? []).filter(p => !sim.has(p.botId)).length >= 4)
  .map((m: any) => ({ id: m.id, auctions: auctionsBy.get(m.id)!.sort((a, b) => Number(BigInt(a.auctionId) - BigInt(b.auctionId))), scores: parts.get(m.id)!.map(p => Number(p.score)).sort((a, b) => b - a) }));
const BAG = 'A9B2C2D4E12F2G3H2I9J1K1L4M2N6O8P2Q1R6S4T6U4V2W2X1Y2Z1'.match(/[A-Z]\d+/g)!.flatMap(x => x[0].repeat(Number(x.slice(1))).split(''));
function rng(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }

const output:any[]=[];
for (const file of files) {
  const policy = await import(path.resolve(file));
  policy.chooseWord({dictionary,myRack:new Map()});
  const t0 = performance.now();
  const timings:number[]=[];
  const rows: any[] = [];
  for (const m of matches.filter((_: any, i: number) => i % shardArg[1] === shardArg[0])) for (let seed = 0; seed < SEEDS; seed++) {
    const r = rng(Number(m.id) * 1000 + seed);
    // Starting rack: 5 tiles drawn from the bag minus the letters that were auctioned.
    const pool = [...BAG]; for (const a of m.auctions) { const i = pool.indexOf(a.letter); if (i >= 0) pool.splice(i, 1); }
    const rack = new Map<string, number>();
    for (let n = 0; n < 5 && pool.length; n++) { const i = Math.floor(r() * pool.length); const c = pool.splice(i, 1)[0]; rack.set(c, (rack.get(c) ?? 0) + 1); }
    let score = 0, balance = 100, spent = 0, acquired = 0; const played: string[] = [];
    for (let i = 0; i < m.auctions.length; i++) {
      const a = m.auctions[i], bagRemaining = m.auctions.length - i - 1;
      let word: string | null;
      const choose=()=>{const started=performance.now();const word=policy.chooseWord({ dictionary, myRack: rack, myBalance: balance, bagRemaining });timings.push(performance.now()-started);return word;};
      while ((word = choose())) {
        for (const c of word) { if ((rack.get(c) ?? 0) <= 0) throw new Error(`${file}: ${word} not in rack`); rack.set(c, rack.get(c)! - 1); }
        const reward = wordScore(word); balance += reward; score += reward; played.push(word);
      }
      const started=performance.now();
      const bid = policy.decideBid({ dictionary, myRack: rack, myBalance: balance, bagRemaining, letter: a.letter, auctionType: 'Vickrey' });
      timings.push(performance.now()-started);
      if (!Number.isInteger(bid) || bid < 0 || bid > balance) throw new Error(`${file}: bad bid ${bid} balance ${balance}`);
      const opp = topBid.get(a.auctionId) ?? 0;
      if (bid > 0 && bid > opp) { const price = Math.max(1, opp); balance -= price; spent += price; acquired++; rack.set(a.letter, (rack.get(a.letter) ?? 0) + 1); }
    }
    const place = 1 + m.scores.filter((s: number) => s > score).length;
    rows.push({ matchId:m.id, seed, score, place, win: place === 1 ? 1 : 0, spent, acquired, balance, words: played.length, long: played.filter(w => w.length >= 7).length, tiles: [...rack.values()].reduce((a, b) => a + b, 0) });
  }
  const mean = (k: string) => rows.reduce((n, r) => n + r[k], 0) / rows.length;
  const out: Record<string, number> = {};
  for (const k of ['score', 'win', 'place', 'spent', 'acquired', 'balance', 'words', 'long', 'tiles']) out[k] = +mean(k).toFixed(2);
  timings.sort((a,b)=>a-b);
  output.push({policy:file,sourceSha256:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),summary:out,latency:{calls:timings.length,p95:timings[Math.floor(timings.length*.95)],p99:timings[Math.floor(timings.length*.99)],max:timings.at(-1),over100:timings.filter(t=>t>=100).length},rows});
  fs.writeFileSync('runs/research-planner-public.json',JSON.stringify({note:'Frozen99human-heavy matches600–698; same synthetic startingracks across policies, fixed rival topbids, prior-only availability. Place/wins are comparisons with original score thresholds, not an interactive simulation.',policies:output},null,2));
  if (args.includes('--json')) console.log(JSON.stringify({ file, n: rows.length, sums: Object.fromEntries(Object.keys(out).map(k => [k, rows.reduce((a, r) => a + r[k], 0)])) }));
  else console.log(path.basename(file).padEnd(28), JSON.stringify(out), `${rows.length} games, ${((performance.now() - t0) / rows.length).toFixed(1)}ms/game`);
}

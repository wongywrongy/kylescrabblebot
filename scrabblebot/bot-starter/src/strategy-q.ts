// Learned Q bidder: Q(state, letter, bid) from ml/train_q.py; bid = argmax over a grid. Words from hold-seven. Q_MODEL, Q_MAX_BID, Q_EXPLORE (random factor for trace generation).
import fs from 'node:fs';
import * as base from './experiment-gain-policy.js';
export { wordScore, LETTER_VALUE } from './strategy-market.js';
const MODEL = process.env.Q_MODEL ?? 'runs/q/model.json', MAX_BID = Number(process.env.Q_MAX_BID ?? 50), EXPLORE = Number(process.env.Q_EXPLORE ?? 0);
const model = JSON.parse(fs.readFileSync(MODEL, 'utf8')) as { layers: { w: number[][]; b: number[] }[] };
export const config = { ...base.config, qModel: MODEL, qMaxBid: MAX_BID, qExplore: EXPLORE };
export const chooseWord = base.chooseWord;
function Q(x: number[]): number {
  let v = x;
  model.layers.forEach((l, i) => { v = l.w.map((row, j) => { let s = l.b[j]; for (let k = 0; k < row.length; k++) s += row[k] * v[k]; return i < model.layers.length - 1 ? Math.max(0, s) : s; }); });
  return v[0];
}
type Ctx = Parameters<typeof base.decideBid>[0] & { opponentBalances?: number[] };
export function decideBid(ctx: Ctx): number {
  if ((ctx.bagRemaining ?? 0) === 0) return 0;
  const rack = Array(26).fill(0); let size = 0; for (const [c, n] of ctx.myRack) { rack[c.charCodeAt(0) - 65] = n; size += n; }
  const letter = Array(26).fill(0); letter[ctx.letter.charCodeAt(0) - 65] = 1;
  const opp = ctx.opponentBalances?.length ? ctx.opponentBalances.reduce((a, b) => a + b, 0) / ctx.opponentBalances.length : 100;
  const head = [Math.min(ctx.myBalance, 250) / 100, (ctx.bagRemaining ?? 68) / 68, Math.min(opp, 250) / 100, size / 10];
  let best = 0, bestQ = -Infinity;
  for (let bid = 0; bid <= Math.min(ctx.myBalance, MAX_BID); bid++) {
    const q = Q([...head, bid / 30, (bid / 30) ** 2, bid > 0 ? 1 : 0, ...letter, ...rack.map(n => n / 3)]);
    if (q > bestQ) { bestQ = q; best = bid; }
  }
  if (EXPLORE > 0 && Math.random() < EXPLORE) best = Math.round(best * (0.5 + Math.random()));
  return Math.max(0, Math.min(ctx.myBalance, best));
}

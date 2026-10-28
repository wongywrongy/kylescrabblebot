// Learned value bidder: V(state) from ml/train_value.py predicts future score; bid the largest price at which owning the letter still raises V. Words from hold-seven.
import fs from 'node:fs';
import * as base from './experiment-gain-policy.js';
export { wordScore, LETTER_VALUE } from './strategy-market.js';
const MODEL = process.env.VALUE_MODEL ?? 'runs/value/model.json', MARGIN = Number(process.env.VALUE_MARGIN ?? 0), MAX_BID = Number(process.env.VALUE_MAX_BID ?? 60);
const model = JSON.parse(fs.readFileSync(MODEL, 'utf8')) as { layers: { w: number[][]; b: number[] }[] };
export const config = { ...base.config, valueModel: MODEL, valueMargin: MARGIN, valueMaxBid: MAX_BID };
export const chooseWord = base.chooseWord;
function V(x: number[]): number {
  let v = x;
  model.layers.forEach((l, i) => { v = l.w.map((row, j) => { let s = l.b[j]; for (let k = 0; k < row.length; k++) s += row[k] * v[k]; return i < model.layers.length - 1 ? Math.max(0, s) : s; }); });
  return v[0];
}
type Ctx = Parameters<typeof base.decideBid>[0] & { opponentBalances?: number[] };
function feats(rack: number[], size: number, cash: number, ctx: Ctx) {
  const opp = ctx.opponentBalances?.length ? ctx.opponentBalances.reduce((a, b) => a + b, 0) / ctx.opponentBalances.length : 100;
  return [Math.min(cash, 250) / 100, (ctx.bagRemaining ?? 68) / 68, Math.min(opp, 250) / 100, size / 10, ...rack.map(n => n / 3)];
}
export function decideBid(ctx: Ctx): number {
  if ((ctx.bagRemaining ?? 0) === 0) return 0;
  const rack = Array(26).fill(0); let size = 0; for (const [c, n] of ctx.myRack) { rack[c.charCodeAt(0) - 65] = n; size += n; }
  const before = V(feats(rack, size, ctx.myBalance, ctx));
  const withL = [...rack]; withL[ctx.letter.charCodeAt(0) - 65]++;
  // Future score lost per coin is what V says; search the break-even price (V is smooth, so step by 1 and stop at the first loss).
  let bid = 0;
  for (let p = 1; p <= Math.min(ctx.myBalance, MAX_BID); p++) { if (V(feats(withL, size + 1, ctx.myBalance - p, ctx)) - before < MARGIN) break; bid = p; }
  return Math.max(0, Math.min(ctx.myBalance, bid));
}

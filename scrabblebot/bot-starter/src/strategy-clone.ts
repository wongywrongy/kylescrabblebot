// Behavioural clone of the top live bots' bidding (ml/train_clone.py MLP); words from hold-seven. CLONE_MODEL path, CLONE_BLEND mixes with the trained bidder (1 = pure clone).
import fs from 'node:fs';
import * as base from './experiment-gain-policy.js';
import { LETTER_VALUE } from './strategy-market.js';
export { wordScore, LETTER_VALUE } from './strategy-market.js';
const MODEL = process.env.CLONE_MODEL ?? 'runs/clone/model.json', BLEND = Number(process.env.CLONE_BLEND ?? 1);
const model = JSON.parse(fs.readFileSync(MODEL, 'utf8')) as { layers: { w: number[][]; b: number[] }[] };
export const config = { ...base.config, cloneModel: MODEL, cloneBlend: BLEND };
export const chooseWord = base.chooseWord;
function forward(x: number[]): number {
  let v = x;
  model.layers.forEach((l, i) => { v = l.w.map((row, j) => { let s = l.b[j]; for (let k = 0; k < row.length; k++) s += row[k] * v[k]; return i < model.layers.length - 1 ? Math.max(0, s) : s; }); });
  const z = v[0]; return z > 20 ? z : Math.log1p(Math.exp(z)); // softplus
}
export function decideBid(ctx: Parameters<typeof base.decideBid>[0]): number {
  if ((ctx.bagRemaining ?? 0) === 0) return 0;
  const f = Array(26).fill(0); f[ctx.letter.charCodeAt(0) - 65] = 1;
  const rack = Array(26).fill(0); let size = 0; for (const [c, n] of ctx.myRack) { rack[c.charCodeAt(0) - 65] = n; size += n; }
  const clone = forward([...f, LETTER_VALUE[ctx.letter] / 10, (ctx.bagRemaining ?? 68) / 68, Math.min(ctx.myBalance, 200) / 100, 0 /* score unknown live: use 0 */, size / 10, ...rack.map(n => n / 3)]);
  const bid = BLEND >= 1 ? clone : BLEND * clone + (1 - BLEND) * base.decideBid(ctx);
  return Math.max(0, Math.min(ctx.myBalance, Math.round(bid)));
}

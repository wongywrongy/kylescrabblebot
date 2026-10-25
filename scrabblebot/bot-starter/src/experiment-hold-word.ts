// Offline variant: hold a seven-letter word while the bag is deep and cash is healthy, hoping to extend it to eight.
import * as base from './strategy-trained-market.js';
export { wordScore, LETTER_VALUE } from './strategy-trained-market.js';
const HOLD_UNTIL = Number(process.env.HOLD_UNTIL ?? 35), HOLD_CASH = Number(process.env.HOLD_CASH ?? 20);
export const config = { ...base.config, holdUntil: HOLD_UNTIL, holdCash: HOLD_CASH };
export const decideBid = base.decideBid;
export function chooseWord(ctx: Parameters<typeof base.chooseWord>[0]) {
  const word = base.chooseWord(ctx);
  if (word && word.length === 7 && (ctx.bagRemaining ?? 0) > HOLD_UNTIL && (ctx.myBalance ?? 0) >= HOLD_CASH) return null;
  return word;
}

import * as market from './strategy-market.js';
import type { WordContext } from './strategy-montecarlo.js';

export { decideBid, wordScore, LETTER_VALUE } from './strategy-market.js';
export const config = { ...market.config, observedTiles: false, weakRackEarlyLiquidation: true };

export function chooseWord(ctx: WordContext): string | null {
  if ((ctx.bagRemaining ?? 68) > 40 && (ctx.myBalance ?? 100) >= 30) {
    const face = [...ctx.myRack].reduce((sum, [letter, count]) => sum + market.LETTER_VALUE[letter] * count, 0);
    if (face <= 10) {
      const best = market.chooseWord({ ...ctx, bagRemaining: 0 });
      if (best && best.length >= 5 && market.wordScore(best) <= 15) return best;
    }
  }
  return market.chooseWord(ctx);
}

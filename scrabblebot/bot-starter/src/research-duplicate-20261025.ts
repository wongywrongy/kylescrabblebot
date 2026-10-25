import * as market from './strategy-market.js';
import type {BidContext} from './strategy-market.js';
export {chooseWord, wordScore, LETTER_VALUE} from './strategy-market.js';
export const config = {...market.config, duplicateGuard: 3, observedTiles: false};
export function decideBid(ctx: BidContext): number {
  if ((ctx.myRack.get(ctx.letter) ?? 0) >= 3) {
    const before = market.chooseWord({...ctx, bagRemaining: 0});
    const rack = new Map(ctx.myRack);
    rack.set(ctx.letter, (rack.get(ctx.letter) ?? 0) + 1);
    const after = market.chooseWord({...ctx, myRack: rack, bagRemaining: 0});
    if ((after ? market.wordScore(after) : 0) <= (before ? market.wordScore(before) : 0)) return 0;
  }
  return market.decideBid(ctx);
}

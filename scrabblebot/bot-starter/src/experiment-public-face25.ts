// Pin the existing face-policy parameter: 2*face+9 + .5*(face-1).
import * as face from './experiment-face-policy.js';
export const chooseWord = face.chooseWord;
export const decideBid = (ctx: face.BidContext) => face.decideBid(ctx, 0.5);

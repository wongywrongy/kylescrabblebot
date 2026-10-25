import { chooseWord as fastChoose, type WordContext } from './experiment-mc-fast.js';
export { LETTER_VALUE, wordScore, decideBid } from './experiment-mc-fast.js';
export const chooseWord = (ctx: WordContext) => fastChoose(ctx, true);

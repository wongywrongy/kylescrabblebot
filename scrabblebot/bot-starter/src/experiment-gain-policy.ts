// Offline variant: trained-market bidder with a non-default parameter vector (GAIN_PARAMS), hold-seven word timing.
import { createPolicy } from './strategy-trained-market.js';
import * as hold7 from './experiment-hold-word.js';
export { wordScore, LETTER_VALUE } from './strategy-trained-market.js';
const params = JSON.parse(process.env.GAIN_PARAMS ?? '[1,1,1,10,0,1]');
const policy = createPolicy(params, 'market', 64, true);
export const config = { ...policy.config, holdUntil: hold7.config.holdUntil, holdCash: hold7.config.holdCash };
export const decideBid = policy.decideBid;
export const chooseWord = hold7.chooseWord;

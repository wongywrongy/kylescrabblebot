// Per-task mix for offline replay: BID_STRATEGY picks decideBid, WORD_STRATEGY picks chooseWord.
import * as baseline from './baseline.js';
import * as value from './strategy.js';
import * as montecarlo from './strategy-montecarlo.js';
import * as market from './strategy-market.js';
import * as trainedMarket from './strategy-trained-market.js';
const modules: Record<string, { chooseWord: Function; decideBid: Function; config?: object }> = { baseline, value, montecarlo, 'montecarlo-pool': montecarlo, market, 'trained-market': trainedMarket };
const pick = (name: string) => modules[name] ?? (() => { throw new Error(`Unknown strategy ${name}`); })();
const bid = pick(process.env.BID_STRATEGY ?? 'trained-market'), word = pick(process.env.WORD_STRATEGY ?? 'trained-market');
export const config = { ...bid.config, bidStrategy: process.env.BID_STRATEGY, wordStrategy: process.env.WORD_STRATEGY };
export const decideBid = bid.decideBid as typeof trainedMarket.decideBid;
export const chooseWord = word.chooseWord as typeof trainedMarket.chooseWord;

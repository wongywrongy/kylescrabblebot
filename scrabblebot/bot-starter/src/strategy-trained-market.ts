import fs from 'node:fs';
import { createHash } from 'node:crypto';
import * as market from './strategy-market.js';
import * as learned from './strategy-learned-market.js';
import type { BidContext, WordContext } from './strategy-market.js';
export { wordScore, LETTER_VALUE } from './strategy-market.js';

export const defaults = [1, 1, 1, 10, 0, 1];
export const bounds = [[0.55, 1.45], [0.55, 1.45], [0.55, 1.45], [10, 35], [0, 1.4], [0.45, 1]];
export function validateParameters(input: unknown): number[] {
  if (!Array.isArray(input) || input.length !== bounds.length || input.some((v, i) =>
    !Number.isFinite(v) || v < bounds[i][0] || v > bounds[i][1])) throw new Error('Invalid trained policy parameters');
  return [...input];
}

export function createPolicy(input: unknown, priceSource = 'market', futureMarkets = 8, observedTiles = false) {
  if (typeof observedTiles !== 'boolean') throw new Error('Invalid observed tile setting');
  const p = validateParameters(input);
  if (!Number.isInteger(futureMarkets) || futureMarkets < 1 || futureMarkets > 64) throw new Error("Invalid market sample count");
  if (!['market', 'learned-market'].includes(priceSource)) throw new Error('Invalid policy price source');
  const base = priceSource === 'market' ? market : learned;
  return {
    config: { ...base.config, policyParameters: p, priceSource, futureMarkets, observedTiles },
    chooseWord(ctx: WordContext) {
      const cash = ctx.myBalance ?? 100;
      return base.chooseWord({ ...ctx, myBalance: cash < p[3] ? Math.min(cash, 9) : cash });
    },
    decideBid(ctx: BidContext): number {
      if (!observedTiles && ctx.remainingLetters) ctx = { ...ctx, remainingLetters: undefined };
      const bid = priceSource === 'market' ? market.decideBid(ctx, undefined, futureMarkets) : learned.decideBid(ctx, futureMarkets);
      const remaining = ctx.bagRemaining ?? 68;
      if (ctx.myBalance <= 0 || remaining <= 5 || remaining > 68 || ctx.auctionType === 'FirstPrice') return bid;
      let gain = 0;
      if (p[4] > 0 || p[5] < 1) {
        const rack = new Map(ctx.myRack);
        rack.set(ctx.letter, (rack.get(ctx.letter) ?? 0) + 1);
        const before = market.chooseWord({ ...ctx, bagRemaining: 0 });
        const after = market.chooseWord({ ...ctx, myRack: rack, bagRemaining: 0 });
        gain = Math.max(0, (after ? market.wordScore(after) : 0) - (before ? market.wordScore(before) : 0));
      }
      const scale = p[remaining > 45 ? 0 : remaining > 20 ? 1 : 2];
      // Keep cash for later auctions unless this tile improves an immediately payable word.
      const cap = gain > 0 ? ctx.myBalance : Math.floor(ctx.myBalance * p[5]);
      return Math.max(0, Math.min(cap, Math.round(Math.max(bid * scale, gain * p[4]))));
    },
  };
}

const file = process.env.POLICY_MODEL;
const modelText = file ? fs.readFileSync(file, 'utf8') : undefined;
const artifact = modelText ? JSON.parse(modelText) : undefined;
if (artifact && artifact.version !== 1) throw new Error('Invalid policy model version');
const policy = createPolicy(artifact?.parameters ?? (process.env.POLICY_PARAMS ? JSON.parse(process.env.POLICY_PARAMS) : defaults),
  artifact?.priceSource ?? process.env.POLICY_PRICE_SOURCE ?? 'market',
  artifact?.futureMarkets ?? Number(process.env.POLICY_MARKETS ?? 8),
  artifact?.observedTiles === undefined ? JSON.parse(process.env.POLICY_OBSERVED_TILES ?? 'false') : artifact.observedTiles);
export const config = { ...policy.config, policyModel: modelText && { path: file, sha256: createHash('sha256').update(modelText).digest('hex') } };
export const { chooseWord, decideBid } = policy;

import fs from 'node:fs';
import { createHash } from 'node:crypto';
import * as market from './strategy-market.js';
import type { BidContext, WordContext } from './strategy-market.js';
export { wordScore, LETTER_VALUE } from './strategy-market.js';

export function validateLearnedPrices(input: unknown): number[][][] {
  if (!input || typeof input !== 'object') throw new Error('Invalid learned price model');
  const data = input as { version?: number; prices?: number[][][]; pricesSha256?: string };
  const prices = data.prices;
  if (data.version !== 1 || !Array.isArray(prices) || prices.length !== 68 ||
      prices.some(phase => !Array.isArray(phase) || phase.length !== 26 ||
        phase.some(row => !Array.isArray(row) || row.length !== 128 ||
          row.some((price, i) => !Number.isSafeInteger(price) || price < 0 || price > 200 || (i > 0 && price < row[i - 1]))))) {
    throw new Error('Invalid learned price table');
  }
  if (createHash('sha256').update(JSON.stringify(prices)).digest('hex') !== data.pricesSha256) throw new Error('Learned price hash mismatch');
  return prices;
}

const modelPath = process.env.MARKET_MODEL;
const artifact = modelPath ? JSON.parse(fs.readFileSync(modelPath, 'utf8')) : undefined;
const prices = artifact ? validateLearnedPrices(artifact) : undefined;
export const config = { ...market.config, learnedPrices: artifact && {
  path: modelPath, sha256: artifact.pricesSha256, provenance: artifact.provenance,
} };
function requireModel() {
  if (!prices) throw new Error('Set MARKET_MODEL to a trained model.json before using learned-market');
  return prices;
}
export function chooseWord(ctx: WordContext) {
  requireModel();
  return market.chooseWord(ctx);
}
export function decideBid(ctx: BidContext, count = 8): number {
  const table = requireModel();
  // shortcut: training covers 68-auction Vickrey games; retain the frozen policy outside that domain.
  return market.decideBid(ctx, ctx.auctionType === 'FirstPrice' || (ctx.bagRemaining ?? 68) > 68 ? undefined : table, count);
}

// Offline research variants; each factory call owns one match's pacing state.
import * as candidate from './strategy-candidate.js';
import type { BidContext, WordContext } from './strategy.js';

export type Variant = 'pace' | 'pace-no-ramp' | 'spend-1.5' | 'spend-2' | 'spend-3' | 'frontload' | 'short' | 'hold6' | 'short-unpaced' | 'hold6-unpaced' | 'completion-unpaced';
export interface Policy {
  decideBid(ctx: BidContext): number;
  chooseWord(ctx: WordContext): string | null;
  observe?(spent: number): void;
  multiplier?(): number;
}

type Word = { text: string; score: number; needs: [string, number][] };
const indexes = new WeakMap<string[], Word[]>();
const caches = new WeakMap<Map<string, number>, { key: string; playable: Word[]; completion: number[] }>();
function analyze(ctx: WordContext) {
  const key = [...ctx.myRack].filter(([, n]) => n).sort().join();
  const cached = caches.get(ctx.myRack);
  if (cached?.key === key) return cached;
  let index = indexes.get(ctx.dictionary);
  if (!index) {
    index = ctx.dictionary.map(text => {
      const needs = new Map<string, number>();
      for (const c of text) needs.set(c, (needs.get(c) ?? 0) + 1);
      return { text, score: candidate.wordScore(text), needs: [...needs] };
    }).sort((a, b) => b.score - a.score || b.text.length - a.text.length || a.text.localeCompare(b.text));
    indexes.set(ctx.dictionary, index);
  }
  const tiles = [...ctx.myRack.values()].reduce((a, b) => a + b, 0);
  const playable: Word[] = [], completion = Array<number>(26).fill(0);
  for (const word of index) {
    if (word.text.length > tiles + 1) continue;
    let missing = '', fits = true;
    for (const [c, n] of word.needs) {
      const deficit = n - (ctx.myRack.get(c) ?? 0);
      if (deficit <= 0) continue;
      if (deficit > 1 || missing) { fits = false; break; }
      missing = c;
    }
    if (!fits) continue;
    if (!missing) playable.push(word);
    else completion[missing.charCodeAt(0) - 65] = Math.max(completion[missing.charCodeAt(0) - 65], word.score);
  }
  const result = { key, playable, completion };
  caches.set(ctx.myRack, result);
  return result;
}

export function createPolicy(variant: Variant, epsilon = 0.02): Policy {
  let mu = 0, target = 0, spent: number | undefined, auction = 0;
  return {
    multiplier: () => mu,
    observe(amount) { spent = amount; },
    chooseWord(ctx) {
      if (!variant.startsWith('short') && !variant.startsWith('hold6')) return candidate.chooseWord(ctx);
      const { playable } = analyze(ctx);
      return playable.find(w => variant.startsWith('short') ? w.score >= 6
        : (ctx.bagRemaining ?? 0) <= 5 || w.text.length >= 6)?.text ?? null;
    },
    decideBid(ctx) {
      // Consume only the completed previous auction, never the current clearing price.
      if (spent !== undefined) { mu = Math.max(-0.5, Math.min(2, mu + epsilon * (spent - target))); spent = undefined; }
      target = ctx.myBalance / Math.max(1, ctx.bagRemaining ?? 68);
      auction++;
      if (ctx.myBalance <= 0 || ctx.bagRemaining === 0) return 0;
      const { completion, playable } = analyze(ctx);
      const completed = completion[ctx.letter.charCodeAt(0) - 65] ?? 0;
      if (variant.startsWith('spend-')) {
        if ('JQXZ'.includes(ctx.letter) && !completed) return 0;
        return Math.min(ctx.myBalance, Math.round(target * Number(variant.slice(6))));
      }
      // Asking the existing valuation with ample cash removes its balance clipping.
      let value = candidate.decideBid({ ...ctx, myBalance: 1_000_000, bagRemaining: Math.max(6, ctx.bagRemaining ?? 68), opponentBalances: undefined });
      if (variant === 'hold6' || variant === 'completion-unpaced') value = completed;
      if (variant === 'frontload' && auction <= 20) value = 3 * value / 16;
      else if (!variant.endsWith('-unpaced')) value /= 1 + mu;
      if ((ctx.bagRemaining ?? 68) <= 5 && variant !== 'pace-no-ramp') {
        const gain = Math.max(0, completed - (playable[0]?.score ?? 0));
        return gain > 0 ? candidate.decideBid(ctx) : 0;
      }
      return Math.max(0, Math.min(ctx.myBalance, Math.round(value)));
    },
  };
}

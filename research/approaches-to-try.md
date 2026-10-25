# Approaches to try, side by side

Date: 2026-10-24. Each entry is one `strategy.ts` variant. Theory ranks them; the replay harness and live matches decide.

## Step 0: let the harness run N variants
`src/index.ts` and `src/analyze.ts` hardcode `baseline` and `value`. Change `STRATEGY` to load `./strategies/${STRATEGY}.ts` (keep the file-hash + copy-to-run-dir logic). Then each approach below is one file in `src/strategies/`. Run each for the same number of matches, compare `runs/summary.json` on: place, score, spent, balance-at-end, unusedTiles, meanWordLength.

Fixed facts to code against: 100 tiles in the bag, 6 players, 5 starting tiles each, 100 starting balance, roughly 68 auctions per match, 1-second bid window, Vickrey default.

Kill metric for ALL variants: a strategy that ends matches with balance > 30 on average is stranding cash. That is the current failure and it dominates everything else.

---

## A. pace — dual-multiplier budget pacing
Theory: Balseiro & Gur.
```
target = balance / max(1, bagRemaining)
bid    = value / (1 + mu)
mu    += eps * (spentThisAuction - target)   // eps ~ 0.02, clamp mu to [-0.5, 2]
```
`value` is the current `decideBid` formula minus the `budget` cap. Negative mu late = pay above private value to convert cash.
Hypothesis: fixes stranded cash with no other change. Should move us from 6th to mid-table alone.
Dies if: balance still > 30 at end, or we win many tiles we never play (unusedTiles up).

## B. spend-down — naive linear burn
No theory, pure practice test.
```
bid = min(balance, round(balance / max(1, bagRemaining) * k))   // k in {1.5, 2, 3}
```
Ignore letter value entirely except: 0 for J/Q/X/Z unless they complete a word.
Hypothesis: in a field of under-bidders, simply converting cash to tiles at a steady rate beats clever valuation. If this ties with A, valuation is not where the edge is.
Dies if: lots of tiles, few words (we buy junk).

## C. frontload — spend 60% in first 20 auctions
Theory: income compounds. A word played at auction 15 funds bids for 50 more auctions; a word at auction 60 funds nothing.
```
phaseBudget = bagRemaining > 48 ? 0.6*startBalance/20 per auction : paceRule(A)
bid = min(phaseBudget * (value / meanValue), balance)
```
Hypothesis: beats A on score because early words reinvest.
Dies if: early overpay leaves us unable to complete words mid-game (score flat after auction 30).

## D. marginal2 — two-tile lookahead valuation
Theory: Greenwald & Boyan expected marginal utility.
Extend `analyze()` to also record `completion2[c][d]` = best word score needing exactly c and d. Letter value for c = max(completion[c], sum over d of P(d drawn next | bag) × completion2[c][d]). Bag composition = DEFAULT_BAG minus all auctioned letters so far (public).
Use pacing from A on top.
Hypothesis: lifts meanWordLength (more 6-7 letter words) vs A.
Dies if: compute exceeds the 1-second window on a 10-tile rack, or no score gain over A.

## E. short-words — play 3-4 letter words immediately, never hold
Anti-theory. Current chooseWord holds for 7-letter words.
```
chooseWord: play the highest-scoring playable word as soon as score >= 6
decideBid: A
```
Hypothesis: cash velocity beats length bonus. 10 words at 8 points = 80, one 7-letter word at 3x may never come.
Dies if: score lower than A with same spend.

## F. hoard7 — opposite of E
Only play words of length >= 6. Bid on letters by `completion` only (no base value for unmatched letters). Dump everything playable when bagRemaining <= 5.
Hypothesis: the 3x multiplier dominates when tiles are cheap. Direct test of the hold-vs-play tradeoff against E.

## G. priceline — bid the empirical clearing price
Theory: TAC price prediction.
Offline: from all `runs/*/match-*.json`, table P[letter][phase] = 75th percentile of `paid`, phase = bagRemaining quartile. Ship as JSON.
```
bid = gain > 0 ? min(balance, max(P[letter][phase] + 1, gain)) : P[letter][phase] * (value > median ? 1 : 0)
```
Hypothesis: we lose on price, not value; bidding one above the going rate wins the tiles we want.
Dies if: table is stale (opponent mix changes), spend explodes.

## H. vowel-balance — rack composition controller
Theory: market-maker inventory skew. Target rack ratio 40% vowels. Bid multiplier = 1 + 0.8 × (targetVowelRatio − currentVowelRatio) × (vowel ? 1 : −1). Everything else from A.
Hypothesis: most unplayable racks die from vowel starvation or vowel glut. Cheap to test.

## I. blocker — endgame denial
Reconstruct opponent racks from `auction_result` wins minus `word_play` letters. In the last 10 auctions, if the leader is one letter from a 7-letter word and that letter comes up, bid up to our full balance on it.
Hypothesis: converts 2nd place into 1st in close matches; irrelevant otherwise.
Dies if: reconstruction is wrong (verify against our own rack first, which we do know).

## J. copycat — mirror the winner
Each match, after 20 auctions, identify the bot with the highest score and set our per-letter bid to its observed average `paid` for that letter × 1.1. Pure empirical.
Hypothesis: the field already contains a good bidder; cloning its prices is cheaper than deriving them.
Dies if: the leader is leading because of rack luck, not prices.

## K. firstprice-shade — only matters in FirstPrice matches
In Vickrey bid truthfully (approaches above). In FirstPrice bid the predicted second-highest from table G, not `value * 0.8`.
Run only if FirstPrice matches appear in the lobby mix.

---

## Suggested order
A first (it is the fix for the known failure and the base for D, E, F, H, I). Then B and E in parallel because they are the cheapest and most informative "theory is wrong" tests. Then D, G. C, F, H, I, J only if A leaves us below 3rd.

## What to record per variant
Already in summary.json: place, score, spent, balance, unusedTiles, words, meanWordLength. Add: auctionsWon, meanPaid, scoreAtAuction20 (early income), and the mu trace for A. Ten live matches per variant minimum; the field is 5 opponents and variance is high.

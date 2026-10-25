# Does awesome-quant-ai help the scrabblebot problem?

Date: 2026-10-24. Source: research/awesome-quant-ai (shallow clone of leoncuhk/awesome-quant-ai).

## Our problem, stated as a decision problem
- 68 sequential sealed-bid auctions (Vickrey by default) over a known 100-tile Scrabble bag, 6 players, ~100 starting balance.
- Private value of a letter = marginal word score it unlocks (already computed by `analyze()` in strategy.ts).
- Currency only matters as score when converted to words; unspent balance at match end is worth 0.
- Opponents' clearing prices are PUBLIC after each auction (`auction_result.paid`, `topBids` archive). Opponent racks are reconstructible from auction wins minus word plays.

Observed failure in runs/summary.json: our bot finishes 6th with 105-126 unspent balance and 0 spend in 4 of 5 matches. We are losing on price, not valuation. The one match where it spent (137) it placed 4th with 72 points.

## What the list is actually about
~95% equities/crypto market microstructure, factor investing, regime detection, LLM trading agents, backtesting platforms. None of that transfers: there is no price series, no mean reversion, no order book.

## The three ideas that do transfer
1. **Empirical clearing-price model (from market-making / Avellaneda-Stoikov inventory logic, book/myquant/chapter4.md).**
   Treat each letter as an instrument with an observable fill price. Build a per-letter, per-phase (bag remaining bucket) distribution of `paid` from the archived auction results we already log. Bid = min(private value, quantile of that distribution). This is the single biggest lever: our current bid is a hand-tuned formula that never looks at what letters actually clear for. **Substantial advantage, cheap: ~20 lines + one offline pass over runs/*.json.**

2. **Inventory skew (same chapter).** Market makers shift quotes to steer inventory to target. Analog: bid up when rack has a near-complete long word (we do this via `gain`), but also bid DOWN as unspent-balance/remaining-auctions ratio falls below the median clearing price, and bid UP when balance will otherwise strand. A budget-pacing rule: target spend per remaining auction = balance / remaining; if we are behind pace, lower the reservation threshold. Moderate advantage, ~5 lines.

3. **Uncertainty-shrunk sizing / fractional Kelly (think/Uncertainty-Driven Position Sizing.md).** When the private-value estimate is uncertain (letter completes nothing yet but has high 2-step potential), shade the bid by that uncertainty instead of a fixed 0.3 budget fraction. Small advantage; only worth doing after 1 and 2.

## Explicitly NOT worth importing
- RL frameworks (FinRL, RLlib): 68 rounds/match, ~1 match/min, 6 opponents of unknown mix. Sample efficiency is too poor and the offline replay harness already exists and is deterministic. Skip.
- HMM / regime switching: there are only two "regimes" (early bag, end bag) and they are observable from `bagRemaining`. No hidden state to infer.
- LLM agents, factor models, backtest platforms: no fit.

## Recommended next step (not done here)
Add an opponent price table to analyze.ts output: for each letter and bag-remaining quartile, the median and 75th percentile of `paid` across all archived matches. Feed that into `decideBid` as the cap instead of the fixed `budget` fraction. Validate with `npm run analyze -- --replay` before deploying.

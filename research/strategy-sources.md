# Strategy sources beyond awesome-quant-ai

Date: 2026-10-24. Companion to awesome-quant-ai-assessment.md.

## seal-agentic-finance (research/seal-agentic-finance)
Sui + Seal MPC prototype for cryptographically sealed, deposit-backed bids. It is auction *infrastructure*, not auction *strategy*. Its three scripted bidders (packages/sdk/src/strategies.ts) shade a reference price by fixed 2/8/18 bps; the "live agent" asks an LLM for a number and clamps it. Nothing transfers. SpacetimeDB already gives us sealed bids for free.

## Closest prior art: Columbia COMS 4444 "Seven Letter Word" project
https://www.cs.columbia.edu/~kar/4444f09/node19.html
Same game: 98 Scrabble tiles auctioned one at a time, Vickrey, 100 points each, highest word wins, all bids public. Differences: they stop at 7 tiles and score once; we play words continuously and reinvest winnings. The page poses the right questions and we can answer each with our data:
- Can opponents' bids reveal their racks? Yes, and we already log `topBids` and word plays. A 6-way table of {bot, tiles held, balance} is reconstructible per round.
- Is blocking worth it? Only in the last ~8 auctions when an opponent's rack is one tile short of a 7-letter word. Needs the reconstructed rack table.
- Are early letters worth less? In our variant early tiles are worth MORE because word income compounds. Our observed 0-spend matches confirm we are over-pricing early letters.

## Theory that maps onto our bid function

1. **Expected marginal-utility bidding (Greenwald & Boyan, UAI 2003, arXiv 1207.4108).**
   For sequential auctions, bidding the expected marginal utility of the item is optimal; the problem is an MDP over rack states. Our `gain = completed - best` is a one-step version. The missing piece is the expectation: a letter that completes nothing now still has value equal to P(next letters complete a word with it) × that word's score. Cheap approximation: completion2[c] = best score reachable with c plus ONE more drawn tile, weighted by that tile's frequency in the remaining bag. The `analyze()` index already enumerates words with one missing tile; extending to two missing tiles is a loop change.

2. **Budget pacing via dual multiplier (Balseiro & Gur 2019; Conitzer et al. arXiv 2103.13969; Gaitonde et al. arXiv 2205.08674).**
   bid_t = value_t / (1 + μ_t)
   μ_{t+1} = clamp(μ_t − ε·(targetSpend − actualSpend_t), 0, μ_max)
   targetSpend = balance / auctionsRemaining
   Underspend lowers μ toward 0 so bids approach full value; overspend raises μ. This replaces the fixed `budget = balance × 0.3` which is the exact cause of our stranded 100+ balances. ~5 lines in decideBid plus one mutable μ per match. Note the sign: in our game unspent balance is worth nothing at the end, so μ should be allowed to go NEGATIVE late in the match (bid above private value to convert cash to tiles while any word remains playable).

3. **Price prediction from history (TAC Classic agents, Greenwald & Stone 2001; bid-shading literature arXiv 2009.01360).**
   Covered in the first assessment: per-letter, per-phase empirical distribution of `paid`. In Vickrey this is only a cap, not the bid, since truth-telling is dominant. It matters for first-price matches, where shading should target the predicted second-highest bid, not a flat 0.8.

4. **Exploration under censored feedback (practitioner note from the bid-shading search).**
   When we lose we see `topBid` but not who else bid what. When we win we see the runner-up. Our archive therefore records the clearing price either way, so we do NOT have the censoring problem ad exchanges have. No exploration bids needed.

## Not worth it
- Full MDP / dynamic programming over rack states (arXiv 1301.2276): state space is huge, 1-second bid window, and the marginal-utility approximation captures most of it.
- Simultaneous-auction results (Gerding et al.): our auctions are strictly sequential.
- LLM-in-the-loop bidding: 1-second window, nondeterministic, no edge over a lookup table.

## Priority order
1. Pacing multiplier (fixes the stranded-cash failure, smallest change).
2. Two-tile lookahead in completion value.
3. Opponent rack reconstruction, used only for end-game blocking and for the first-price shading target.
Validate each with `npm run analyze -- --replay` before deploying.

## Sources
- https://www.cs.columbia.edu/~kar/4444f09/node19.html
- https://arxiv.org/abs/1207.4108
- https://arxiv.org/pdf/1301.2276
- https://arxiv.org/pdf/2103.13969
- https://arxiv.org/html/2205.08674v6
- https://arxiv.org/pdf/2011.10124
- https://arxiv.org/pdf/2009.01360
- https://arxiv.org/pdf/1401.3433
- https://www.economics.utoronto.ca/conferences/index.php/cetc/2013/paper/download/732/260

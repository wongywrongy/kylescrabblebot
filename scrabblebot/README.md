# ScrabbleBot

A Scrabble-style auction game where AI bots compete for letters.

Each round the module reveals one letter from a shared Scrabble bag and runs a
1-second sealed-bid auction. The highest bidder wins the letter, adds it to
their rack, and pays (Vickrey or first-price). Bots play words from their
collected letters at any time to earn currency, which funds future bids. Long
words pay a superlinear bonus, so hoarding is rewarded.

Built on [SpacetimeDB](https://spacetimedb.com): rules, timing, lobby
formation, dictionary — all inside a TypeScript module. Bots are external
SpacetimeDB clients (any language); the spectator UI is a Vite + React app.

Live at **[scrabblebot.vercel.app](https://scrabblebot.vercel.app)** ·
Bot-writing docs: **[/docs](https://scrabblebot.vercel.app/docs)**

## Repo layout

The web client lives at the repo root (standard SpacetimeDB project shape);
the module is nested inside it.

| Path | What it is |
|---|---|
| `src/`, `index.html`, `vite.config.ts` | Vite + React spectator UI |
| `spacetimedb/` | TypeScript module — schema, reducers, scheduled lobby + auction ticks, dictionary |
| `bot-starter/` | TypeScript starter bot — fork & edit `src/strategy.ts` |

## How a match comes together

There's a single rolling **lobby** that's always open for 60 seconds at a
time:

- Real bots `join_lobby()` at any time.
- If 6 real bots join → match starts immediately.
- If the timer expires → match starts with whoever's there, padded out to 6
  with idle simulated bots.
- A fresh lobby opens the moment the previous one resolves.

This means matches run continuously without anyone having to manually
schedule them. Bots that finish a match just call `join_lobby()` again.

## The rules

- **Auction:** 1-second sealed-bid window per letter. Highest bid wins; ties
  are broken at random.
- **Payment:** Vickrey by default (winner pays the runner-up's bid; reserve
  1). First-price is configurable per lobby.
- **Currency:** start at 100 per match. Reward for a word = base score ×
  length multiplier (1.0× ≤3 letters → 3.0× ≥7 letters). Reward goes into
  both `balance` (spendable) and `score` (ranking).
- **Letters:** standard 98-tile Scrabble bag (no blanks). Match ends when the
  bag empties. Tiles nobody bids on go back to the bag.
- **Visibility:** `Holding` and `BagLetter` are private. Bots see only their
  own rack via the `my_rack` view; nobody can subscribe to the full bag
  composition. The spectator reconstructs opponents' racks from public
  `AuctionResult` + `WordPlay` events.
- **Dictionary:** the public-domain
  [ENABLE](https://en.wikipedia.org/wiki/Moby_Project#ENABLE) wordlist
  (~173k words), embedded from `spacetimedb/wordlist.txt`. Swap in TWL or
  SOWPODS if you have a license.
- **Rating:** per-bot ELO updates pairwise at every match end (K=32).

## Writing a bot (5-minute version)

Three steps end-to-end:

1. **Get a token** — on the live site, link your spacetimedb.com identity at
   `/account`, then create a team at `/team/new`, then click *Generate token*
   on `/team`. You'll get a SpacetimeDB JWT bound to a credential for your
   team's bot persona (shown once).
2. **Fork the starter** and plug the token in:
   ```bash
   git clone https://github.com/clockworklabs/scrabblebot
   cd scrabblebot/bot-starter
   npm install
   npm run generate
   BOT_NAME=alice BOT_TOKEN=<token> npm start
   ```
3. **Edit `bot-starter/src/strategy.ts`** — two functions:
   - `decideBid(ctx)` — return how much to bid for the current letter.
   - `chooseWord(ctx)` — pick a word to play from your rack.

That's it. Your bot will auto-join the lobby, play in matches as they form,
and re-join after each one ends. Token is persisted to
`.token-<BOT_NAME>` after the first run.

For a deeper writeup — what's visible to your bot, the reducer API, the
SpacetimeDB connection snippet end-to-end — see **[/docs](https://scrabblebot.vercel.app/docs)**.

Bots can use any language SpacetimeDB has an SDK for (Rust, C#, TypeScript).
The starter is just convenience; the reducer interface is language-agnostic.

## Running the project locally

For development work on the module or UI:

```bash
npm install
npm install --prefix spacetimedb
npm run dev
```

This launches `spacetime dev` against maincloud — auto-builds the module,
publishes it, regenerates client bindings, and starts the Vite client on
http://localhost:5173. Edit `spacetimedb/src/` and changes flow
straight through to the browser.

The maincloud database name is set in `spacetime.local.json` (defaults to
`scrabblebot`). The `init` reducer seeds a default admin and the simulated
bot pool on every fresh database init.

### Other npm scripts

- `npm run dev:local` — same flow against a local `spacetime start` server.
- `npm run publish` — one-shot publish to the configured server.
- `npm run generate` — regenerate client bindings without the watcher.
- `npm run build` / `npm run preview` — production build of the spectator.

## GPU training for auction prices

The `learned-market` candidate trains a small PyTorch network on public auction
prices, conditioned on letter and auctions remaining. It exports all 68 × 26
contexts as quantile tables, so the live TypeScript bot needs no Python process
or GPU. The unconfigured runner retains the verified `market` policy; this
workspace now selects the later `trained-market` configuration described below.

From `bot-starter/`:

```bash
python3 -m venv .venv-gpu
.venv-gpu/bin/python -m pip install -r ml/requirements.txt
npm run observe -- runs/gpu-history.json
.venv-gpu/bin/python ml/train_market.py --output runs/gpu-market
.venv-gpu/bin/python -m unittest discover -s ml -v
npm test
npm run build
```

The [official PyTorch CUDA wheels](https://pytorch.org/get-started/previous-versions/)
include the Blackwell support used here. CUDA is required by default; the trainer
fails explicitly if device access is unavailable. Use `--device cpu` for a CPU
run. Each training run needs a new output directory to preserve previous models.

Training uses the most recent 1,200 eligible matches, split chronologically into
70% training, 15% validation, and 15% test. Matches overlapping a partition
boundary are removed. Validation selects the checkpoint; test matches never
affect fitting. `report.json` records exact match IDs, source hashes, prediction
loss, synchronized CPU/GPU timing, and device details. `weights.pt` retains the
network; `model.json` is the artifact consumed by the bot.

Before promotion, replay both policies on the same validation/test IDs from
`report.json`, using the existing evaluator:

```bash
node --import tsx src/experiment-inventory-public.ts src/strategy-market.ts runs/gpu-market/baseline-replay.json runs/gpu-history.json 2994 3353
MARKET_MODEL=runs/gpu-market/model.json node --import tsx src/experiment-inventory-public.ts src/strategy-learned-market.ts runs/gpu-market/candidate-replay.json runs/gpu-history.json 2994 3353
```

Those IDs belong to the October 24 snapshot; use the new report's IDs after
retraining. Frozen-price replay holds opponents' scores, budgets, and bids fixed
and adds a synthetic player, so its placement estimates do not establish live
leaderboard performance. Better prediction loss is also not sufficient for
promotion.

An explicit, bounded live run uses:

```bash
BOT_NAME=ramsay STRATEGY=learned-market MARKET_MODEL=runs/gpu-market/model.json MAX_MATCHES=6 npm start
```

The first GPU experiment is **not promoted**: on 180 reserved test matches,
the candidate averaged 73.84 points versus 75.28 for the default, with 4 versus
10 replay wins. See `bot-starter/runs/gpu-market/evaluation.json` for the paired
comparison. Its CUDA optimizer steps were 5.23× faster than four CPU threads;
that measurement excludes data processing and gameplay replay.

The runner snapshots the model and its TypeScript dependencies with each run.
The candidate retains the frozen policy for first-price auctions and horizons
outside its trained domain.

### Iterative improvement

The score-driven search learns six bounded parameters: early/middle/late bid
multipliers, a low-cash word threshold, a word-completion bid floor, and a cash
cap. Each round replays a population, updates its search distribution from the
best training scores, then checks the best proposals against the saved champion
on separate validation matches. It keeps the champion when a proposal regresses
or the paired score improvement is inconclusive.

```bash
cd bot-starter
.venv-gpu/bin/python ml/improve_policy.py --output runs/policy-search-01 --rounds 4 --population 8 --workers 4
```

The initial development ranges were matches 2700–2763 for parameter fitting and
2994–3168 for selection. The larger search uses 2700–2827 for fitting. Fresh
comparisons have now used matches through 3625; reserve later matches for the
next independently selected challenger. Repeated validation is a selection process, so a fresh test and live
matches are still required before claiming a leaderboard improvement.

`status.json` reports progress, `round-N.json` retains each round's evidence,
`protocol.json` pins input hashes, and `champion.json` holds the best validated
parameters. Every candidate has a separate replay file and log. To continue from
a champion without overwriting its evidence:

```bash
.venv-gpu/bin/python ml/improve_policy.py --resume runs/policy-search-01/champion.json --output runs/policy-search-02 --rounds 4 --population 8 --workers 4
```

Create an empty `STOP` file in a search's output directory to stop before its next
round. GPU operations sample and update the search distribution; dictionary
search and gameplay replay use CPU workers and dominate this stage's runtime.

The selected 32-future configuration scored **81.28 versus 73.57** on 130 newer
matches, with **8 versus 3** replay wins. Its paired score gain was 7.72 points
(approximate 95% interval 5.84–9.59). The first four rounds' bid/cash-out changes
were rejected; increasing the number of sampled futures provided the improvement.
Details are in `bot-starter/runs/policy-search-01/evaluation.json`.

A selected model can be played explicitly through the runner:

```bash
BOT_NAME=ramsay STRATEGY=trained-market POLICY_MODEL=runs/policy-search-01/selected.json MAX_MATCHES=6 TARGET_RANK=1 npm start
```

Use `--rounds 0` for continuous improvement. Resumption preserves the learned
search distribution, previous proposals, and GPU random-generator state:

```bash
nice -n 5 .venv-gpu/bin/python ml/improve_policy.py --resume runs/policy-search-continuous/champion.json --output runs/policy-search-compute --rounds 0 --future-markets 64 --population 24 --workers 10 --train-last 2827
```

This workspace sets `STRATEGY=trained-market` and
`POLICY_MODEL=runs/compute-search-02/selected.json` in the root environment file,
so `npm start` uses the independently tested configuration.

Logic switches per task without code changes: `BID_STRATEGY` and
`WORD_STRATEGY` each name any recorded strategy and default to `STRATEGY`.
`VERSION` tags a run so `npm run report` aggregates each tag as its own series
(server ratings stay per bot persona and cannot be reset):

```bash
VERSION=v3 BID_STRATEGY=trained-market WORD_STRATEGY=montecarlo MAX_MATCHES=6 npm start
npm run report
```

The earlier search stopped cleanly after round 5. Its replacement is running
with 24 candidates, ten CPU replay workers, and GPU distribution updates. Inspect
`runs/policy-search-compute/status.json`; its process ID is in
`runs/policy-search-compute.pid`. Stop it before the next round with:

```bash
touch runs/policy-search-compute/STOP
```

New checkpoints are research candidates. The continuous search uses the frozen
development data; further promotions need fresh-match evaluation. Checkpoints
do not automatically change a live bot. The fresh replay's bid p99 was 58.6 ms,
with one 115.1 ms bid exceeding the 100 ms target; live auction windows are 1 s.

### Faster and deeper search

The market policy now uses a trie and compact rack keys for dictionary lookups.
On 168 recorded positions at 64 futures it returned identical bids in 2.70 s
versus 6.84 s before the change (2.53× faster). Another 72 complete paired replays
at 32, 64 and 128 futures preserved every recorded outcome.

The 64-future challenger scored 83.06 versus 81.26 in 175 validation games,
with 13 versus 9 replay wins. On 142 newer games, selected before inspecting
those results, it scored 85.99 versus 83.73; the paired score difference was
2.27 points (approximate 95% interval 0.51–4.02). Top-three finishes increased
from 51.4% to 59.9%, but outright wins were 7 versus 8. A win-rate improvement
is therefore unproven. Bid p99 was 48.6 ms, with two decisions above 100 ms
and a maximum of 154.7 ms.

The six-match live trial produced two wins and a mean score of 85.33. Rating
rose from 1360 to 1507, ending at rank 16; this small uncontrolled sample does
not establish a win-rate improvement. Its bid p99 was 53 ms and maximum 68 ms.
The selected local default is now `runs/compute-search-02/selected.json`.
Evidence and source hashes are in `runs/compute-search-02/evaluation.json`.
The ranking attempt reached **#3 with 1619 rating** after match 4081 at
2026-10-24 20:27:32 UTC. The bot disconnected automatically before joining again.
The attempt completed 39 matches using the existing 64-future policy. Its
result and leaderboard snapshot hash are in `runs/top3-attempt.json`; the live
log is `runs/top3-attempt.log`. Other bots can change the ranking afterward.

128 futures remain research: their validation score improved further, but
latency was roughly twice as high. The alternative word timing and direct
auction-utility experiments did not beat the selected 64-future policy on the
training block. The larger lookup cache provided only a modest additional gain
and was left out of production. The observed-tile variant gained 1.03 points
over the selected policy on validation, but its paired interval included zero
(-0.56 to 2.63); it also remains research.

## Tournament mode

To seat ramsay in a tournament with the selected policy and automatic restarts
on disconnect, run `bot-starter/tournament.sh <TOURNAMENT_ID>` and leave it
running until the tournament ends; its log is `bot-starter/runs/tournament-<id>.log`.

`/admin` (admin-only) has a tournament launcher: Swiss rounds → top-N cut →
single-elimination bracket → best-of-3 finals. Match size, Swiss round
count, and top cut are configurable. ELO ratings are updated independently
of tournament standings.

## Known limitations

- No human play — bots only.
- Token-recovery for bots is via the *rotate* model: mint a new credential
  on `/team` and the old token keeps working in parallel. The bot persona
  itself survives.

## License

MIT.

The selected policy now uses public tile counts (`observedTiles: true`) in
`bot-starter/runs/top3-known-live/selected.json`. It removes the starting rack
and revealed auction tiles from future samples while retaining uncertainty about
opponents' starting tiles. A late join falls back to the previous sampler;
older model artifacts retain their original behavior.

On 209 newer replays (3907–4115), mean placement improved from 3.488 to 3.220,
with 29 simulated wins versus 18. These fixed-opponent replays are diagnostic.
The initial six-match live trial averaged 84 points and moved from 1473 rating
(#18) to 1608 (#5), but its audit exposed 30 late initial bids. SDK indexes scan
history: active-match polling took 68.5ms per pass. Scanning each table once
reduced that to about 1ms (68.3x faster); pools are now cached per auction.
The first completed match after the fix had no bid failures, and every recorded
pool matched the starting rack and public draws. Decision timing now includes
state preparation, which the earlier timer omitted.

Validation includes 55 passing tests, the build, 16 exact replay-equivalence
checks, and a complete GPU search smoke round. See
`runs/top3-known-live/evaluation.json`. Live samples remain small and uncontrolled.
The continuing ranking attempt is recorded in `runs/top3-known-live/continuation.json`.

The ongoing search is `runs/policy-search-observed`, using matches 3626–3753
for training and 3754–3906 for validation, with the observed-tile feature.
New parameter winners still require a later fresh comparison before live use.
Create that search directory's `STOP` file to finish the round and checkpoint.

The corrected runner reached **#3 at 1602 rating** after match 4432
and stopped automatically. The live leaderboard was verified at 2026-10-24T21:29:20.520Z.
The result and saved policy checks are in `runs/top3-known-live/completion-audit.json`.

A later 92-match diagnostic using actual starting racks favored the old sampler
(mean place 2.837 versus 2.967); the paired 95% interval includes zero. Together
with the earlier favorable synthetic-rack result, this leaves the new sampler's
live win-rate advantage unproven. See `runs/top3-actual-racks/evaluation.json`.

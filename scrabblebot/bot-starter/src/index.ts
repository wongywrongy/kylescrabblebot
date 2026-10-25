// ScrabbleBot bot starter.
//
// First run, with a token from the website:
//   On your team's page, click "Generate token", then run
//   `BOT_NAME=<name> BOT_TOKEN=<token> npm start`.
//
// Or with a nonce from the CLI:
//   1. `spacetime call scrabblebot mint_credential_nonce`
//      `spacetime sql 'SELECT code FROM my_nonces ORDER BY expires_at DESC'`
//   2. `BOT_NAME=<name> BOT_NONCE=<code> npm start`
//      The bot connects fresh and redeems the nonce.
//
// Either way the bot saves its token to .token-<BOT_NAME>, so later runs
// need only `BOT_NAME=<name> npm start`.
//
// Entering a tournament: `BOT_NAME=<name> TOURNAMENT_ID=<id> npm start`
// registers the bot for that tournament when it connects. Only the bot
// itself can register, so this has to come from the bot's process.
//
// The default policy is in ./src/strategy-market.ts; STRATEGY selects recorded alternatives.
// BID_STRATEGY / WORD_STRATEGY mix logic per task; VERSION tags a fresh local stats series:
//   VERSION=v3 BID_STRATEGY=trained-market WORD_STRATEGY=montecarlo npm start

import {
  DbConnection,
  type EventContext,
  type ErrorContext,
} from "./module_bindings/index.js";
import { Identity } from "spacetimedb";
import type { Auction } from "./module_bindings/types.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import * as strategy from "./strategy.js";
import * as baseline from "./baseline.js";
import * as montecarlo from "./strategy-montecarlo.js";
import * as market from "./strategy-market.js";
import * as learnedMarket from "./strategy-learned-market.js";
import * as trainedMarket from "./strategy-trained-market.js";
import * as hold7 from "./experiment-hold-word.js";
import * as boost from "./experiment-premium-boost.js";
import { remainingPool } from "./remaining-pool.js";

const STRATEGY = process.env.STRATEGY ?? "market";
// Each task may take its logic from a different recorded strategy; both default to STRATEGY.
const BID_STRATEGY = process.env.BID_STRATEGY ?? STRATEGY;
const WORD_STRATEGY = process.env.WORD_STRATEGY ?? STRATEGY;
const active = [...new Set([STRATEGY, BID_STRATEGY, WORD_STRATEGY])];
for (const s of active) if (!["baseline", "value", "montecarlo", "montecarlo-pool", "market", "learned-market", "trained-market", "hold7", "boost"].includes(s)) throw new Error("Unknown STRATEGY");
if (active.includes("learned-market") && !process.env.MARKET_MODEL) throw new Error("Set MARKET_MODEL for learned-market");
if ((active.includes("trained-market") || active.includes("hold7") || active.includes("boost")) && !process.env.POLICY_MODEL) throw new Error("Set POLICY_MODEL for trained-market");
// VERSION labels a fresh stats series in run names and reports (e.g. v3); stats on the server stay per bot.
const VERSION = process.env.VERSION ?? "";
if (!/^[\w.-]*$/.test(VERSION)) throw new Error("Invalid VERSION");
const moduleFor = (s: string) => s === "baseline" ? baseline : s.startsWith("montecarlo") ? montecarlo : s === "market" ? market : s === "learned-market" ? learnedMarket : s === "trained-market" ? trainedMarket : s === "hold7" ? hold7 : s === "boost" ? boost : strategy;
const sourceFor = (s: string) => new URL(s === "baseline" ? "./baseline.ts" : s.startsWith("montecarlo") ? "./strategy-montecarlo.ts" : s === "market" ? "./strategy-market.ts" : s === "learned-market" ? "./strategy-learned-market.ts" : s === "trained-market" ? "./strategy-trained-market.ts" : s === "hold7" ? "./experiment-hold-word.ts" : s === "boost" ? "./experiment-premium-boost.ts" : "./strategy.ts", import.meta.url);
const usesMonteCarlo = STRATEGY.startsWith("montecarlo");
const usesObservedPool = active.includes("montecarlo-pool") || (active.includes("trained-market") && trainedMarket.config.observedTiles);
const { decideBid } = moduleFor(BID_STRATEGY);
const { chooseWord } = moduleFor(WORD_STRATEGY);
const MAX_MATCHES = Number(process.env.MAX_MATCHES ?? 0);
if (!Number.isSafeInteger(MAX_MATCHES) || MAX_MATCHES < 0) throw new Error("Invalid MAX_MATCHES");
const TARGET_RANK = Number(process.env.TARGET_RANK ?? 0);
if (!Number.isSafeInteger(TARGET_RANK) || TARGET_RANK < 0) throw new Error("Invalid TARGET_RANK");
const runId = new Date().toISOString().replaceAll(":", "-") + `-${STRATEGY}` + (VERSION && `-${VERSION}`);
const runDir = path.resolve("runs", runId);
fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
const serialize = (data: unknown) => JSON.stringify(data, (_key, value) =>
  typeof value === "bigint" ? value.toString() : value);
function record(event: string, data: unknown) {
  fs.appendFileSync(path.join(runDir, "events.jsonl"), serialize({ at: new Date().toISOString(), event, data }) + "\n");
}
const strategySource = sourceFor(STRATEGY);
record("run", { strategy: STRATEGY, bidStrategy: BID_STRATEGY, wordStrategy: WORD_STRATEGY, version: VERSION, maxMatches: MAX_MATCHES, targetRank: TARGET_RANK,
  config: usesMonteCarlo ? montecarlo.config : STRATEGY === "market" ? market.config : STRATEGY === "learned-market" ? learnedMarket.config : STRATEGY === "trained-market" ? trainedMarket.config : {},
  configs: Object.fromEntries(active.map(s => [s, (moduleFor(s) as { config?: object }).config ?? {}])),
  runnerHash: createHash("sha256").update(fs.readFileSync(new URL("./index.ts", import.meta.url))).digest("hex"),
  sourceHash: createHash("sha256").update(fs.readFileSync(strategySource)).digest("hex") });
fs.copyFileSync(strategySource, path.join(runDir, "strategy.ts"));
for (const s of active) if (s !== STRATEGY) fs.copyFileSync(sourceFor(s), path.join(runDir, path.basename(sourceFor(s).pathname)));
fs.copyFileSync(new URL("./index.ts", import.meta.url), path.join(runDir, "runner.ts"));
fs.copyFileSync(new URL("./remaining-pool.ts", import.meta.url), path.join(runDir, "remaining-pool.ts"));
fs.copyFileSync(new URL("./baseline.ts", import.meta.url), path.join(runDir, "baseline.ts"));
if (active.some(s => ["market", "learned-market", "trained-market", "hold7", "boost"].includes(s))) {
  fs.copyFileSync(new URL("./strategy-montecarlo.ts", import.meta.url), path.join(runDir, "strategy-montecarlo.ts"));
  fs.copyFileSync(new URL("./market-prices.json", import.meta.url), path.join(runDir, "market-prices.json"));
  if (active.includes("learned-market") || active.includes("trained-market") || active.includes("hold7") || active.includes("boost")) {
    fs.copyFileSync(new URL("./strategy-market.ts", import.meta.url), path.join(runDir, "strategy-market.ts"));
  }
  if (active.includes("trained-market") || active.includes("hold7") || active.includes("boost")) {
    fs.copyFileSync(new URL("./experiment-hold-word.ts", import.meta.url), path.join(runDir, "experiment-hold-word.ts"));
    fs.copyFileSync(new URL("./strategy-trained-market.ts", import.meta.url), path.join(runDir, "strategy-trained-market.ts"));
    fs.copyFileSync(new URL("./strategy-learned-market.ts", import.meta.url), path.join(runDir, "strategy-learned-market.ts"));
    fs.copyFileSync(process.env.POLICY_MODEL!, path.join(runDir, "policy-model.json"));
  }
  if (active.includes("learned-market") || (active.includes("trained-market") && trainedMarket.config.priceSource === "learned-market")) {
    fs.copyFileSync(process.env.MARKET_MODEL!, path.join(runDir, "learned-prices.json"));
  }
}
let completedMatches = 0;
let ready = false;
let stopping = false;
let disconnecting = false;
let joiningLobby = false;
const startedMatches = new Set<bigint>();
const initialRacksByMatch = new Map<bigint, Map<string, number>>();
const observedPoolsByMatch = new Map<bigint, { auctionId: bigint; bagTotal: number; pool: Map<string, number> }>();

const HOST = process.env.STDB_HOST ?? "https://maincloud.spacetimedb.com";
const DB_NAME = process.env.STDB_DB ?? "scrabblebot";
const BOT_NAME = process.env.BOT_NAME ?? "bot";
const BOT_TOKEN = process.env.BOT_TOKEN; // from the website, first run only
const BOT_NONCE = process.env.BOT_NONCE; // from the CLI, first run only
const TOURNAMENT_ID = process.env.TOURNAMENT_ID;
const TOKEN_PATH = path.join(process.cwd(), `.token-${BOT_NAME}`);
const secrets = new Set([BOT_TOKEN, BOT_NONCE].filter((value): value is string => Boolean(value)));

function loadToken(): string | undefined {
  try {
    const token = fs.readFileSync(TOKEN_PATH, "utf8").trim() || undefined;
    if (token) secrets.add(token);
    return token;
  } catch {
    return undefined;
  }
}
function saveToken(tok: string) {
  secrets.add(tok);
  if (BOT_TOKEN) return;
  fs.writeFileSync(TOKEN_PATH, tok, { mode: 0o600 });
  fs.chmodSync(TOKEN_PATH, 0o600);
}

// Load the shared wordlist so the bot can pick playable words locally.
const dictionaryPath = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
  "spacetimedb",
  "wordlist.txt",
);
const DICTIONARY: string[] = fs.existsSync(dictionaryPath)
  ? fs
      .readFileSync(dictionaryPath, "utf8")
      .split("\n")
      .map((l) => l.trim().toUpperCase())
      .filter((l) => l.length >= 2)
  : [];
DICTIONARY.sort((a, b) => b.length - a.length); // longest first for greedy pick
if (DICTIONARY.length === 0) throw new Error("The shared wordlist is missing or empty");
chooseWord({ myRack: new Map(), dictionary: DICTIONARY }); // Build the word index before connecting.

let myIdentity: Identity | null = null;
let myBotId: bigint | null = null;
const bidsByAuction = new Map<string, { signature: string; amount: number; pending: boolean }>();
const openAuctionsById = new Map<bigint, Auction>();
const lastWordAttemptByMatch = new Map<string, number>();
const pendingWordMatches = new Set<bigint>();
const WORD_RETRY_MS = 500;

function cacheAuction(auction: Auction) {
  if (auction.status.tag === "Open") openAuctionsById.set(auction.id, auction);
  else openAuctionsById.delete(auction.id);
}

function resolveMyBotId(conn: DbConnection): bigint | null {
  if (!myIdentity) return null;
  const cred = conn.db.botCredential.identity.find(myIdentity);
  return cred ? cred.botId : null;
}

function rackForMatch(
  conn: DbConnection,
  matchId: bigint,
): Map<string, number> {
  const rack = new Map<string, number>();
  for (const h of conn.db.myRack.iter()) {
    if (h.matchId !== matchId) continue;
    rack.set(h.letter, (rack.get(h.letter) ?? 0) + h.count);
  }
  return rack;
}

function participantForMatch(
  conn: DbConnection,
  matchId: bigint,
): { balance: number; score: number } | null {
  if (myBotId === null) return null;
  for (const p of conn.db.matchParticipant.iter()) {
    if (p.matchId !== matchId) continue;
    if (p.botId !== myBotId) continue;
    return { balance: Number(p.balance), score: Number(p.score) };
  }
  return null;
}

// SDK index lookups scan their table; scan each table once when locating active games.
function runningMatches(conn: DbConnection) {
  const mine = new Set<bigint>();
  for (const p of conn.db.matchParticipant.iter()) if (p.botId === myBotId) mine.add(p.matchId);
  return [...conn.db.matchState.iter()].filter(m => m.status.tag === "Running" && mine.has(m.id));
}

// A reducer call fails when the module refuses it, often for an expected
// reason: a word played just after its match ended, a bid that missed the
// auction's window. Log it and keep playing; an uncaught failure would stop
// the bot.
function logFailure(what: string) {
  return (err: unknown) => {
    let message = String(err instanceof Error ? err.message : err);
    for (const secret of secrets) message = message.replaceAll(secret, "[redacted]");
    record("failure", { what, message });
    console.warn(`[${BOT_NAME}] ${what} failed: ${message}`);
  };
}

function tryBid(
  conn: DbConnection,
  auctionId: bigint,
  matchId: bigint,
  letter: string,
) {
  if (!ready || myBotId === null) return;
  const key = `${matchId}:${auctionId}`;
  const previous = bidsByAuction.get(key) ?? { signature: "", amount: 0, pending: false };
  if (previous.pending) return;
  const decisionStarted = Date.now();
  const participant = participantForMatch(conn, matchId);
  if (!participant) return;
  const match = conn.db.matchState.id.find(matchId);
  if (match?.status.tag !== "Running") return;
  recordMatchStart(conn, matchId);
  const rack = rackForMatch(conn, matchId);
  const opponentBalances = [...conn.db.matchParticipant.iter()].filter(p => p.matchId === matchId && p.botId !== myBotId).map(p => Number(p.balance));
  const signature = serialize([participant.balance, [...rack].sort(), match.bagTotal, match.auctionType.tag, opponentBalances]);
  if (previous.signature === signature) return;
  const poolStarted = Date.now();
  const remainingLetters = poolForMatch(conn, matchId);
  const poolMs = Date.now() - poolStarted;
  const amount = decideBid({
    letter,
    myBalance: participant.balance,
    myRack: rack,
    dictionary: DICTIONARY,
    bagRemaining: match.bagTotal,
    auctionType: match.auctionType.tag,
    opponentBalances,
    remainingLetters,
  });
  previous.signature = signature;
  bidsByAuction.set(key, previous);
  record("bid", { matchId, auctionId, letter, amount, previousAmount: previous.amount, decisionMs: Date.now() - decisionStarted, poolMs, balance: participant.balance, rack: Object.fromEntries(rack), remainingLetters: remainingLetters && Object.fromEntries(remainingLetters) });
  if (amount === previous.amount) return;
  previous.pending = true;
  conn.reducers
    .submitBid({ auctionId, amount: BigInt(amount) })
    .then(() => { previous.amount = amount; })
    .catch(err => { previous.signature = ""; logFailure(`bid on auction ${auctionId}`)(err); })
    .finally(() => { previous.pending = false; });
  console.log(
    `[${BOT_NAME}] bid ${amount} on '${letter}' (match ${matchId}, auction ${auctionId})`,
  );
}

function tryPlayWord(conn: DbConnection) {
  if (!ready || myBotId === null) return;
  const now = Date.now();
  for (const match of runningMatches(conn)) {
    const matchId = match.id;
    recordMatchStart(conn, matchId);
    if (pendingWordMatches.has(matchId)) continue;
    const key = String(matchId);
    if (now - (lastWordAttemptByMatch.get(key) ?? 0) < WORD_RETRY_MS) continue;
    lastWordAttemptByMatch.set(key, now);
    const decisionStarted = Date.now();
    const word = chooseWord({
      myRack: rackForMatch(conn, matchId),
      dictionary: DICTIONARY,
      myBalance: participantForMatch(conn, matchId)?.balance,
      bagRemaining: match.bagTotal,
      remainingLetters: poolForMatch(conn, matchId),
    });
    const decisionMs = Date.now() - decisionStarted;
    record("word_decision", { matchId, word, decisionMs });
    if (!word) continue;
    record("word_attempt", { matchId, word, decisionMs, rack: Object.fromEntries(rackForMatch(conn, matchId)) });
    console.log(`[${BOT_NAME}] match ${matchId}: playing '${word}'`);
    pendingWordMatches.add(matchId);
    const submittedAt = Date.now();
    conn.reducers
      .submitWord({ matchId, word })
      .then(() => {
        record("word_ack", { matchId, word, roundTripMs: Date.now() - submittedAt });
        if (!ready || myBotId === null) return;
        const current = conn.db.matchState.id.find(matchId);
        if (current?.status.tag !== "Running" || current.currentAuctionId === undefined) return;
        const auction = openAuctionsById.get(current.currentAuctionId);
        if (auction?.status.tag === "Open" && auction.matchId === matchId) {
          tryBid(conn, auction.id, matchId, auction.letter);
        }
      })
      .catch(logFailure(`playing '${word}'`))
      .finally(() => pendingWordMatches.delete(matchId));
  }
}

function onConnect(conn: DbConnection, identity: Identity, token: string) {
  myIdentity = identity;
  saveToken(token);
  console.log(`[${BOT_NAME}] connected as ${identity.toHexString()}`);

  conn
    .subscriptionBuilder()
    .onError(() => { console.error("Subscription failed"); process.exit(1); })
    .onApplied(() => {
      console.log(`[${BOT_NAME}] subscription applied`);

      // Resolve our bot id, possibly after claiming a nonce.
      myBotId = resolveMyBotId(conn);
      if (myBotId === null) {
        if (BOT_NONCE) {
          console.log(`[${BOT_NAME}] claiming credential with nonce…`);
          conn.reducers
            .claimCredential({ code: BOT_NONCE })
            .catch(logFailure("claiming the credential"));
          // Wait briefly for the credential to land; check again.
          setTimeout(() => {
            myBotId = resolveMyBotId(conn);
            if (myBotId === null) {
              console.error(
                `[${BOT_NAME}] couldn't claim credential. Bad / expired nonce?`,
              );
              process.exit(1);
            }
            const bot = conn.db.bot.id.find(myBotId);
            console.log(
              `[${BOT_NAME}] claimed credential for bot '${bot?.name ?? "?"}' (id ${myBotId})`,
            );
            bootstrapActivity(conn);
          }, 1000);
          return;
        } else {
          console.error(
            `[${BOT_NAME}] no BotCredential for this token. Set BOT_TOKEN or BOT_NONCE and re-run.`,
          );
          process.exit(1);
        }
      }

      const bot = conn.db.bot.id.find(myBotId);
      console.log(
        `[${BOT_NAME}] acting as bot '${bot?.name ?? "?"}' (id ${myBotId})`,
      );
      bootstrapActivity(conn);
    })
    .subscribe([
      "SELECT * FROM bot", "SELECT * FROM bot_credential", "SELECT * FROM bot_stats",
      "SELECT * FROM lobby", "SELECT * FROM lobby_member", "SELECT * FROM match_state",
      "SELECT * FROM match_participant", "SELECT * FROM auction", "SELECT * FROM auction_result",
      "SELECT * FROM word_play", "SELECT * FROM my_rack", "SELECT * FROM auction_top_bid_archive",
      "SELECT * FROM matchmaker_config",
    ]);

  conn.db.auction.onInsert((_ctx: EventContext, a) => {
    cacheAuction(a);
    if (a.status.tag === "Open") tryBid(conn, a.id, a.matchId, a.letter);
  });
  conn.db.auction.onUpdate((_ctx, _old, a) => cacheAuction(a));
  conn.db.auction.onDelete((_ctx, a) => openAuctionsById.delete(a.id));
  conn.db.myRack.onInsert(() => tryPlayWord(conn));
  conn.db.myRack.onUpdate(() => tryPlayWord(conn));
  conn.db.myRack.onDelete(() => tryPlayWord(conn));
  conn.db.botCredential.onInsert(() => {
    if (myBotId === null) myBotId = resolveMyBotId(conn);
  });
  conn.db.auctionResult.onInsert((_ctx, r) => {
    if (_ctx.event.tag === "SubscribeApplied") return;
    if (!ready || myBotId === null || !participantForMatch(conn, r.matchId)) return;
    record("auction_result", r);
    const winner =
      r.winnerBotId !== undefined && r.winnerBotId !== null
        ? String(r.winnerBotId)
        : "no-bid";
    console.log(
      `[${BOT_NAME}] match ${r.matchId} auction ${r.auctionId} '${r.letter}' → bot ${winner} paid ${r.paid}`,
    );
  });
  conn.db.wordPlay.onInsert((_ctx, word) => {
    if (_ctx.event.tag === "SubscribeApplied") return;
    if (ready && participantForMatch(conn, word.matchId)) record("word_play", word);
  });

  // When a match this bot was in ends, hop back into the lobby.
  conn.db.matchState.onUpdate((_ctx, old, neu) => {
    if (myBotId === null) return;
    if (old.status.tag !== "Ended" && neu.status.tag === "Ended") {
      const wasIn = Array.from(conn.db.matchParticipant.iter()).some(
        (p) => p.matchId === neu.id && p.botId === myBotId,
      );
      if (wasIn) {
        // SDK applies the complete transaction before callbacks; persist before the stop poll can exit.
        finishMatch(conn, neu.id);
      }
    }
  });
}

function joinLobby(conn: DbConnection) {
  if (!ready || stopping || joiningLobby || myBotId === null) return;
  const inRunning = runningMatches(conn).length > 0;
  if (inRunning) return;
  const openLobby = Array.from(conn.db.lobby.iter()).find(
    (l) => l.status.tag === "Open",
  );
  const alreadyIn =
    openLobby !== undefined &&
    Array.from(conn.db.lobbyMember.iter()).some(
      (lm) => lm.lobbyId === openLobby.id && lm.botId === myBotId,
    );
  if (alreadyIn) return;
  console.log(`[${BOT_NAME}] joining lobby`);
  joiningLobby = true;
  conn.reducers.joinLobby({}).catch(logFailure("joining the lobby")).finally(() => { joiningLobby = false; });
}

function bootstrapActivity(conn: DbConnection) {
  ready = true;
  record("connected", { botId: myBotId, bot: conn.db.bot.id.find(myBotId!), stats: conn.db.botStats.botId.find(myBotId!), config: [...conn.db.matchmakerConfig.iter()] });
  console.log(`Recording ${STRATEGY} run in ${runDir}`);
  recordLeaderboard(conn);
  fs.copyFileSync(path.join(runDir, "leaderboard.json"), path.join(runDir, "leaderboard-start.json"));
  if (TOURNAMENT_ID) {
    conn.reducers
      .registerForTournament({ tournamentId: BigInt(TOURNAMENT_ID) })
      .then(() =>
        console.log(`[${BOT_NAME}] registered for tournament ${TOURNAMENT_ID}`),
      )
      .catch(logFailure(`registering for tournament ${TOURNAMENT_ID}`));
  }
  joinLobby(conn);
  openAuctionsById.clear();
  for (const a of conn.db.auction.iter()) {
    if (a.status.tag === "Open") {
      cacheAuction(a);
      tryBid(conn, a.id, a.matchId, a.letter);
    }
  }
  tryPlayWord(conn);
  setInterval(() => {
    for (const match of runningMatches(conn)) {
      recordMatchStart(conn, match.id);
      const auction = match.currentAuctionId === undefined ? undefined : openAuctionsById.get(match.currentAuctionId);
      if (auction?.status.tag === "Open") tryBid(conn, auction.id, auction.matchId, auction.letter);
    }
    tryPlayWord(conn);
    if (stopping) stopWhenIdle(conn);
  }, 100);
}

function recordMatchStart(conn: DbConnection, matchId: bigint) {
  if (startedMatches.has(matchId)) return;
  startedMatches.add(matchId);
  if (usesObservedPool && participantForMatch(conn, matchId)?.score === 0 && [...conn.db.auctionResult.resultByMatch.filter(matchId)].length === 0) {
    initialRacksByMatch.set(matchId, rackForMatch(conn, matchId));
  }
  record("match_start", { match: conn.db.matchState.id.find(matchId), rack: Object.fromEntries(rackForMatch(conn, matchId)),
    participant: [...conn.db.matchParticipant.iter()].find(p => p.matchId === matchId && p.botId === myBotId) });
}

function poolForMatch(conn: DbConnection, matchId: bigint): Map<string, number> | undefined {
  if (!usesObservedPool) return;
  const initial = initialRacksByMatch.get(matchId);
  const match = conn.db.matchState.id.find(matchId);
  if (!initial || !match || match.currentAuctionId === undefined) return;
  const cached = observedPoolsByMatch.get(matchId);
  if (cached?.auctionId === match.currentAuctionId && cached.bagTotal === match.bagTotal) return cached.pool;
  const current = openAuctionsById.get(match.currentAuctionId);
  if (!current || current.status.tag !== "Open") return;
  // The SDK scans the full history for this index; public counts are fixed within an auction.
  const results = [...conn.db.auctionResult.resultByMatch.filter(matchId)];
  const draws = results.map(a => a.letter);
  if (!results.some(a => a.auctionId === current.id)) draws.push(current.letter);
  const players = [...conn.db.matchParticipant.iter()].filter(p => p.matchId === matchId).length;
  const initialCount = [...initial.values()].reduce((sum, n) => sum + n, 0);
  const pool = remainingPool(initial, draws, match.bagTotal, (players - 1) * initialCount);
  if (pool) observedPoolsByMatch.set(matchId, { auctionId: current.id, bagTotal: match.bagTotal, pool });
  return pool;
}

function stopWhenIdle(conn: DbConnection) {
  if (!ready || joiningLobby) return;
  const running = runningMatches(conn).length > 0;
  const queued = [...conn.db.lobbyMember.iter()].some(m =>
    m.botId === myBotId && conn.db.lobby.id.find(m.lobbyId)?.status.tag === "Open");
  if (running || queued) return;
  ready = false;
  disconnecting = true;
  conn.disconnect();
  process.exit(0);
}

function recordLeaderboard(conn: DbConnection) {
  const rows = [...conn.db.botStats.iter()].sort((a, b) => b.rating - a.rating)
    .map(s => ({ ...s, name: conn.db.bot.id.find(s.botId)?.name, simulated: conn.db.bot.id.find(s.botId)?.isSimulated }));
  fs.writeFileSync(path.join(runDir, "leaderboard.json"), serialize(rows));
  const mine = conn.db.botStats.botId.find(myBotId!);
  return mine == null ? null : 1 + rows.filter(s => s.rating > mine.rating).length;
}

function finishMatch(conn: DbConnection, matchId: bigint) {
  const participants = [...conn.db.matchParticipant.iter()].filter(p => p.matchId === matchId)
    .sort((a, b) => Number(b.score - a.score)).map(p => ({ ...p, name: conn.db.bot.id.find(p.botId)?.name }));
  const me = participants.find(p => p.botId === myBotId)!;
  const result = { matchId, strategy: STRATEGY, bidStrategy: BID_STRATEGY, wordStrategy: WORD_STRATEGY, version: VERSION, botId: myBotId,
    place: 1 + participants.filter(p => p.score > me.score).length, score: Number(me.score),
    balance: Number(me.balance), rack: Object.fromEntries(rackForMatch(conn, matchId)),
    leaderboardRank: recordLeaderboard(conn), stats: conn.db.botStats.botId.find(myBotId!),
    match: conn.db.matchState.id.find(matchId), participants,
    auctions: [...conn.db.auctionResult.iter()].filter(a => a.matchId === matchId),
    topBids: [...conn.db.auctionTopBidArchive.iter()].filter(a => a.matchId === matchId),
    words: [...conn.db.wordPlay.iter()].filter(w => w.matchId === matchId) };
  fs.writeFileSync(path.join(runDir, `match-${matchId}.json`), serialize(result));
  record("match_end", { matchId, place: result.place, score: result.score, rating: result.stats?.rating, leaderboardRank: result.leaderboardRank });
  console.log(`RESULT match=${matchId} place=${result.place}/${participants.length} score=${result.score} rating=${result.stats?.rating} rank=${result.leaderboardRank}`);
  completedMatches++;
  initialRacksByMatch.delete(matchId);
  observedPoolsByMatch.delete(matchId);
  bidsByAuction.clear();
  lastWordAttemptByMatch.delete(String(matchId));
  if (stopping || (MAX_MATCHES > 0 && completedMatches >= MAX_MATCHES) || (TARGET_RANK > 0 && result.leaderboardRank !== null && result.leaderboardRank <= TARGET_RANK)) {
    ready = false;
    disconnecting = true;
    conn.disconnect();
    process.exit(0);
  }
  joinLobby(conn);
}

function main() {
  process.on("SIGTERM", () => { stopping = true; console.log("Stopping after the current match."); });
  console.log(`[${BOT_NAME}] connecting to ${DB_NAME} at ${HOST}`);
  DbConnection.builder()
    .withUri(HOST)
    .withDatabaseName(DB_NAME)
    .withToken(BOT_TOKEN ?? loadToken())
    .onConnect(onConnect)
    .onConnectError((_ctx: ErrorContext, err: Error) => {
      logFailure("connect")(err);
      process.exit(1);
    })
    .onDisconnect(() => {
      ready = false;
      console.log("disconnected");
      if (!disconnecting) process.exit(1);
    })
    .build();
}

main();

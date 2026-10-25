// Offline runner checks: node --import tsx src/runner.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { remainingPool } from "./remaining-pool.js";

const require = createRequire(import.meta.url);
const source = ts.transpileModule(
  readFileSync(new URL("./index.ts", import.meta.url), "utf8")
    .replaceAll("import.meta.url", JSON.stringify(import.meta.url))
    .replace(/\nmain\(\);\s*$/, ""),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;

function runner(env: Record<string, string | undefined> = {}, holdBids = false, observedTiles = false, chosenWord: string | null = "AT") {
  const events: { at: string; event: string; data: any }[] = [];
  const exits: number[] = [];
  const intervals: (() => void)[] = [];
  const timeouts: (() => void)[] = [];
  const writes = new Map<string, string>();
  const copies: string[][] = [];
  const activity: string[] = [];
  const hooks: Record<string, (...args: any[]) => void> = {};
  const bids: unknown[] = [];
  const pendingBids: { resolve: () => void; reject: (error: Error) => void }[] = [];
  const words: unknown[] = [];
  const decisions: { word: any[]; bid: any[] } = { word: [], bid: [] };
  let settleWord: (() => void) | undefined;
  let rejectWord: ((error: Error) => void) | undefined;
  const table = (rows: any[]) => ({
    iter: () => rows, id: { find: (id: bigint) => rows.find(row => row.id === id) },
    onInsert() {}, onUpdate() {}, onDelete() {},
  });
  const matches = [{ id: 1n, status: { tag: "Running" }, currentAuctionId: 2n, bagTotal: 80, auctionType: { tag: "Vickrey" } }];
  const participants = [{ matchId: 1n, botId: 3n, balance: 100n, score: 0n }];
  const auctions: any[] = [];
  const lobbies = [{ id: 4n, status: { tag: "Open" } }];
  const members: any[] = [];
  const db = {
    matchState: { ...table(matches), onUpdate: (callback: (...args: any[]) => void) => { hooks.matchUpdate = callback; } },
    matchParticipant: table(participants),
    auction: { ...table(auctions),
      onInsert: (callback: (...args: any[]) => void) => { hooks.auctionInsert = callback; },
      onUpdate: (callback: (...args: any[]) => void) => { hooks.auctionUpdate = callback; },
      onDelete: (callback: (...args: any[]) => void) => { hooks.auctionDelete = callback; },
    }, botCredential: table([]),
    myRack: table([{ matchId: 1n, letter: "A", count: 1 }, { matchId: 1n, letter: "T", count: 1 }]),
    lobby: table(lobbies), lobbyMember: table(members),
    bot: table([]), botStats: { iter: () => [], botId: { find: () => undefined } },
    matchmakerConfig: table([]),
    auctionResult: { ...table([]), resultByMatch: { filter: (_id: bigint): any[] => [] } },
    auctionTopBidArchive: table([]), wordPlay: table([]),
  };
  db.auctionResult.resultByMatch.filter = (id: bigint) => db.auctionResult.iter().filter(row => row.matchId === id);
  let disconnected = false;
  const conn = {
    db,
    subscriptionBuilder: () => {
      const subscription = { onError: () => subscription, onApplied: () => subscription, subscribe() {} };
      return subscription;
    },
    reducers: {
      joinLobby: () => Promise.resolve(),
      submitBid: (args: unknown) => { bids.push(args); return holdBids ? new Promise<void>((resolve, reject) => pendingBids.push({ resolve, reject })) : Promise.resolve(); },
      submitWord: (args: unknown) => { words.push(args); return new Promise<void>((resolve, reject) => { settleWord = resolve; rejectWord = reject; }); },
    },
    disconnect: () => { activity.push("disconnect"); disconnected = true; hooks.onDisconnect?.(); },
  };
  const builder: Record<string, any> = {};
  for (const name of ["withUri", "withDatabaseName", "withToken", "onConnect", "onConnectError", "onDisconnect"]) {
    builder[name] = (arg: any) => { if (name.startsWith("on")) hooks[name] = arg; return builder; };
  }
  builder.build = () => conn;
  const fakeFs = {
    mkdirSync() {}, copyFileSync(from: unknown, to: unknown) {
      copies.push([String(from), String(to)]);
      if (writes.has(String(from))) writes.set(String(to), writes.get(String(from))!);
    }, chmodSync() {}, existsSync: () => true,
    readFileSync: (file: unknown) => String(file).includes(".token-") ? "stored-secret" : "AT\n",
    writeFileSync(file: unknown, text: unknown) { writes.set(String(file), String(text)); activity.push(`write:${file}`); },
    appendFileSync: (_path: string, text: string) => { const event = JSON.parse(text); events.push(event); activity.push(`event:${event.event}`); },
  };
  const context = vm.createContext({
    exports: {}, URL, console: { log() {}, warn() {}, error() {} },
    setInterval: (callback: () => void) => intervals.push(callback),
    setTimeout: (callback: () => void) => timeouts.push(callback),
    process: { env: { BOT_NONCE: "nonce-secret", STRATEGY: "value", ...env }, cwd: () => "/tmp/runner-test", exit: (code: number) => { activity.push("exit"); exits.push(code); }, on() {} },
    require: (name: string) => {
      if (name === "node:fs") return fakeFs;
      if (name === "./module_bindings/index.js") return { DbConnection: { builder: () => builder } };
      if (name === "./strategy.js" || name === "./baseline.js") return { chooseWord: () => chosenWord, decideBid: (ctx: { myBalance: number }) => ctx.myBalance < 10 ? 0 : 5 };
      if (name === "./strategy-montecarlo.js") return {
        chooseWord: (ctx: any) => { decisions.word.push(ctx); return "AT"; },
        decideBid: (ctx: any) => { decisions.bid.push(ctx); return 17; },
        config: { MC_K: 24, MC_LAMBDA: 0.5 },
      };
      if (name === "./strategy-trained-market.js") return { chooseWord: (ctx: any) => { decisions.word.push(ctx); return "AT"; }, decideBid: (ctx: any) => { decisions.bid.push(ctx); return 31; }, config: { priceSource: "market", futureMarkets: 32, observedTiles, policyModel: { sha256: "policy-hash" } } };
      if (name === "./experiment-premium-boost.js") return { chooseWord: () => "BOOSTED", decideBid: () => 19, config: { cheapFactor: 0.9 } };
      if (name === "./experiment-hold-word.js") return { chooseWord: (ctx: any) => { decisions.word.push(ctx); return "HOLDING"; }, decideBid: () => 31, config: { holdUntil: 20 } };
      if (name === "./strategy-learned-market.js") return { chooseWord: () => "AT", decideBid: () => 29, config: { learnedPrices: { sha256: "trained-hash" } } };
      if (name === "./remaining-pool.js") return { remainingPool };
      if (name === "./strategy-market.js") return { chooseWord: () => "AT", decideBid: () => 23, config: { futureMarkets: 8 } };
      return require(name);
    },
    conn,
  });
  vm.runInContext(source, context);
  const run = (code: string) => vm.runInContext(code, context);
  const addAuction = (auction: any) => {
    auctions.push(auction);
    context.auctionToCache = auction;
    run("cacheAuction(auctionToCache)");
  };
  run("myBotId = 3n; ready = true;");
  return { run, addAuction, events, exits, intervals, timeouts, writes, copies, activity, decisions, bids, pendingBids, participants, words, matches, auctions, members, hooks,
    settled: async () => { settleWord?.(); await new Promise(resolve => setImmediate(resolve)); },
    rejected: async (error: Error) => { rejectWord?.(error); await new Promise(resolve => setImmediate(resolve)); },
    disconnected: () => disconnected };
}

test("records the initial rack before a word and waits for the pending reducer", async () => {
  const r = runner();
  r.run("tryPlayWord(conn)");
  assert.deepEqual(r.events.slice(1).map(event => event.event), ["match_start", "word_decision", "word_attempt"]);
  assert.deepEqual(r.events[1].data.rack, { A: 1, T: 1 });
  r.run('lastWordAttemptByMatch.set("1", 0); tryPlayWord(conn)');
  assert.equal(r.words.length, 1);
  await r.settled();
  r.run("tryPlayWord(conn)");
  assert.equal(r.words.length, 2);
  assert.equal(r.events.filter(event => event.event === "match_start").length, 1);
});

test("word timing records successful and no-word decisions without creating null attempts", () => {
  for (const word of ["AT", null]) {
    const r = runner({}, false, false, word);
    r.run("Date.now = (() => { let now = 1000; return () => now += 7; })(); tryPlayWord(conn);");
    const decision = r.events.find(e => e.event === "word_decision")!.data;
    assert.equal(decision.word, word);
    assert.equal(decision.decisionMs, 7);
    const attempts = r.events.filter(e => e.event === "word_attempt");
    assert.equal(attempts.length, word ? 1 : 0);
    assert.equal(r.words.length, word ? 1 : 0);
    if (word) assert.equal(attempts[0].data.decisionMs, 7);
  }
});

test("bootstrap preserves the starting leaderboard when later snapshots change", () => {
  const r = runner();
  r.run("conn.db.botStats.iter = () => [{ botId: 3n, rating: 1500 }, { botId: 4n, rating: 1600 }]; bootstrapActivity(conn);");
  const startFile = [...r.writes.keys()].find(file => file.endsWith("/leaderboard-start.json"))!;
  assert.ok(startFile);
  const before = r.writes.get(startFile)!;
  assert.equal(JSON.parse(before)[0].rating, 1600);
  r.run("conn.db.botStats.iter = () => [{ botId: 3n, rating: 1700 }, { botId: 4n, rating: 1600 }]; recordLeaderboard(conn);");
  assert.equal(r.writes.get(startFile), before);
  assert.equal(JSON.parse(r.writes.get(startFile.replace("leaderboard-start.json", "leaderboard.json"))!)[0].rating, 1700);
});

test("poll recovers an auction missed before its callback could act, without duplicate bids", () => {
  const r = runner();
  r.run("onConnect(conn, { toHexString: () => 'test' }, 'test-token'); bootstrapActivity(conn); ready = false;");
  assert.equal(r.bids.length, 0);
  const auction = { id: 2n, matchId: 1n, letter: "A", status: { tag: "Open" } };
  r.auctions.push(auction);
  r.hooks.auctionInsert({}, auction);
  assert.equal(r.bids.length, 0, "an insertion before readiness must still enter the cache");
  r.run("ready = true");
  r.intervals[0]();
  r.intervals[0]();
  assert.equal(r.bids.length, 1);
});

test("graceful stop waits through a running or queued match, then disconnects successfully", () => {
  const r = runner();
  r.run("stopWhenIdle(conn)");
  assert.equal(r.disconnected(), false);
  r.matches[0].status.tag = "Ended";
  r.members.push({ botId: 3n, lobbyId: 4n });
  r.run("stopWhenIdle(conn)");
  assert.equal(r.disconnected(), false);
  r.members.length = 0;
  r.run("main(); stopWhenIdle(conn)");
  assert.equal(r.disconnected(), true);
  assert.deepEqual(r.exits, [0]);
});

test("graceful stop waits for an in-flight lobby request", async () => {
  const r = runner();
  r.matches[0].status.tag = "Ended";
  r.run("joinLobby(conn); stopWhenIdle(conn)");
  assert.equal(r.disconnected(), false);
  await r.settled();
  r.run("stopWhenIdle(conn)");
  assert.deepEqual(r.exits, [0]);
});

test("match-end callback persists final transaction before the graceful-stop poll", () => {
  const r = runner();
  r.run("main(); onConnect(conn, { toHexString: () => 'test' }, 'test-token'); bootstrapActivity(conn); stopping = true;");
  const oldMatch = { ...r.matches[0], status: { tag: "Running" } };
  // The SDK applies every table before invoking the match-state callback.
  r.matches[0].status.tag = "Ended";
  r.participants[0].score = 72n;
  r.participants[0].balance = 14n;
  r.run(`
    conn.db.myRack.iter().splice(0, 2, { matchId: 1n, letter: 'Z', count: 1 });
    conn.db.auctionResult.iter().push({ matchId: 1n, auctionId: 2n, letter: 'Z', paid: 5n });
    conn.db.auctionTopBidArchive.iter().push({ matchId: 1n, auctionId: 2n, topBid: 8n });
    conn.db.wordPlay.iter().push({ matchId: 1n, word: 'AT', totalReward: 2n });
    conn.db.botStats.botId.find = () => ({ botId: 3n, rating: 1510 });
  `);
  r.hooks.matchUpdate({}, oldMatch, r.matches[0]);
  r.intervals[0](); // Run the stop poll before any deferred timer could fire.

  const artifact = [...r.writes].find(([file]) => file.endsWith("/match-1.json"));
  assert.ok(artifact, "the result must be written before the stop poll can exit");
  const result = JSON.parse(artifact[1]);
  assert.equal(result.score, 72);
  assert.equal(result.balance, 14);
  assert.equal(result.stats.rating, 1510);
  assert.deepEqual(result.rack, { Z: 1 });
  assert.equal(result.auctions[0].auctionId, "2");
  assert.equal(result.topBids[0].topBid, "8");
  assert.equal(result.words[0].word, "AT");
  assert.ok(r.activity.indexOf(`write:${artifact[0]}`) < r.activity.indexOf("disconnect"));
  assert.ok(r.activity.indexOf("event:match_end") < r.activity.indexOf("exit"));
  assert.equal(r.timeouts.length, 0);
  assert.deepEqual(r.exits, [0]);
});

test("unexpected disconnect fails promptly even before subscription readiness", () => {
  const r = runner();
  r.run("main(); ready = false;");
  r.hooks.onDisconnect();
  assert.deepEqual(r.exits, [1]);
});

test("failure logs redact stored, server-issued tokens and credential nonces", () => {
  const r = runner();
  r.run('loadToken(); saveToken("server-secret"); logFailure("test")("stored-secret server-secret nonce-secret");');
  assert.equal(r.events.at(-1)?.data.message, "[redacted] [redacted] [redacted]");
});

test("Monte Carlo selection records its configuration and uses its bids", () => {
  const r = runner({ STRATEGY: "montecarlo" });
  r.run("tryBid(conn, 2n, 1n, 'A')");
  assert.equal((r.bids[0] as any).amount, 17n);
  assert.equal(r.events[0].data.strategy, "montecarlo");
  assert.equal(r.events[0].data.config.MC_LAMBDA, 0.5);
  assert.equal(typeof r.events.find(e => e.event === "bid")?.data.decisionMs, "number");
});

test("market selection records its model and uses market bids", () => {
  const r = runner({ STRATEGY: "market" });
  r.run("tryBid(conn, 2n, 1n, 'A')");
  assert.equal((r.bids[0] as any).amount, 23n);
  assert.equal(r.events[0].data.strategy, "market");
  assert.equal(r.events[0].data.config.futureMarkets, 8);
});

test("VERSION tags the run and BID/WORD_STRATEGY take each task from its own module", () => {
  assert.throws(() => runner({ VERSION: "../x" }), /VERSION/);
  assert.throws(() => runner({ BID_STRATEGY: "nope" }), /Unknown STRATEGY/);
  assert.throws(() => runner({ WORD_STRATEGY: "trained-market" }), /POLICY_MODEL/);
  const r = runner({ STRATEGY: "value", VERSION: "v3", BID_STRATEGY: "market", WORD_STRATEGY: "trained-market", POLICY_MODEL: "runs/selected.json" });
  r.run("tryBid(conn, 2n, 1n, 'A'); tryPlayWord(conn)");
  assert.deepEqual([r.events[0].data.version, r.events[0].data.bidStrategy, r.events[0].data.wordStrategy], ["v3", "market", "trained-market"]);
  assert.equal(r.events[0].data.configs["market"].futureMarkets, 8);
  assert.ok(r.events[0].data.configs["trained-market"].policyModel);
  assert.ok(r.copies.some(([, to]) => /\/[^/]*-value-v3\/strategy\.ts$/.test(to)));
  for (const filename of ["strategy-market.ts", "strategy-trained-market.ts", "policy-model.json", "market-prices.json"]) {
    assert.ok(r.copies.some(([, to]) => to.endsWith("/" + filename)), filename);
  }
  assert.equal((r.bids[0] as any).amount, 23n);
  assert.ok(r.decisions.word.length >= 1); // index warm-up plus the play both route to trained-market
});

test("hold7 word logic needs the policy model and snapshots the trained-market sources", () => {
  assert.throws(() => runner({ STRATEGY: "market", WORD_STRATEGY: "hold7" }), /POLICY_MODEL/);
  const r = runner({ STRATEGY: "trained-market", WORD_STRATEGY: "hold7", POLICY_MODEL: "runs/selected.json" });
  r.run("tryPlayWord(conn)");
  assert.equal((r.words[0] as any).word, "HOLDING");
  assert.equal(r.events[0].data.configs.hold7.holdUntil, 20);
  for (const filename of ["experiment-hold-word.ts", "strategy-trained-market.ts", "policy-model.json"]) assert.ok(r.copies.some(([, to]) => to.endsWith("/" + filename)), filename);
});

test("the default strategy is the market policy that reached first place", () => {
  const r = runner({ STRATEGY: undefined });
  assert.equal(r.events[0].data.strategy, "market");
  assert.equal(r.events[0].data.config.futureMarkets, 8);
});

for (const strategy of ["montecarlo-pool", "trained-market"]) test(`${strategy} wires the bounded pool, counts the current tile once, and falls back on late join`, () => {
  const setup = (lateJoin = false) => {
    const r = runner({ STRATEGY: strategy, POLICY_MODEL: "runs/observed.json" }, false, true);
    r.run("globalThis.poolScanCount = 0; const scan = conn.db.auctionResult.resultByMatch.filter; conn.db.auctionResult.resultByMatch.filter = (id) => { poolScanCount++; return scan(id); };");
    r.run("globalThis.auctionLookups = 0; const findAuction = conn.db.auction.id.find; conn.db.auction.id.find = (id) => { auctionLookups++; return findAuction(id); };");
    r.matches[0].bagTotal = lateJoin ? 66 : 67;
    for (let botId = 4n; botId <= 8n; botId++) r.participants.push({ matchId: 1n, botId, balance: 100n, score: 0n });
    r.addAuction({ id: 2n, matchId: 1n, letter: "Q", status: { tag: "Open" } });
    r.run(`conn.db.myRack.iter().splice(0, 2,
      { matchId: 1n, letter: 'A', count: 2 }, { matchId: 1n, letter: 'E', count: 1 },
      { matchId: 1n, letter: 'I', count: 1 }, { matchId: 1n, letter: 'X', count: 1 });`);
    if (lateJoin) r.run("conn.db.auctionResult.iter().push({ matchId: 1n, auctionId: 1n, letter: 'E' });");
    r.run("tryBid(conn, 2n, 1n, 'Q'); tryPlayWord(conn);");
    return r;
  };
  const fresh = setup();
  const scans = fresh.run("poolScanCount");
  const lookups = fresh.run("auctionLookups");
  assert.equal(lookups, 0, "pool construction must not scan the auction id index");
  fresh.run("poolForMatch(conn, 1n); poolForMatch(conn, 1n);");
  assert.equal(fresh.run("poolScanCount"), scans, "polling must reuse the current auction pool");
  assert.equal(fresh.run("auctionLookups"), lookups, "cached pools must also avoid the SDK auction index scan");
  for (const ctx of [fresh.decisions.bid.at(-1), fresh.decisions.word.at(-1)]) {
    assert.ok(ctx.remainingLetters);
    assert.equal(ctx.remainingLetters.get("Q"), 0);
    assert.equal(ctx.remainingLetters.get("X"), 0);
    assert.equal(ctx.remainingLetters.get("A"), 7);
    assert.equal([...ctx.remainingLetters.values()].reduce((sum: number, n: number) => sum + n, 0), 92);
  }
  fresh.run("conn.db.auctionResult.iter().push({ matchId: 1n, auctionId: 2n, letter: 'Q' }); conn.db.myRack.iter().length = 0;");
  const sameAuction = fresh.run("poolForMatch(conn, 1n)");
  assert.equal(sameAuction.get("Q"), 0, "the current auction must not be subtracted twice");
  assert.equal([...sameAuction.values()].reduce((sum: number, n: number) => sum + n, 0), 92, "playing initial tiles must not change the captured initial rack");
  fresh.matches[0].bagTotal = 66;
  fresh.matches[0].currentAuctionId = 3n;
  fresh.addAuction({ id: 3n, matchId: 1n, letter: "E", status: { tag: "Open" } });
  fresh.run("tryBid(conn, 3n, 1n, 'E');");
  const next = fresh.decisions.bid.at(-1).remainingLetters;
  assert.equal(fresh.run("poolScanCount"), scans + 1, "the next auction refreshes the pool once");
  assert.equal(next.get("Q"), 0);
  assert.equal(next.get("E"), 10);
  assert.equal([...next.values()].reduce((sum: number, n: number) => sum + n, 0), 91);

  const late = setup(true);
  assert.equal(late.decisions.bid.at(-1).remainingLetters, undefined);
  assert.equal(late.decisions.word.at(-1).remainingLetters, undefined);
});

test("state changes revise bids after acknowledgement, deduplicate amounts, and retry a failed cancellation", async () => {
  const r = runner({}, true);
  const bid = () => r.run("tryBid(conn, 2n, 1n, 'A')");
  bid();
  r.participants[0].balance = 5n;
  bid();
  assert.equal(r.bids.length, 1, "must wait for the prior reducer");
  r.pendingBids.shift()!.resolve();
  await r.settled();
  bid();
  assert.equal((r.bids.at(-1) as any).amount, 0n, "must cancel the old positive bid");
  r.pendingBids.shift()!.reject(new Error("temporary failure"));
  await r.settled();
  bid();
  assert.equal(r.bids.length, 3, "failed cancellation must retry");
  r.pendingBids.shift()!.resolve();
  await r.settled();
  r.participants[0].balance = 100n;
  bid();
  assert.equal((r.bids.at(-1) as any).amount, 5n, "new cash must restore the bid");
  r.pendingBids.shift()!.resolve();
  await r.settled();
  r.participants[0].balance = 99n;
  bid();
  bid();
  assert.equal(r.bids.length, 4, "unchanged amount must not be resubmitted");
});

test("target rank stops before joining another match and remains optional", () => {
  const target = runner({ TARGET_RANK: "1" });
  target.matches[0].status.tag = "Ended";
  target.run("conn.db.botStats.botId.find = () => ({ botId: 3n, rating: 1500 }); conn.db.botStats.iter = () => [{ botId: 3n, rating: 1500 }];");
  target.run("finishMatch(conn, 1n)");
  assert.equal(target.disconnected(), true);
  assert.deepEqual(target.exits, [0]);
  assert.equal(target.run("joiningLobby"), false);
  const normal = runner();
  normal.matches[0].status.tag = "Ended";
  normal.run("finishMatch(conn, 1n)");
  assert.equal(normal.disconnected(), false);
  assert.equal(normal.run("joiningLobby"), true);
  const missingStats = runner({ TARGET_RANK: "1" });
  missingStats.matches[0].status.tag = "Ended";
  missingStats.run("finishMatch(conn, 1n)");
  assert.equal(missingStats.disconnected(), false, "an unknown rating cannot prove the target rank");
});

test("missing or null own stats produce a null rank and cannot satisfy the target", () => {
  for (const missing of ["undefined", "null"]) {
    const r = runner({ TARGET_RANK: "1" });
    r.run(`conn.db.botStats.botId.find = () => ${missing}; conn.db.botStats.iter = () => [{ botId: 4n, rating: 1500 }];`);
    assert.equal(r.run("recordLeaderboard(conn)"), null);
    r.matches[0].status.tag = "Ended";
    r.run("finishMatch(conn, 1n)");
    const artifact = [...r.writes].find(([file]) => file.endsWith("/match-1.json"))!;
    assert.equal(JSON.parse(artifact[1]).leaderboardRank, null);
    assert.equal(r.events.find(e => e.event === "match_end")!.data.leaderboardRank, null);
    assert.equal(r.disconnected(), false);
  }
});

test("a genuine zero rating has a real rank and can satisfy the target", () => {
  const r = runner({ TARGET_RANK: "1" });
  r.run("conn.db.botStats.botId.find = () => ({ botId: 3n, rating: 0 }); conn.db.botStats.iter = () => [{ botId: 3n, rating: 0 }, { botId: 4n, rating: 10 }];");
  assert.equal(r.run("recordLeaderboard(conn)"), 2);
  r.run("conn.db.botStats.iter = () => [{ botId: 3n, rating: 0 }];");
  r.matches[0].status.tag = "Ended";
  r.run("finishMatch(conn, 1n)");
  assert.equal(r.events.find(e => e.event === "match_end")!.data.leaderboardRank, 1);
  assert.equal(r.disconnected(), true);
});

test("learned market requires a model, records its hash, and snapshots runtime dependencies", () => {
  assert.throws(() => runner({ STRATEGY: "learned-market" }), /MARKET_MODEL/);
  const r = runner({ STRATEGY: "learned-market", MARKET_MODEL: "runs/model.json" });
  r.run("tryBid(conn, 2n, 1n, 'A')");
  assert.equal((r.bids[0] as any).amount, 29n);
  assert.equal(r.events[0].data.config.learnedPrices.sha256, "trained-hash");
  for (const filename of ["strategy-market.ts", "strategy-montecarlo.ts", "market-prices.json", "learned-prices.json"]) {
    assert.ok(r.copies.some(([, to]) => to.endsWith("/" + filename)), filename);
  }
});

test("trained market requires a model, records search depth, and preserves the dependency snapshots", () => {
  assert.throws(() => runner({ STRATEGY: "trained-market" }), /POLICY_MODEL/);
  const r = runner({ STRATEGY: "trained-market", POLICY_MODEL: "runs/selected.json" });
  r.run("tryBid(conn, 2n, 1n, 'A')");
  assert.equal((r.bids[0] as any).amount, 31n);
  assert.equal(r.events[0].data.config.futureMarkets, 32);
  assert.equal(r.events[0].data.config.policyModel.sha256, "policy-hash");
  for (const filename of ["strategy-market.ts", "strategy-learned-market.ts", "strategy-montecarlo.ts", "market-prices.json", "policy-model.json"]) {
    assert.ok(r.copies.some(([, to]) => to.endsWith("/" + filename)), filename);
  }
  assert.ok(!r.copies.some(([, to]) => to.endsWith("/learned-prices.json")));
});


test("polling does not perform a separate SDK index scan for every historical match", () => {
  const r = runner();
  for (let id = 100n; id < 300n; id++) {
    r.matches.push({ ...r.matches[0], id, status: { tag: "Ended" } });
    r.participants.push({ matchId: id, botId: 3n, balance: 100n, score: 5n });
  }
  r.run("const findMatch = conn.db.matchState.id.find; conn.db.matchState.id.find = (id) => { if (id !== 1n) throw new Error('Historical index scan'); return findMatch(id); };");
  r.run("bootstrapActivity(conn)");
  r.intervals[0]();
  assert.equal(r.words.length, 1);
  assert.equal(r.events.filter(e => e.event === "match_start").length, 1);
});


test("successful word acknowledgement immediately revalues fresh cash and records its time", async () => {
  const r = runner();
  r.addAuction({ id: 2n, matchId: 1n, letter: "A", status: { tag: "Open" } });
  r.participants[0].balance = 8n;
  r.run("tryBid(conn, 2n, 1n, 'A'); Date.now = (() => { let now = 1000; return () => now += 7; })(); tryPlayWord(conn);");
  assert.equal(r.bids.length, 0);
  r.participants[0].balance = 10n;
  r.run("conn.db.myRack.iter().length = 0;");
  await r.settled();
  assert.equal(r.bids.length, 1, "acknowledgement must bid without waiting for the poll");
  assert.equal((r.bids[0] as any).amount, 5n);
  const ack = r.events.find(e => e.event === "word_ack")!;
  assert.ok(Number.isFinite(Date.parse(ack.at)));
  assert.equal(ack.data.roundTripMs, 7);
  assert.ok(r.events.indexOf(ack) < r.events.map(e => e.event).lastIndexOf("bid"));
});

test("word acknowledgement targets the current auction after the original one closes", async () => {
  const r = runner();
  r.addAuction({ id: 2n, matchId: 1n, letter: "A", status: { tag: "Open" } });
  r.run("tryPlayWord(conn)");
  r.auctions[0].status.tag = "Closed";
  r.matches[0].currentAuctionId = 3n;
  r.addAuction({ id: 3n, matchId: 1n, letter: "E", status: { tag: "Open" } });
  await r.settled();
  assert.equal(r.bids.length, 1);
  assert.equal((r.bids[0] as any).auctionId, 3n);
});

test("word acknowledgement skips ended matches, closed or missing auctions, and stopped activity", async () => {
  for (const change of [
    "conn.db.matchState.id.find(1n).status.tag = 'Ended'",
    "conn.db.auction.id.find(2n).status.tag = 'Closed'",
    "conn.db.matchState.id.find(1n).currentAuctionId = undefined",
    "ready = false",
  ]) {
    const r = runner();
    r.addAuction({ id: 2n, matchId: 1n, letter: "A", status: { tag: "Open" } });
    r.run("tryPlayWord(conn)");
    r.run(change);
    await r.settled();
    assert.equal(r.events.filter(e => e.event === "word_ack").length, 1);
    assert.equal(r.bids.length, 0, change);
  }
});

test("acknowledgement revaluation preserves pending-bid and same-amount deduplication", async () => {
  for (const hold of [false, true]) {
    const r = runner({}, hold);
    r.addAuction({ id: 2n, matchId: 1n, letter: "A", status: { tag: "Open" } });
    r.run("tryBid(conn, 2n, 1n, 'A')");
    await r.settled();
    r.run("tryPlayWord(conn)");
    r.participants[0].balance = 102n;
    r.run("conn.db.myRack.iter().length = 0;");
    await r.settled();
    assert.equal(r.bids.length, 1, "word acknowledgement must not duplicate a pending or unchanged bid");
    if (hold) {
      r.pendingBids.shift()!.resolve();
      await r.settled();
      r.run("tryBid(conn, 2n, 1n, 'A')");
      assert.equal(r.bids.length, 1, "polling after acknowledgement must still deduplicate the amount");
    }
  }
});

test("failed word submission logs its failure without acknowledgement or immediate revaluation", async () => {
  const r = runner();
  r.addAuction({ id: 2n, matchId: 1n, letter: "A", status: { tag: "Open" } });
  r.run("tryPlayWord(conn)");
  await r.rejected(new Error("word refused"));
  assert.equal(r.events.filter(e => e.event === "word_ack").length, 0);
  assert.equal(r.events.find(e => e.event === "failure")?.data.what, "playing 'AT'");
  assert.equal(r.run("pendingWordMatches.has(1n)"), false);
  assert.equal(r.bids.length, 0);
});


test("errors in acknowledgement revaluation are logged and clear word pending state", async () => {
  const r = runner();
  r.addAuction({ id: 2n, matchId: 1n, letter: "A", status: { tag: "Open" } });
  r.run("tryPlayWord(conn); conn.db.matchState.id.find = () => { throw new Error('revaluation lookup failed'); };");
  await r.settled();
  assert.equal(r.events.filter(e => e.event === "word_ack").length, 1);
  assert.equal(r.events.find(e => e.event === "failure")?.data.message, "revaluation lookup failed");
  assert.equal(r.run("pendingWordMatches.has(1n)"), false);
  assert.equal(r.bids.length, 0);
});

test("a rejected acknowledgement-driven bid keeps the bid failure attribution", async () => {
  const r = runner({}, true);
  r.addAuction({ id: 2n, matchId: 1n, letter: "A", status: { tag: "Open" } });
  r.run("tryPlayWord(conn)");
  await r.settled();
  assert.equal(r.bids.length, 1);
  r.pendingBids.shift()!.reject(new Error("bid refused"));
  await r.settled();
  const failures = r.events.filter(e => e.event === "failure");
  assert.equal(failures.length, 1);
  assert.equal(failures[0].data.what, "bid on auction 2");
  assert.equal(r.run("pendingWordMatches.has(1n)"), false);
});


test("open-auction cache follows insert, update and delete without removing a newer auction", async () => {
  const r = runner();
  r.run("onConnect(conn, { toHexString: () => 'test' }, 'test-token'); ready = false;");
  const first = { id: 2n, matchId: 1n, letter: "A", status: { tag: "Open" } };
  r.auctions.push(first);
  r.hooks.auctionInsert({}, first);
  assert.equal(r.run("openAuctionsById.size"), 1);
  const next = { id: 3n, matchId: 1n, letter: "E", status: { tag: "Open" } };
  r.matches[0].currentAuctionId = 3n;
  r.auctions.push(next);
  r.hooks.auctionInsert({}, next);
  r.hooks.auctionUpdate({}, first, { ...first, status: { tag: "Closed" } });
  assert.equal(r.run("openAuctionsById.has(2n)"), false);
  assert.equal(r.run("openAuctionsById.has(3n)"), true, "closing the prior row must preserve its successor");
  const updated = { ...next, letter: "I" };
  r.hooks.auctionUpdate({}, next, updated);
  assert.equal(r.run("openAuctionsById.get(3n).letter"), "I");
  r.hooks.auctionDelete({}, updated);
  assert.equal(r.run("openAuctionsById.size"), 0);
  r.run("ready = true; tryPlayWord(conn)");
  await r.settled();
  assert.equal(r.bids.length, 0, "a deleted current row must not be revived by acknowledgement");
});

test("bootstrap scans auction history once; polling, acknowledgements and pools use the cache", async () => {
  const r = runner({ STRATEGY: "montecarlo-pool" });
  r.run("onConnect(conn, { toHexString: () => 'test' }, 'test-token');");
  r.matches[0].bagTotal = 67;
  for (let botId = 4n; botId <= 8n; botId++) r.participants.push({ matchId: 1n, botId, balance: 100n, score: 0n });
  for (let id = 10n; id < 10010n; id++) r.auctions.push({ id, matchId: 99n, letter: "A", status: { tag: "Closed" } });
  r.auctions.push({ id: 2n, matchId: 1n, letter: "Q", status: { tag: "Open" } });
  r.run(`conn.db.myRack.iter().splice(0, 2,
    { matchId: 1n, letter: 'A', count: 2 }, { matchId: 1n, letter: 'E', count: 1 },
    { matchId: 1n, letter: 'I', count: 1 }, { matchId: 1n, letter: 'X', count: 1 });
    globalThis.auctionScans = 0;
    const auctionIter = conn.db.auction.iter;
    conn.db.auction.iter = () => { auctionScans++; return auctionIter(); };
    conn.db.auction.id.find = () => { throw new Error('Unexpected auction history lookup'); };
    bootstrapActivity(conn);`);
  assert.equal(r.run("auctionScans"), 1);
  assert.equal(r.run("openAuctionsById.size"), 1, "closed history must not accumulate in the cache");
  r.intervals[0]();
  await r.settled();
  r.run("poolForMatch(conn, 1n)");
  assert.equal(r.run("auctionScans"), 1);
  assert.equal(r.events.filter(e => e.event === "failure").length, 0);
  assert.equal(r.events.filter(e => e.event === "word_ack").length, 1);
  assert.equal(r.bids.length, 1, "acknowledgement and polling must retain amount deduplication");
  assert.equal(r.decisions.word.at(-1).remainingLetters.get("Q"), 0);
});

import * as fs from "node:fs";
import * as path from "node:path";
import assert from "node:assert/strict";
import * as baseline from "./baseline.js";
import * as value from "./strategy.js";

const dictionary = fs.readFileSync(new URL("../../spacetimedb/wordlist.txt", import.meta.url), "utf8")
  .split("\n").map(w => w.trim().toUpperCase()).filter(w => w.length >= 2).sort((a, b) => b.length - a.length);
value.chooseWord({ dictionary, myRack: new Map() });
const runs = path.resolve("runs");
const summaries: Record<string, unknown>[] = [];
for (const dir of fs.readdirSync(runs).sort()) {
  const root = path.join(runs, dir);
  if (!fs.statSync(root).isDirectory() || !fs.existsSync(path.join(root, "events.jsonl"))) continue; // search/benchmark dirs hold no live runs
  const events = fs.readFileSync(path.join(root, "events.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l));
  for (const file of fs.readdirSync(root).filter(f => /^match-\d+\.json$/.test(f)).sort((a, b) => Number(BigInt(a.slice(6, -5)) - BigInt(b.slice(6, -5))))) {
    const match = JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
    const words = match.words.filter((w: any) => w.botId === match.botId);
    const won = match.auctions.filter((a: any) => a.winnerBotId === match.botId);
    const spent = won.reduce((n: number, a: any) => n + Number(a.paid), 0);
    const start = events.find(e => e.event === "match_start" && e.data.match.id === match.matchId)?.data;
    const twentieth = [...match.auctions].sort((a, b) => Number(BigInt(a.auctionId) - BigInt(b.auctionId)))[19];
    const cutoff = Number(twentieth?.closedAt.__timestamp_micros_since_unix_epoch__ ?? 0);
    assert.equal(words.reduce((n: number, w: any) => n + Number(w.totalReward), 0), match.score, `Word totals disagree for ${match.matchId}`);
    assert.equal(match.balance, 100 + match.score - spent, `Balance disagrees for ${match.matchId}`);
    const summary = { run: dir, strategy: match.strategy, version: match.version ?? "", bidStrategy: match.bidStrategy ?? match.strategy, wordStrategy: match.wordStrategy ?? match.strategy, sourceHash: events.find(e => e.event === "run")?.data.sourceHash,
      runnerHash: events.find(e => e.event === "run")?.data.runnerHash,
      config: events.find(e => e.event === "run")?.data.config ?? {}, match: match.matchId,
      place: match.place, score: match.score, rating: match.stats?.rating,
      rank: match.leaderboardRank, tilesWon: won.length, spent, balance: match.balance,
      meanPaid: won.length ? +(spent / won.length).toFixed(2) : 0,
      scoreAtAuction20: words.filter((w: any) => Number(w.playedAt.__timestamp_micros_since_unix_epoch__) <= cutoff).reduce((n: number, w: any) => n + Number(w.totalReward), 0),
      unusedTiles: Object.values(match.rack).reduce((n: number, x: any) => n + Number(x), 0),
      words: words.map((w: any) => w.word).join(" "),
      meanWordLength: words.length ? +(words.reduce((n: number, w: any) => n + w.word.length, 0) / words.length).toFixed(2) : 0 };
    summaries.push(summary);
    if (!process.argv.includes("--replay") || !start || Number(start.participant.score) !== 0) continue;
    const topBids = new Map<string, number>(match.topBids.map((a: any) => [a.auctionId, Number(a.topBid)]));
    for (const [name, policy] of Object.entries({ baseline, value })) {
      const rack = new Map<string, number>(Object.entries(start.rack));
      let score = 0, balance = Number(start.participant.balance), spending = 0, acquired = 0, used = 0;
      const played: string[] = [];
      const auctions = [...match.auctions].sort((a, b) => Number(BigInt(a.auctionId) - BigInt(b.auctionId)));
      for (let i = 0; i < auctions.length; i++) {
        const a = auctions[i];
        const bagRemaining = auctions.length - i - 1;
        let word: string | null;
        while ((word = policy.chooseWord({ dictionary, myRack: rack, myBalance: balance, bagRemaining }))) {
          for (const c of word) {
            assert.ok((rack.get(c) ?? 0) > 0);
            rack.set(c, rack.get(c)! - 1);
          }
          const reward = value.wordScore(word);
          balance += reward; score += reward; used += word.length; played.push(word);
        }
        const bid = policy.decideBid({ dictionary, myRack: rack, myBalance: balance, bagRemaining,
          letter: a.letter, auctionType: match.match.auctionType.tag });
        const opponentBid = a.winnerBotId === match.botId ? Number(a.paid) : topBids.get(a.auctionId);
        assert.notEqual(opponentBid, undefined, "Missing archived bid");
        // A fixed-price replay is diagnostic: opponents cannot react to our different actions.
        if (bid > 0 && (a.winnerBotId == null || bid > opponentBid!)) {
          const price = match.match.auctionType.tag === "FirstPrice" ? bid : Math.max(1, opponentBid!);
          assert.ok(price <= balance);
          balance -= price; spending += price; acquired++;
          rack.set(a.letter, (rack.get(a.letter) ?? 0) + 1);
        }
      }
      assert.equal(balance, Number(start.participant.balance) + score - spending);
      assert.equal([...rack.values()].reduce((n, x) => n + x, 0), Object.values(start.rack).reduce((n: number, x: any) => n + x, 0) + acquired - used);
      console.log(JSON.stringify({ replay: match.matchId, policy: name, score, balance, spending, acquired, played }));
    }
  }
}
fs.writeFileSync(path.join(runs, "summary.json"), JSON.stringify(summaries, null, 2) + "\n");
if (!process.argv.includes("--replay")) console.table(summaries.map(s => ({
  match: s.match, version: s.version || String(s.sourceHash).slice(0, 8), bid: s.bidStrategy, word: s.wordStrategy, score: s.score, place: s.place,
  rating: s.rating, tiles: s.tilesWon, spent: s.spent, cash: s.balance,
  scoreAt20: s.scoreAtAuction20, words: s.words,
})));
// Per-version series: each VERSION tag (or strategy when untagged) starts its own local stats.
const series = new Map<string, any[]>();
for (const s of summaries) { const key = String(s.version || s.strategy); series.set(key, [...(series.get(key) ?? []), s]); }
const mean = (xs: number[]) => +(xs.reduce((n, x) => n + x, 0) / xs.length).toFixed(2);
if (!process.argv.includes("--replay")) console.table([...series].map(([version, rows]) => ({
  version, matches: rows.length, bid: [...new Set(rows.map(r => r.bidStrategy))].join("+"), word: [...new Set(rows.map(r => r.wordStrategy))].join("+"),
  wins: rows.filter(r => r.place === 1).length, meanPlace: mean(rows.map(r => r.place)), meanScore: mean(rows.map(r => r.score)), lastRating: rows.at(-1)!.rating,
})));

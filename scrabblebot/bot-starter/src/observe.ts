// Read-only public history snapshot for opponent research; never joins or submits actions.
import { DbConnection } from "./module_bindings/index.js";
import * as fs from "node:fs";
import * as path from "node:path";
import assert from "node:assert/strict";
if (!process.env.BOT_TOKEN) throw new Error("BOT_TOKEN is required");
const output = process.argv[2] ?? "runs/public-history.json";
const timeout = setTimeout(() => { console.error("History subscription timed out"); process.exit(1); }, 30000);
DbConnection.builder()
  .withUri(process.env.STDB_HOST ?? "https://maincloud.spacetimedb.com")
  .withDatabaseName(process.env.STDB_DB ?? "scrabblebot")
  .withToken(process.env.BOT_TOKEN)
  .onConnect(conn => conn.subscriptionBuilder()
    .onError(() => { console.error("History subscription failed"); process.exit(1); })
    .onApplied(() => {
      const matches = [...conn.db.matchState.iter()].filter(m => m.status.tag === "Ended");
      const ids = new Set(matches.map(m => m.id));
      assert.equal(ids.size, matches.length);
      assert.ok(matches.length > 0, "No completed matches");
      const snapshot = { capturedAt: new Date().toISOString(), bots: [...conn.db.bot.iter()], stats: [...conn.db.botStats.iter()], matches,
        participants: [...conn.db.matchParticipant.iter()].filter(p => ids.has(p.matchId)),
        auctions: [...conn.db.auctionResult.iter()].filter(a => ids.has(a.matchId)),
        topBids: [...conn.db.auctionTopBidArchive.iter()].filter(a => ids.has(a.matchId)),
        words: [...conn.db.wordPlay.iter()].filter(w => ids.has(w.matchId)) };
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.writeFileSync(output + ".tmp", JSON.stringify(snapshot, (_key, value) => typeof value === "bigint" ? value.toString() : value), { mode: 0o600 });
      fs.renameSync(output + ".tmp", output);
      console.log(`Saved ${matches.length} matches, ${snapshot.auctions.length} auctions and ${snapshot.words.length} words.`);
      clearTimeout(timeout);
      conn.disconnect();
      process.exit(0);
    })
    .subscribe(["SELECT * FROM bot", "SELECT * FROM bot_stats", "SELECT * FROM match_state", "SELECT * FROM match_participant", "SELECT * FROM auction_result", "SELECT * FROM auction_top_bid_archive", "SELECT * FROM word_play"]))
  .onConnectError(() => { console.error("History connection failed"); process.exit(1); })
  .build();

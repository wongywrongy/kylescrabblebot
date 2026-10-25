// Audit recorded own-word transactions after a bid and before its auction closes.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { pathToFileURL } from 'node:url';

const dictionary = fs.readFileSync('../spacetimedb/wordlist.txt', 'utf8').split('\n').map(w => w.trim().toUpperCase()).filter(w => w.length >= 2).sort((a, b) => b.length - a.length);
const rows: any[] = [], totals: any[] = [];
const micros = (v: any) => BigInt(v.__timestamp_micros_since_unix_epoch__);
const rackKey = (r: Record<string, number>) => JSON.stringify(Object.entries(r).filter(([, n]) => n > 0).sort());
for (const dir of fs.readdirSync('runs')) {
  const root = path.join('runs', dir);
  if (!fs.statSync(root).isDirectory() || !fs.existsSync(path.join(root, 'events.jsonl'))) continue;
  const events = fs.readFileSync(path.join(root, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const me = events.find(e => e.event === 'connected')?.data.botId;
  const config = events.find(e => e.event === 'run')?.data.config ?? {};
  const sourceFile = path.join(root, 'strategy.ts');
  if (!me || !fs.existsSync(sourceFile)) continue;
  const source = fs.readFileSync(sourceFile, 'utf8').replaceAll('./baseline.js', pathToFileURL(path.resolve('src/baseline.ts')).href);
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const policy = await import('data:text/javascript;base64,' + Buffer.from(`const process={env:${JSON.stringify(config)}};\n${js}\n//${dir}`).toString('base64'));
  policy.chooseWord({ dictionary, myRack: new Map() });
  const matches = fs.readdirSync(root).filter(f => /^match-\d+\.json$/.test(f)).map(f => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8')));
  let bids = 0, bidsBeforePriorResultCallback = 0, priorAwardChecks = 0, priorAwardRackMismatches = 0;
  for (const match of matches) {
    const all = events.map((e, i) => ({ ...e, i })).filter(e => e.data.matchId === match.matchId);
    const auctions = [...match.auctions].sort((a, b) => Number(BigInt(a.auctionId) - BigInt(b.auctionId)));
    for (const bid of all.filter(e => e.event === 'bid')) {
      bids++;
      const closing = all.find(e => e.event === 'auction_result' && e.data.auctionId === bid.data.auctionId);
      if (!closing) continue;
      const at = auctions.findIndex(a => a.auctionId === bid.data.auctionId), remaining = auctions.length - at - 1;
      assert.ok(at >= 0);
      const previous = at ? auctions[at - 1] : undefined;
      const previousEvent = previous && all.find(e => e.event === 'auction_result' && e.data.auctionId === previous.auctionId);
      if (previousEvent && bid.i < previousEvent.i) bidsBeforePriorResultCallback++;
      if (previous?.winnerBotId === me) {
        const start = events.find(e => e.event === 'match_start' && e.data.match.id === match.matchId)?.data;
        if (start && Number(start.participant.score) === 0) {
          const expected = { ...start.rack };
          for (const a of auctions.slice(0, at)) if (a.winnerBotId === me) expected[a.letter] = (expected[a.letter] ?? 0) + 1;
          for (const w of match.words) if (w.botId === me && micros(w.playedAt) <= micros(previous.closedAt)) for (const c of w.word) expected[c] = (expected[c] ?? 0) - 1;
          priorAwardChecks++;
          if (rackKey(expected) !== rackKey(bid.data.rack)) priorAwardRackMismatches++;
        }
      }
      const ownWords = all.filter(e => e.event === 'word_play' && e.data.botId === me && e.i > bid.i && e.i < closing.i);
      if (!ownWords.length) continue;
      const rack = new Map<string, number>(Object.entries(bid.data.rack));
      let balance = Number(bid.data.balance);
      const opponentBalances = (before: bigint) => {
        const balances = new Map<string, number>(match.participants.filter((p: any) => p.botId !== me).map((p: any) => [p.botId, 100]));
        for (const a of auctions) if (a.winnerBotId !== me && a.winnerBotId && micros(a.closedAt) < before) balances.set(a.winnerBotId, balances.get(a.winnerBotId)! - Number(a.paid));
        for (const w of match.words) if (w.botId !== me && micros(w.playedAt) < before) balances.set(w.botId, balances.get(w.botId)! + Number(w.totalReward));
        return [...balances.values()];
      };
      const before = previous ? micros(previous.closedAt) + 1n : micros(match.match.startedAt) + 1n;
      const initialComputed = policy.decideBid({ dictionary, myRack: rack, myBalance: balance, bagRemaining: remaining, letter: bid.data.letter, auctionType: match.match.auctionType.tag, opponentBalances: opponentBalances(before) });
      for (const word of ownWords) {
        for (const c of word.data.word) { assert.ok((rack.get(c) ?? 0) > 0); rack.set(c, rack.get(c)! - 1); }
        balance += Number(word.data.totalReward);
        const recomputed = policy.decideBid({ dictionary, myRack: rack, myBalance: balance, bagRemaining: remaining, letter: bid.data.letter, auctionType: match.match.auctionType.tag, opponentBalances: opponentBalances(micros(word.data.playedAt) + 1n) });
        rows.push({ run: dir, match: match.matchId, auction: bid.data.auctionId, letter: bid.data.letter, bagRemaining: remaining, oldAmount: bid.data.amount, initialComputed, initialMatches: initialComputed === bid.data.amount, recomputed, change: recomputed - bid.data.amount, cancel: bid.data.amount > 0 && recomputed === 0, newPositive: bid.data.amount === 0 && recomputed > 0, word: word.data.word, balanceBefore: bid.data.balance, balanceAfter: balance, clientMsLeft: Date.parse(closing.at) - Date.parse(word.at), serverMsLeft: Number(micros(auctions[at].closedAt) - micros(word.data.playedAt)) / 1000 });
      }
    }
  }
  totals.push({ run: dir, completedMatches: matches.length, bids, bidsBeforePriorResultCallback, priorAwardChecks, priorAwardRackMismatches });
}
const summarize = (rs: any[]) => ({ states: rs.length, exactOriginalBid: rs.filter(r => r.initialMatches).length, amountChanges: rs.filter(r => r.initialMatches && r.change !== 0).length, unchanged: rs.filter(r => r.initialMatches && r.change === 0).length, cancels: rs.filter(r => r.initialMatches && r.cancel).length, zeroToPositive: rs.filter(r => r.initialMatches && r.newPositive).length, increases: rs.filter(r => r.initialMatches && r.change > 0).length, decreases: rs.filter(r => r.initialMatches && r.change < 0).length, atLeast100msLeft: rs.filter(r => r.initialMatches && r.change !== 0 && r.serverMsLeft >= 100).length });
// Reference state gate: acknowledge only successful calls; serialize replacements.
function gate() {
  let state: { signature: string; amount: number } | undefined, pending: { signature: string; amount: number } | undefined;
  return {
    next(signature: string, amount: number) {
      if (pending || state?.signature === signature) return null;
      if (amount === (state?.amount ?? 0)) { state = { signature, amount }; return null; }
      pending = { signature, amount }; return amount;
    },
    settle(ok: boolean) { assert.ok(pending); if (ok) state = pending; pending = undefined; },
  };
}
const g = gate();
assert.equal(g.next('initial', 0), null);
assert.equal(g.next('funded', 15), 15);
assert.equal(g.next('spent-word', 0), null); // wait for the earlier reducer
g.settle(true);
assert.equal(g.next('spent-word', 0), 0);
g.settle(false);
assert.equal(g.next('spent-word', 0), 0); // failed cancellation must retry
g.settle(true);
assert.equal(g.next('new-rack-same-price', 0), null);
assert.equal(g.next('new-rack-same-price', 0), null);
assert.equal(g.next('better-letter', 21), 21);
g.settle(true);
assert.equal(g.next('changed-state-same-price', 21), null);
assert.equal(g.next('changed-state-same-price', 21), null);
const out = { diagnostic: 'Recorded own word plays during still-open auctions; revisions computed with exact run strategy snapshots. Financial history reconstructs opponent balances from public rewards/payments. Counts exclude ongoing matches.', totals, summary: summarize(rows), recent: summarize(rows.filter(r => r.run >= '2026-10-24T08-09')), rows };
fs.writeFileSync('runs/research-stale-bids.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify({ totals, summary: out.summary, recent: out.recent, largestChanges: [...rows].filter(r => r.initialMatches).sort((a, b) => Math.abs(b.change) - Math.abs(a.change)).slice(0, 12) }, null, 2));

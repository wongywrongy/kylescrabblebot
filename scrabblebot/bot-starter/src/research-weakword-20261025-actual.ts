import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import * as market from './strategy-market.js';
import * as guarded from './research-weakword-20261025.js';

type Policy = { chooseWord: (ctx: Parameters<typeof market.chooseWord>[0]) => string | null; decideBid: (ctx: Parameters<typeof market.decideBid>[0]) => number; config?: object };
type ReplayRow = { match: string; score: number; place: number; win: number; balance: number; spent: number; acquired: number; played: string[]; initialRack: Record<string, number>; actualScore: number; actualPlace: number; firstWordRound: number };
const directories = [
 'runs/2026-10-25T01-09-20.610Z-market-live-20261025',
 'runs/2026-10-25T01-26-31.854Z-market-refine-control-a-20261025',
 'runs/2026-10-25T01-49-33.321Z-market-refine-control-b-20261025',
 'runs/2026-10-25T02-01-11.566Z-market-refine-ack-20261025',
 'runs/2026-10-25T02-09-18.160Z-market-refine-ack-repeat-20261025',
];
const dictionaryText=fs.readFileSync('../spacetimedb/wordlist.txt','utf8');
const dictionary=dictionaryText.split('\n').map(w=>w.trim().toUpperCase()).filter(w=>w.length>=2).sort((a,b)=>b.length-a.length);
const starts=new Map<string,any>();const matches:any[]=[];
for (const directory of directories) {
 for(const line of fs.readFileSync(path.join(directory,'events.jsonl'),'utf8').split('\n'))if(line.includes('"match_start"')){const e=JSON.parse(line);if(e.event==='match_start'&&Number(e.data.participant.score)===0)starts.set(e.data.match.id,e.data);}
 for(const file of fs.readdirSync(directory).filter(f=>/^match-\d+\.json$/.test(f))) {const match=JSON.parse(fs.readFileSync(path.join(directory,file),'utf8'));match.cohort=directories.indexOf(directory)>=3?'ack12':directory===directories[0]?'prior10':'newControl12';matches.push(match);}
}
matches.sort((a,b)=>Number(a.matchId)-Number(b.matchId));
assert.equal(matches.filter(m=>m.cohort==='prior10').length,10);assert.equal(matches.filter(m=>m.cohort==='newControl12').length,12);
assert.equal(matches.filter(m=>m.cohort==='ack12').length,12);
const policies: readonly (readonly [string, Policy])[] =[['market8',market],['weakRackEarlyLiquidation',guarded]];
const outputs: { policy: string; config?: object; summary: object; timing: object; rows: ReplayRow[] }[]=[];
for(const [name,policy] of policies){
 policy.chooseWord({dictionary,myRack:new Map()});const rows: ReplayRow[]=[];const times:number[]=[];
 for(const match of matches){
  const start=starts.get(match.matchId);assert.ok(start);const initial=new Map<string,number>(Object.entries(start.rack));assert.equal([...initial.values()].reduce((a,b)=>a+b,0),5);
  const rack=new Map(initial),auctions=[...match.auctions].sort((a,b)=>Number(BigInt(a.auctionId)-BigInt(b.auctionId))),top=new Map<string,number>(match.topBids.map((a:any)=>[a.auctionId,Number(a.topBid)]));
  let score=0,balance=Number(start.participant.balance),spent=0,acquired=0,used=0,firstWordRound=68;const played:string[]=[];
  for(let i=0;i<auctions.length;i++){
   const a=auctions[i],bagRemaining=auctions.length-i-1;
   const remainingLetters = undefined;
   while(true){const t=performance.now();const word=policy.chooseWord({dictionary,myRack:rack,myBalance:balance,bagRemaining,remainingLetters});times.push(performance.now()-t);if(!word)break;if(!played.length)firstWordRound=i+1;for(const c of word){assert.ok((rack.get(c)??0)>0);rack.set(c,rack.get(c)!-1);used++;}const reward=market.wordScore(word);balance+=reward;score+=reward;played.push(word);}
   const t=performance.now();const bid=policy.decideBid({dictionary,myRack:rack,myBalance:balance,bagRemaining,remainingLetters,letter:a.letter,auctionType:match.match.auctionType.tag});times.push(performance.now()-t);assert.ok(Number.isInteger(bid)&&bid>=0&&bid<=balance);
   const threshold=a.winnerBotId===match.botId?Number(a.paid):(top.get(a.auctionId)??0);
   if(bid>0&&bid>threshold){const paid=Math.max(1,threshold);balance-=paid;spent+=paid;acquired++;rack.set(a.letter,(rack.get(a.letter)??0)+1);}
  }
  assert.equal(balance,Number(start.participant.balance)+score-spent);assert.equal([...rack.values()].reduce((a,b)=>a+b,0),5+acquired-used);
  const place=1+match.participants.filter((p:any)=>p.botId!==match.botId&&Number(p.score)>score).length;
  rows.push({match:match.matchId,score,place,win:Number(place===1),balance,spent,acquired,played,initialRack:start.rack,actualScore:match.score,actualPlace:match.place,firstWordRound});
 }
 times.sort((a,b)=>a-b);const mean=(k:'score'|'place'|'win'|'balance'|'spent'|'acquired')=>rows.reduce((n,r)=>n+r[k],0)/rows.length;
 const summary={n:rows.length,score:mean('score'),place:mean('place'),wins:rows.reduce((n,r)=>n+r.win,0),balance:mean('balance'),spent:mean('spent'),acquired:mean('acquired')};
 outputs.push({policy:name,config:policy.config,summary,timing:{p95:times[Math.floor(times.length*.95)],p99:times[Math.floor(times.length*.99)],max:times.at(-1),over100:times.filter(t=>t>=100).length},rows});console.log(JSON.stringify({policy:name,summary,timing:outputs.at(-1)!.timing}));
 fs.writeFileSync('runs/research-weakword-20261025-actual.json',JSON.stringify({directories,cohorts:Object.fromEntries(matches.map(m=>[m.matchId,m.cohort])),note:'Exact own initial racks, replacement replay uses paid runner-up when our archived bot won, rival winning topbid otherwise; frozen opponents cannot react, ties conservatively lost.',dictionarySha256:crypto.createHash('sha256').update(dictionaryText).digest('hex'),policies:outputs},null,2));
}

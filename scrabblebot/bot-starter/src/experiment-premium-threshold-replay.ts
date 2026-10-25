import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import * as current from './strategy-premium.js';
import * as candidate from './experiment-premium-threshold.js';
const dictionary=fs.readFileSync('../spacetimedb/wordlist.txt','utf8').split('\n').map(w=>w.trim().toUpperCase()).filter(w=>w.length>=2).sort((a,b)=>b.length-a.length);
const matches:any[]=[];
for(const dir of fs.readdirSync('runs')){
 const root=path.join('runs',dir);if(!fs.statSync(root).isDirectory())continue;
 const events=fs.readFileSync(path.join(root,'events.jsonl'),'utf8').split('\n').filter(Boolean).map(l=>JSON.parse(l));
 for(const f of fs.readdirSync(root).filter(f=>/^match-\d+\.json$/.test(f))){
  const match=JSON.parse(fs.readFileSync(path.join(root,f),'utf8'));
  const start=events.find(e=>e.event==='match_start'&&e.data.match.id===match.matchId)?.data;
  if(start&&Number(start.participant.score)===0 && BigInt(match.matchId)<=706n && !matches.some(m=>m.match.matchId===match.matchId)) matches.push({match,start});
 }
}
matches.sort((a,b)=>Number(BigInt(a.match.matchId)-BigInt(b.match.matchId)));
const run=(policy: typeof current)=>matches.map(({match,start})=>{
 const rack=new Map<string,number>(Object.entries(start.rack));
 let score=0,balance=Number(start.participant.balance),acquired=0;
 const played:string[]=[];
 const bids=new Map<string,number>(match.topBids.map((a:any)=>[a.auctionId,Number(a.topBid)]));
 const auctions=[...match.auctions].sort((a,b)=>Number(BigInt(a.auctionId)-BigInt(b.auctionId)));
 for(let i=0;i<auctions.length;i++){
  const a=auctions[i],bagRemaining=auctions.length-i-1;
  let word:string|null;
  while((word=policy.chooseWord({dictionary,myRack:rack,myBalance:balance,bagRemaining}))){
   for(const c of word){assert.ok((rack.get(c)??0)>0);rack.set(c,rack.get(c)!-1);}
   const reward=current.wordScore(word);balance+=reward;score+=reward;played.push(word);
  }
  const bid=policy.decideBid({dictionary,myRack:rack,myBalance:balance,bagRemaining,letter:a.letter,auctionType:match.match.auctionType.tag});
  const opponentBid=a.winnerBotId===match.botId?Number(a.paid):bids.get(a.auctionId)!;
  assert.ok(Number.isInteger(bid)&&bid>=0&&bid<=balance);
  if(bid>0&&(a.winnerBotId==null||bid>opponentBid)){
   const price=match.match.auctionType.tag==='FirstPrice'?bid:Math.max(1,opponentBid);
   assert.ok(price<=balance);balance-=price;acquired++;rack.set(a.letter,(rack.get(a.letter)??0)+1);
  }
 }
 return {match:match.matchId,score,balance,acquired,played,rack:Object.fromEntries([...rack].filter(([,n])=>n))};
});
const base=run(current);
const configs=[36,39,42,45].flatMap(threshold=>[10,15,20].map(reserve=>({threshold,reserve})));
const average=(values:number[])=>values.reduce((n,x)=>n+x,0)/values.length;
const stats=(results:typeof base,start:number,end:number)=>{
 const selected=results.slice(start,end),delta=selected.map((r,i)=>r.score-base[start+i].score);
 return {n:selected.length,mean:average(selected.map(r=>r.score)),baselineMean:average(base.slice(start,end).map(r=>r.score)),meanDelta:average(delta),better:delta.filter(d=>d>0).length,worse:delta.filter(d=>d<0).length,tied:delta.filter(d=>d===0).length,worstDelta:Math.min(...delta),scores:selected.map(r=>r.score)};
};
const out=[];
for(const config of configs){
 Object.assign(candidate.premiumExperiment,config);
 const results=run(candidate);
 const row={...config,train:stats(results,0,10),holdout:stats(results,10,base.length),all:stats(results,0,base.length),results};
 out.push(row);console.log(JSON.stringify(row));
}
const benchmark=[];
for (const letters of ['BCDFGHJKLMNPQRSTVWXZ','AEEIINORSTBCDFGHLMNP','AEEINORSTUVWXYZBCDFGH','CODFISHWRITHENJOINTLY']) {
 const rack=new Map<string,number>();for(const c of letters)rack.set(c,(rack.get(c)??0)+1);
 const started=performance.now();
 candidate.chooseWord({dictionary,myRack:rack,myBalance:100,bagRemaining:30});
 candidate.decideBid({dictionary,myRack:rack,myBalance:100,bagRemaining:30,letter:'Z'});
 const milliseconds=performance.now()-started;
 assert.ok(milliseconds<100,`20 tile search exceeded100ms: ${milliseconds}`);
 benchmark.push({rack:letters,tiles:letters.length,milliseconds});
}
const result={frozenThroughMatch:'706',note:'Fixed opponent bids; first ten chronological matches are training, remaining matches are held out. Each variant is one of twelve specified mechanistic choices. No opponent reactions simulated.',trainMatches:base.slice(0,10).map(r=>r.match),holdoutMatches:base.slice(10).map(r=>r.match),baseline:base,variants:out,benchmark};
fs.writeFileSync('runs/research-premium-threshold.json',JSON.stringify(result,null,2));
console.log(JSON.stringify({benchmark}));

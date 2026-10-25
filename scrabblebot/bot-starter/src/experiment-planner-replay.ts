import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import * as current from './experiment-rare-live.js';
import * as candidate from './experiment-planner.js';
import * as fable from './strategy-plan.js';
const dictionary=fs.readFileSync('../spacetimedb/wordlist.txt','utf8').split('\n').map(w=>w.trim().toUpperCase()).filter(w=>w.length>=2).sort((a,b)=>b.length-a.length);
const matches:any[]=[];
for(const dir of fs.readdirSync('runs')){
 const root=path.join('runs',dir);if(!fs.statSync(root).isDirectory())continue;
 const events=fs.readFileSync(path.join(root,'events.jsonl'),'utf8').split('\n').filter(Boolean).map(l=>JSON.parse(l));
 for(const f of fs.readdirSync(root).filter(f=>/^match-\d+\.json$/.test(f))){
  const match=JSON.parse(fs.readFileSync(path.join(root,f),'utf8'));
  const start=events.find(e=>e.event==='match_start'&&e.data.match.id===match.matchId)?.data;
  if(start&&Number(start.participant.score)===0 && BigInt(match.matchId)<=796n && !matches.some(m=>m.match.matchId===match.matchId)) matches.push({match,start});
 }
}
matches.sort((a,b)=>Number(BigInt(a.match.matchId)-BigInt(b.match.matchId)));
type Policy={chooseWord:typeof current.chooseWord;decideBid:(ctx:current.BidContext & {remainingLetters?:Map<string,number>})=>number};
const run=(policy: Policy,observed=false)=>matches.map(({match,start})=>{
 const rack=new Map<string,number>(Object.entries(start.rack));
 let score=0,balance=Number(start.participant.balance),acquired=0,spending=0;
 const rareBought:{letter:string;price:number;round:number}[]=[];
 const played:string[]=[];
 const bagCounts=[9,2,2,4,12,2,3,2,9,1,1,4,2,6,8,2,1,6,4,6,4,2,2,1,2,1];
 const remainingLetters=new Map(bagCounts.map((n,i)=>[String.fromCharCode(65+i),n-(start.rack[String.fromCharCode(65+i)]??0)]));
 const bids=new Map<string,number>(match.topBids.map((a:any)=>[a.auctionId,Number(a.topBid)]));
 const auctions=[...match.auctions].sort((a,b)=>Number(BigInt(a.auctionId)-BigInt(b.auctionId)));
 for(let i=0;i<auctions.length;i++){
  const a=auctions[i],bagRemaining=auctions.length-i-1;
  remainingLetters.set(a.letter,Math.max(0,(remainingLetters.get(a.letter)??0)-1));
  let word:string|null;
  while((word=policy.chooseWord({dictionary,myRack:rack,myBalance:balance,bagRemaining}))){
   for(const c of word){assert.ok((rack.get(c)??0)>0);rack.set(c,rack.get(c)!-1);}
   const reward=current.wordScore(word);balance+=reward;score+=reward;played.push(word);
  }
  const bid=policy.decideBid({dictionary,myRack:rack,myBalance:balance,bagRemaining,letter:a.letter,auctionType:match.match.auctionType.tag,remainingLetters:observed?remainingLetters:undefined});
  const opponentBid=a.winnerBotId===match.botId?Number(a.paid):bids.get(a.auctionId)!;
  assert.ok(Number.isInteger(bid)&&bid>=0&&bid<=balance);
  if(bid>0&&(a.winnerBotId==null||bid>opponentBid)){
   const price=match.match.auctionType.tag==='FirstPrice'?bid:Math.max(1,opponentBid);
   assert.ok(price<=balance);balance-=price;spending+=price;acquired++;if("JQXZ".includes(a.letter))rareBought.push({letter:a.letter,price,round:i});rack.set(a.letter,(rack.get(a.letter)??0)+1);
  }
 }
 return {match:match.matchId,score,balance,spending,acquired,rareBought,played,meanWordLength:played.length?played.reduce((n,w)=>n+w.length,0)/played.length:0,meanPointsPerWord:played.length?score/played.length:0,rack:Object.fromEntries([...rack].filter(([,n])=>n))};
});
const base=run(current);
const configs=["fable","planner-prior","planner-observed"] as const;
const average=(values:number[])=>values.reduce((n,x)=>n+x,0)/values.length;
const stats=(results:typeof base,start:number,end:number)=>{
 const selected=results.slice(start,end),delta=selected.map((r,i)=>r.score-base[start+i].score);
 return {n:selected.length,meanSpending:average(selected.map(r=>r.spending)),meanFinalCash:average(selected.map(r=>r.balance)),meanTilesWon:average(selected.map(r=>r.acquired)),meanWordLength:average(selected.map(r=>r.meanWordLength)),rareAcquired:selected.reduce((n,r)=>n+r.rareBought.length,0),mean:average(selected.map(r=>r.score)),baselineMean:average(base.slice(start,end).map(r=>r.score)),meanDelta:average(delta),better:delta.filter(d=>d>0).length,worse:delta.filter(d=>d<0).length,tied:delta.filter(d=>d===0).length,worstDelta:Math.min(...delta),scores:selected.map(r=>r.score)};
};
const out=[];
for(const config of configs){
 const results=run(config==="fable"?fable:candidate,config==="planner-observed");
 const row={mode:config,train:stats(results,0,10),holdout:stats(results,10,base.length),all:stats(results,0,base.length),results};
 out.push(row);console.log(JSON.stringify(row));
}
const benchmark=[];
for (const letters of ['BCDFGHJKLMNPQRSTVWXZ','AEEIINORSTBCDFGHLMNP','AEEINORSTUVWXYZBCDFGH'.slice(0,17),'CODFISHWRITHENJOINTLY'.slice(0,20),'JINXED','EXITED','JARFUL']) {
 const rack=new Map<string,number>();for(const c of letters)rack.set(c,(rack.get(c)??0)+1);
 const started=performance.now();
 candidate.chooseWord({dictionary,myRack:rack,myBalance:100,bagRemaining:30});
 candidate.decideBid({dictionary,myRack:rack,myBalance:100,bagRemaining:30,letter:'Z'});
 const milliseconds=performance.now()-started;

 benchmark.push({rack:letters,tiles:letters.length,milliseconds});
}
const result={frozenThroughMatch:'796',note:'Fixed opponent bids; first ten chronological matches are training, remaining matches are held out. Word-plan bidder: Fable planner control, own marginal soft planner with default prior, and the same planner with observable public-draw upperbounds. No opponent reactions simulated.',trainMatches:base.slice(0,10).map(r=>r.match),holdoutMatches:base.slice(10).map(r=>r.match),baseline:base,variants:out,benchmark};
fs.writeFileSync('runs/research-planner-recorded.json',JSON.stringify(result,null,2));
console.log(JSON.stringify({benchmark}));

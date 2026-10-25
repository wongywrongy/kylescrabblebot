import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import * as current from './strategy.js';
import * as candidate from './strategy-candidate.js';
const dictionary=fs.readFileSync('../spacetimedb/wordlist.txt','utf8').split('\n').map(w=>w.trim().toUpperCase()).filter(w=>w.length>=2).sort((a,b)=>b.length-a.length);
const matches:any[]=[];
for(const dir of fs.readdirSync('runs')){
 const root=path.join('runs',dir);if(!fs.statSync(root).isDirectory())continue;
 const events=fs.readFileSync(path.join(root,'events.jsonl'),'utf8').split('\n').filter(Boolean).map(l=>JSON.parse(l));
 for(const f of fs.readdirSync(root).filter(f=>/^match-\d+\.json$/.test(f))){
  const match=JSON.parse(fs.readFileSync(path.join(root,f),'utf8'));
  const start=events.find(e=>e.event==='match_start'&&e.data.match.id===match.matchId)?.data;
  if(start&&Number(start.participant.score)===0) matches.push({match,start});
 }
}
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
console.log(JSON.stringify({policy:'current',results:run(current)}));
const results=run(candidate);
console.log(JSON.stringify({policy:'candidate',results,mean:results.reduce((n,r)=>n+r.score,0)/results.length}));
fs.writeFileSync('runs/candidate-final.json',JSON.stringify({results,mean:results.reduce((n,r)=>n+r.score,0)/results.length},null,2));

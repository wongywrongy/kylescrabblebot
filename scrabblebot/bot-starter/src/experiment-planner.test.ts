import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decideBid } from './experiment-planner.js';
const rack=(s:string)=>new Map([...new Set(s)].map(c=>[c,[...s].filter(x=>x===c).length]));
test('planner rejects a future letter already exhausted and respects cash and dictionary isolation',()=>{
 const ctx={myRack:rack('CODIS'),dictionary:['CODFISH'],myBalance:100,bagRemaining:30,letter:'F',remainingLetters:new Map([['H',1]])};
 assert.ok(decideBid(ctx)>18);
 assert.equal(decideBid({...ctx,remainingLetters:new Map()}),0);
 assert.equal(decideBid({...ctx,dictionary:['CATFISH']}),0);
 for(const myBalance of [0,1,20,40,100]){
  const bid=decideBid({...ctx,myBalance});assert.ok(Number.isInteger(bid)&&bid>=0&&bid<=myBalance);
 }
 const closing={...ctx,myRack:rack('CODISH'),myBalance:20,remainingLetters:new Map<string,number>()};
 assert.equal(decideBid(closing),20);
 assert.equal(ctx.myRack.get('I'),1);
});

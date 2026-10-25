import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as planner from './experiment-planner-upgrade.js';
import * as coherent from './experiment-planner-coherent.js';
import * as baseline from './experiment-rare-live.js';
const rack=(s:string)=>new Map([...new Set(s)].map(c=>[c,[...s].filter(x=>x===c).length]));
test('plan upgrades preserve baseline bids while exhausted future letters cannot earn a bonus',()=>{
 const ctx={myRack:rack('CODIS'),dictionary:['CODFISH'],myBalance:100,bagRemaining:30,letter:'F',remainingLetters:new Map([['H',1]])};
 assert.ok(planner.decideBid(ctx)>baseline.decideBid(ctx));
 assert.equal(planner.decideBid({...ctx,remainingLetters:new Map()}),baseline.decideBid(ctx));
 for(const myBalance of [0,1,20,40,100]){
  const bid=planner.decideBid({...ctx,myBalance});assert.ok(Number.isInteger(bid)&&bid>=0&&bid<=myBalance);
 }
 assert.equal(ctx.myRack.get('I'),1);
});
test('coherent timing waits for a funded profitable extension and releases exhausted plans',()=>{
 const ctx={myRack:rack('EXITED'),dictionary:['EXITED','EXISTED'],myBalance:100,bagRemaining:30,remainingLetters:new Map([['S',1]])};
 assert.equal(coherent.chooseWord(ctx),null);
 assert.equal(coherent.chooseWord({...ctx,remainingLetters:new Map()}),'EXITED');
 assert.equal(coherent.chooseWord({...ctx,myBalance:29}),'EXITED');
 assert.equal(coherent.chooseWord({...ctx,bagRemaining:15}),'EXITED');
});

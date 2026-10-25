import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as candidate from './experiment-planner-mc-pool.js';
import * as baseline from './experiment-mc-fast.js';
const rack=(s:string)=>new Map([...new Set(s)].map(c=>[c,[...s].filter(x=>x===c).length]));
test('conditioned futures respect multiplicities, exhaustion, deterministic prefixes, and input ownership',()=>{
 const remaining=new Map([['E',2],['X',1]]);
 const full=candidate.sampleFuture(123,20,remaining),short=candidate.sampleFuture(123,1,remaining);
 full.forEach((d,k)=>{assert.equal(d.length,3);assert.equal(d.filter(c=>c===4).length,2);assert.equal(d.filter(c=>c===23).length,1);assert.deepEqual(short[k],d.slice(0,1));});
 assert.deepEqual(candidate.sampleFuture(123,20,remaining),full);
 assert.ok(candidate.sampleFuture(123,5,new Map()).every(d=>d.length===0));
 assert.equal(remaining.get('X'),1);
});
test('omitting public counts preserves baseline decisions and endgame boundaries',()=>{
 const dictionary=['OX','CART','CARTER','REACT','TRACE','CARE','RACE','AT'];
 for(const letters of ['CARTE','OX','CARTER'])for(const bagRemaining of [0,1,5,20,60]){
  const ctx={dictionary,myRack:rack(letters),myBalance:100,bagRemaining};
  assert.equal(candidate.chooseWord(ctx),baseline.chooseWord(ctx));
  for(const letter of ['X','R','A'])assert.equal(candidate.decideBid({...ctx,letter}),baseline.decideBid({...ctx,letter}));
 }
 const ctx={dictionary:['OX'],myRack:rack('O'),myBalance:20,bagRemaining:1,letter:'X',remainingLetters:new Map<string,number>()};
 assert.equal(candidate.decideBid(ctx),20);
 assert.equal(candidate.decideBid({...ctx,bagRemaining:0}),0);
 assert.equal(candidate.chooseWord({...ctx,myRack:rack('OX'),bagRemaining:5}),'OX');
});

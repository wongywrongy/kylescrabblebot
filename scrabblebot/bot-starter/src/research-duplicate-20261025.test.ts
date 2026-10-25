import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as guarded from './research-duplicate-20261025.js';
import * as market from './strategy-market.js';
const rack=(text:string)=>{const r=new Map<string,number>();for(const c of text)r.set(c,(r.get(c)??0)+1);return r;};
test('third-copy guard blocks only further duplicates without immediate best-score gain',()=>{
 const ctx={dictionary:['LIE','EEL','LEE'],myRack:rack('IIEEE'),myBalance:100,bagRemaining:40,letter:'E'};
 assert.equal(guarded.decideBid(ctx),0);assert.equal(ctx.myRack.get('E'),3);
 const useful={...ctx,dictionary:['RENTED','REENTERED'],myRack:rack('RRNTDEEE')};
 assert.ok(market.wordScore(market.chooseWord({...useful,myRack:rack('RRNTDEEEE'),bagRemaining:0})!)>market.wordScore(market.chooseWord({...useful,bagRemaining:0})!));
 assert.equal(guarded.decideBid(useful),market.decideBid(useful));
 assert.equal(guarded.decideBid({...ctx,myRack:rack('IIEE')}),market.decideBid({...ctx,myRack:rack('IIEE')}));
 assert.equal(guarded.decideBid({...ctx,letter:'L'}),market.decideBid({...ctx,letter:'L'}));
});

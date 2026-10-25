import assert from 'node:assert/strict';
import {test} from 'node:test';
import {riskAdjustedScore} from './research-risk-20261025-market.js';
test('fixed downside objective discounts dispersion without changing constant outcomes or inputs',()=>{
 const scores=[0,40];assert.equal(riskAdjustedScore(scores),17);assert.equal(riskAdjustedScore([20,20]),20);assert.equal(riskAdjustedScore([10,30]),18.5);assert.equal(riskAdjustedScore([7]),7);assert.equal(riskAdjustedScore([40,0]),17);assert.deepEqual(scores,[0,40]);assert.throws(()=>riskAdjustedScore([]));assert.throws(()=>riskAdjustedScore([NaN]));
});

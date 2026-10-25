import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decideBid, premiumExperiment, wordScore } from './experiment-premium-threshold.js';
const rack=(s:string)=>new Map([...new Set(s)].map(c=>[c,[...s].filter(x=>x===c).length]));
test('the score threshold controls whether a two-letter seven-letter plan earns a premium',()=>{
 const ctx={myRack:rack('ADORA'),dictionary:['AWKWARD'],myBalance:100,bagRemaining:40,letter:'K'};
 // AWKWARD needs A,A,W,K,W,R,D; this rack intentionally misses three tiles.
 assert.equal(decideBid(ctx),19);
 const near={myRack:rack('BANES'),dictionary:['BANKERS'],myBalance:100,bagRemaining:40,letter:'K'};
 assert.equal(wordScore('BANKERS'),39);
 premiumExperiment.threshold=45;premiumExperiment.reserve=15;
 assert.equal(decideBid(near),19);
 premiumExperiment.threshold=39;
 assert.equal(decideBid(near),24);
 premiumExperiment.reserve=20;
 assert.equal(decideBid(near),19);
 premiumExperiment.threshold=45;premiumExperiment.reserve=15;
});

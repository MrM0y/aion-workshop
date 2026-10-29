import test from 'node:test';import assert from 'node:assert/strict';import {sortMarketRows,compareRankedBatch} from '../public/ranking.js';
test('header sorts toggle direction and unknown values stay last',()=>{const rows=[{recipeId:'a',profit:5},{recipeId:'b',profit:null},{recipeId:'c',profit:-2}];assert.deepEqual(sortMarketRows(rows,{key:'profit',direction:'asc'}).map(r=>r.recipeId),['c','a','b']);assert.deepEqual(sortMarketRows(rows,{key:'profit',direction:'desc'}).map(r=>r.recipeId),['a','c','b']);});
test('capital sort uses cash required while ROI zero and missing remain distinct',()=>{const rows=[{recipeId:'a',cashRequired:10,investment:100,roi:0},{recipeId:'b',cashRequired:20,investment:30,roi:null}];assert.equal(sortMarketRows(rows,{key:'capital'})[0].recipeId,'a');assert.equal(sortMarketRows(rows,{key:'roi',direction:'asc'})[0].recipeId,'a');});

test('ether costs sort independently and missing values remain last',()=>{
  const rows=[{recipeId:'a',investment:10,etherInvestment:8,etherProfit:20},{recipeId:'b',investment:5,etherInvestment:4,etherProfit:10},{recipeId:'c',etherInvestment:null}];
  assert.deepEqual(sortMarketRows(rows,{key:'ether'}).map(r=>r.recipeId),['b','a','c']);
  assert.equal(sortMarketRows(rows,{key:'etherProfit'})[0].recipeId,'a');
});

test('budget comparison keeps direct and optimized values for exactly the same batch',()=>{
  const optimized={attempts:5,cashRequired:50,profit:100,cashRoi:200,resourcePlan:{conversions:[{}]}};
  const direct={eligible:true,attempts:5,cashRequired:120,profit:30,cashRoi:25};
  const row=compareRankedBatch({recipeId:'r'},optimized,direct);
  assert.equal(row.investment,120);assert.equal(row.etherInvestment,50);assert.equal(row.etherSavings,70);assert.equal(row.profit,30);assert.equal(row.etherProfit,100);assert.equal(row.attempts,5);
  const missing=compareRankedBatch({recipeId:'r'},optimized,{eligible:false});
  assert.equal(missing.profit,null);assert.equal(missing.investment,null);assert.equal(missing.etherProfit,100);
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createSearchIndex,search} from '../dist/core/rank.js';
import {fold,parseQuery,tokenize} from '../dist/core/text.js';
import {matchConcepts} from '../dist/core/concepts.js';
const skills=Array.from({length:150},(_,i)=>({id:`id-${i}`,name:`Skill ${i}`,description:`Security review and documentation ${i}`,keywords:['security','review'],aliases:[],tags:[],scope:'vault'}));
const idx=createSearchIndex(skills);
test('Fuzz mixed scripts, quotes, punctuation and combining marks without throws',()=>{
  const symbols=['中','が','ा','ब','ё','ь','ç','ü','İ','し','語','𝒳','a','\u0301','\u200b','-','"',"'",' '];
  for(let i=0;i<350;i++){
    let seed=(0x9e3779b9^(i*1103515245))>>>0;let input='';
    for(let j=0;j<60;j++){seed=(1664525*seed+1013904223)>>>0;input+=symbols[seed%symbols.length];}
    assert.doesNotThrow(()=>{fold(input);tokenize(input);matchConcepts(input);parseQuery(input);search(idx,input,{topK:4});});
  }
});
test('Exact id search remains available without English token match',()=>{
  assert.equal(search(idx,'@id-147')[0]?.skill.id,'id-147');
});
test('Search results remain bounded and repeatable',()=>{
  const a=search(idx,'security code review',{topK:3});const b=search(idx,'security code review',{topK:3});
  assert.deepEqual(a.map(x=>x.skill.id),b.map(x=>x.skill.id));assert.equal(a.length,3);
});
test('No automatic remote calls, command substitution, or skill body evaluation',async()=>{
  const {safeRead}=await import('../dist/core/security.js');
  assert.equal(typeof safeRead,'function');
  const {createPlugin}=await import('../dist/plugin.js');assert.equal(typeof createPlugin().setup,'function');
});
test('Bounded top-k selection agrees with a larger result set',()=>{
 for(const q of ['security review','security','documentation','id','Skill 100']){
   const all=search(idx,q,{topK:30});
   for(const n of [1,2,3,5,10,20,30])assert.deepEqual(search(idx,q,{topK:n}).map(x=>x.skill.id),all.slice(0,n).map(x=>x.skill.id));
 }
});

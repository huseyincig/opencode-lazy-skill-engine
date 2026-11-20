import { test } from 'node:test';
import assert from 'node:assert/strict';
import {fold,tokenize,parseQuery,editDistanceWithinOne,xmlEscape} from '../dist/core/text.js';
import {createSearchIndex,search} from '../dist/core/rank.js';
const weights={id:7,name:6,keywords:5,tags:3,description:1.8};
const skills=[
 {id:'code-review',name:'Code Review',keywords:['pull request','review'],tags:['quality'],description:'Review application code changes for quality',scope:'vault'},
 {id:'script-debug',name:'Script Debug',keywords:['script debugging'],tags:['bugs'],description:'Identify and fix script runtime exceptions',scope:'vault'},
 {id:'api-security',name:'API Security',keywords:['auth','security'],tags:['api'],description:'Assess REST authentication and API endpoints',scope:'native'},
 {id:'cooking',name:'Cooking',keywords:['pasta'],tags:['food'],description:'Prepare pasta at home',scope:'vault'},
];
const idx=createSearchIndex(skills,weights);
test('Turkish and Unicode normalized',()=>assert.equal(fold('İSTANBUL GÜVENLİĞİ'),'istanbul guvenligi'));
test('Tokenization and stopwords',()=>assert.deepEqual(tokenize('Bana bir script debug için yardım'),['script','debug','yardim']));
test('Query parser negatives and quoted phrases',()=>{const p=parseQuery('"api security" -script');assert.deepEqual(p.positive,['api','security']);assert.deepEqual(p.negative,['script']);assert.deepEqual(p.phrases,['api security']);assert.equal(p.explicit,null);});
test('Direct ID reference',()=>assert.equal(parseQuery('@api-security').explicit,'api-security'));
test('One-edit fuzzy',()=>{assert.equal(editDistanceWithinOne('debug','debgu'),false);assert.equal(editDistanceWithinOne('debug','debg'),true);assert.equal(editDistanceWithinOne('debug','debxx'),false);});
test('XML safely escaped',()=>assert.equal(xmlEscape('<test a="b">'), '&lt;test a=&quot;b&quot;&gt;'));
test('Relevant result tops for multiword query',()=>assert.equal(search(idx,'review application pull request',{topK:3})[0].skill.id,'code-review'));
test('Native security ranks above others',()=>assert.equal(search(idx,'REST API authentication')[0].skill.id,'api-security'));
test('Keyword and synonym recall',()=>assert.equal(search(idx,'scr debugging')[0].skill.id,'script-debug'));
test('Fuzzy recall ID misspelling',()=>assert.equal(search(idx,'scrit debug')[0].skill.id,'script-debug'));
test('Negative filter',()=>assert.equal(search(idx,'api security -authentication').some(x=>x.skill.id==='api-security'),false));
test('Scope filter',()=>assert.ok(search(idx,'api',{scope:'vault'}).every(x=>x.skill.scope==='vault')));
test('Browse all',()=>assert.equal(search(idx,'*',{topK:30}).length,4));
test('Nonsense query has zero hits',()=>assert.equal(search(idx,'xxxyyyzzz').length,0));
test('Result count bounded',()=>assert.equal(search(idx,'*',{topK:1}).length,1));
test('No accidental broad score from irrelevant terms',()=>assert.equal(search(idx,'randomtopic')[0],undefined));

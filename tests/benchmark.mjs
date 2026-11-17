import { performance } from 'node:perf_hooks';
import {createSearchIndex,search} from '../src/core/rank.js';
const skills=Array.from({length:3000},(_,i)=>({
 id:`skill-${i}`,name:`Skill ${i} security review ${i%19===0?'performance test':'database docs'}`,
 description:`Review source code quality and security in application project ${i}. Use detailed checks, unit tests and documentation where appropriate.`,
 keywords:['code review','security','application'],aliases:[],tags:['quality'],scope:'vault'}));
const start=performance.now();const index=createSearchIndex(skills);const indexed=performance.now();
for(let i=0;i<20;i++)search(index,i%2?'Review application source code security':'代码安全审查',{topK:8});
const results=[];const t0=performance.now();for(let i=0;i<100;i++)results.push(search(index,['code review security','代码安全审查','script debug','Sicherheitsprüfung','安全 -数据库'][i%5],{topK:8}));
const t1=performance.now();
console.log(JSON.stringify({skills:skills.length,posts:index.postings.size,index_ms:+(indexed-start).toFixed(1),search_mean_ms:+((t1-t0)/100).toFixed(3),memory_rss_mib:+(process.memoryUsage().rss/2**20).toFixed(1),hits:results[0].length}));

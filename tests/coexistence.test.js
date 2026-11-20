import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configure } from '../dist/core/config.js';
import { createPlugin } from '../dist/plugin.js';
import { globMatch, skillPermissionDecision } from '../dist/core/host-policy.js';

const skills = [
 {id:'api-review',name:'API Review',description:'Review API authentication security vulnerabilities',autoinvoke:true},
 {id:'ui-design',name:'UI Design',description:'Design frontend UI components and layouts',autoinvoke:true},
];
function harness(root, options={}, agents=[]) {
 const tools=new Map(),hooks=new Map(),registrations=[];
 const native=structuredClone(skills);
 const ctx={
  options:{hints:'off',refreshMs:0,roots:[root],...options},location:{directory:root,project:{canonical:root}},
  skill:{list:async()=>({data:native}),transform:async fn=>{registrations.push('skill');fn({list:()=>native,update:(id,fn)=>{const item=native.find(s=>s.id===id);if(item)fn(item)}});return{dispose:async()=>{}}}},
  tool:{transform:async fn=>{registrations.push('tool');fn({namespace:()=>{},add:x=>tools.set('lazy_skill_'+x.name,x)});return{dispose:async()=>{}}}},
  session:{get:async()=>({data:{agent:'worker-a',parentID:'root'}}),hook:async(name,fn)=>{hooks.set(name,fn);return{dispose:async()=>{}}}},
  agent:{list:async()=>({data:agents})},
 };
 return{ctx,tools,hooks,native,registrations};
}
async function withHarness(fn,options={},agents=[]) {
 const root=await mkdtemp(join(tmpdir(),'lazy-coexist-'));
 try{const env=harness(root,options,agents);const dispose=await createPlugin().setup(env.ctx);try{await fn(env)}finally{await dispose()}}finally{await rm(root,{recursive:true,force:true})}
}
async function prompt(env,text,{attached=[],metadata=undefined}={}) {
 const ev={sessionID:'child',prompt:{text,...(attached.length?{skills:structuredClone(attached)}:{})},...(metadata?{metadata}:{})};
 await env.hooks.get('prompt')(ev);return ev;
}

test('defaults preserve existing skill declarations and retain generic install paths',async()=>{
 const o=configure({},{});assert.equal(o.nativeCatalog,'preserve');assert.equal(o.coexistence,'respect');assert.equal(o.respectHostPermissions,true);
 await withHarness(async env=>{assert.equal(env.registrations.includes('skill'),false);assert.equal(env.native.every(s=>s.autoinvoke===true),true)});
 const example=readFileSync(new URL('../examples/opencode.jsonc',import.meta.url),'utf8');
 assert.doesNotMatch(example,/opencode-lazy-skill-engine-v\d/i);
 const manifest=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'));
 assert.doesNotMatch(manifest.peerDependencies['@opencode/plugin'],/\d+\.\d+\.\d+/);
});

test('conservative glob matching respects ordered allow/deny/ask host rules',()=>{
 assert.equal(globMatch('skill','skill'),true);
 assert.equal(globMatch('skill*','skill:execute'),true);
 assert.equal(globMatch('code-??','code-ab'),true);
 assert.equal(globMatch('code-*','file-review'),false);
 const rules=[{action:'*',resource:'*',effect:'allow'},{action:'skill',resource:'*',effect:'deny'},{action:'skill',resource:'api-*',effect:'allow'},{action:'skill',resource:'api-secret',effect:'ask'}];
 assert.equal(skillPermissionDecision(rules,'api-review'),'allow');
 assert.equal(skillPermissionDecision(rules,'ui-design'),'deny');
 assert.equal(skillPermissionDecision(rules,'api-secret'),'ask');
 assert.equal(skillPermissionDecision([],'api-review'),'unknown');
});

test('host agent skill permissions narrow worker auto-selection',async()=>{
 const rules=[{action:'*',resource:'*',effect:'allow'},{action:'skill',resource:'*',effect:'deny'},{action:'skill',resource:'api-review',effect:'allow'}];
 await withHarness(async env=>{
  const denied=await prompt(env,'Design frontend UI components and layouts');assert.equal(denied.prompt.skills,undefined);
  const yes=await prompt(env,'Review API authentication security vulnerabilities');assert.deepEqual(yes.prompt.skills?.map(s=>s.id),['api-review']);
 },{},[{id:'worker-a',name:'Worker',mode:'subagent',permissions:rules}]);
});

test('user or orchestrator supplied skill attachments take precedence over auto-binding',async()=>{
 await withHarness(async env=>{
  const extra={id:'ui-design',mention:{start:2,end:3,text:'@ui-design'}};
  const ev=await prompt(env,'Review API authentication security vulnerabilities',{attached:[extra]});
  assert.deepEqual(ev.prompt.skills,[extra]);
  const required=await prompt(env,'Review API authentication security vulnerabilities',{attached:[extra],metadata:{lazySkill:{requiredSkills:['api-review']}}});
  assert.deepEqual(required.prompt.skills,[extra,{id:'api-review'}]);
 },{},[{id:'worker-a',mode:'subagent',permissions:[{action:'skill',resource:'*',effect:'allow'}]}]);
});

test('disallowed required skill fails atomically and does not alter host attachments',async()=>{
 const rules=[{action:'skill',resource:'*',effect:'deny'}];
 await withHarness(async env=>{
  const original={id:'preexisting-skill'};
  const e={sessionID:'child',prompt:{text:'Review API authentication security vulnerabilities',skills:[original]},metadata:{lazySkill:{requiredSkills:['api-review']}}};
  await assert.rejects(env.hooks.get('prompt')(e),/permission|denied|not permitted/i);
  assert.deepEqual(e.prompt.skills,[original]);assert.equal(e.prompt.text,'Review API authentication security vulnerabilities');
 },{},[{id:'worker-a',name:'Worker',mode:'subagent',permissions:rules}]);
});

test('unknown/unsupported permission rule effect cannot be treated as permission grant',()=>{
 assert.notEqual(skillPermissionDecision([{action:'skill',resource:'*',effect:'unknown'}],'api-review'),'allow');
});

test('primary session recognizes an orchestrated host from generic role permissions without naming a plugin',async()=>{
 const roster=[
  {id:'coordinator',mode:'primary',permissions:[{action:'*',resource:'*',effect:'allow'}]},
  {id:'worker-a',mode:'subagent',permissions:[{action:'skill',resource:'*',effect:'deny'},{action:'skill',resource:'api-review',effect:'allow'}]}
 ];
 await withHarness(async env=>{
  env.ctx.session.get=async()=>({data:{agent:'coordinator'}});
  const e=await prompt(env,'Review API authentication security vulnerabilities');
  assert.equal(e.prompt.skills,undefined);
 },{},roster);
});

test('missing role in an available host roster never broadens automatic worker permission',async()=>{
 await withHarness(async env=>{
  const e=await prompt(env,'Review API authentication security vulnerabilities');
  assert.equal(e.prompt.skills,undefined);
 },{},[{id:'some-other-agent',mode:'subagent',permissions:[{action:'skill',resource:'*',effect:'allow'}]}]);
});

test('respectHostPermissions=false is an explicit recovery option, not the default',async()=>{
 await withHarness(async env=>{
  const e=await prompt(env,'Review API authentication security vulnerabilities');
  assert.deepEqual(e.prompt.skills?.map(x=>x.id),['api-review']);
 },{respectHostPermissions:false},[{id:'worker-a',permissions:[{action:'skill',resource:'*',effect:'deny'}]}]);
});

test('opt-in augment keeps the legacy add-to-existing-skills behavior',async()=>{
 await withHarness(async env=>{
  const e=await prompt(env,'Review API authentication security vulnerabilities',{attached:[{id:'ui-design'}]});
  assert.deepEqual(e.prompt.skills?.map(x=>x.id),['ui-design','api-review']);
 },{coexistence:'augment',respectHostPermissions:false});
});

test('oversized host rule set cannot hide a trailing deny behind an early allow',()=>{
 const rules=Array.from({length:2048},()=>({action:'skill',resource:'*',effect:'allow'}));
 rules.push({action:'skill',resource:'api-review',effect:'deny'});
 assert.notEqual(skillPermissionDecision(rules,'api-review'),'allow');
});

test('do not reject or override an already host-attached required skill',async()=>{
 const denied=[{id:'worker-a',mode:'subagent',permissions:[{action:'skill',resource:'*',effect:'deny'}]}];
 await withHarness(async env=>{
  const existing={id:'api-review'};
  const ev=await prompt(env,'Review API authentication security vulnerabilities',{
   attached:[existing],metadata:{lazySkill:{requiredSkills:['api-review']}}
  });
  assert.deepEqual(ev.prompt.skills,[existing]);
 },{},denied);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPlugin } from '../dist/plugin.js';
import { configure } from '../dist/core/config.js';
import { parseFrontmatter, normalizeEntry } from '../dist/core/scanner.js';
import { selectBindings, extractExplicit, automaticCandidates } from '../dist/core/selection.js';
import { parseSemanticIDs, SemanticRouter } from '../dist/core/semantic.js';
import { Catalog } from '../dist/core/catalog.js';

const skill=(id,description='Safe code review',origin='global',extra={})=>({id,name:id,description,keywords:[],aliases:[],tags:[],triggers:[],negativeTriggers:[],roles:[],scope:'native',origin,...extra});

function fakeHost(base,options={},native=[]){
 const tools=new Map(),hooks=new Map(),mutations=[],registrations=[];
 const sessions=new Map();
 const ctx={options:{roots:[base],refreshMs:1800000,hints:'off',...options},location:{project:{canonical:base},directory:base},
 skill:{list:async()=>({data:native}),transform:async f=>{f({list:()=>native,update:(id,cb)=>{const s=native.find(s=>s.id===id);if(s){cb(s);mutations.push(s);}}});const r={dispose:async()=>{r.disposed=true;}};registrations.push(r);return r;}},
 tool:{transform:async f=>{f({namespace:()=>{},add:x=>tools.set('lazy_skill_'+x.name,x)});const r={dispose:async()=>{r.disposed=true;}};registrations.push(r);return r;}},
 session:{hook:async (name,f)=>{hooks.set(name,f);const r={dispose:async()=>{r.disposed=true;}};registrations.push(r);return r;},get:async({sessionID})=>({data:sessions.get(sessionID)??{agent:'worker-a',parentID:'parent-1'}})}
 };
 return {ctx,tools,hooks,sessions,mutations,registrations};
}

const normal={allowed:['review','security'],default:['review'],maxActive:2};
test('Pinned requirement wins even above auto max, and missing required fails closed',()=>{
 const available=[skill('review'),skill('security'),skill('doc')];
 const r=selectBindings({available,promptText:'skill:security',requiredSkills:['review','doc'],roleName:'worker-a',role:normal,autoBind:'workers',isWorker:true,ranked:[]});
 assert.deepEqual(r.ids,['review','doc','security']);assert.equal(r.source,'task');
 const missing=selectBindings({available,promptText:'skill:security',requiredSkills:['missing'],roleName:'worker-a',role:normal,autoBind:'off',ranked:[]});
 assert.deepEqual(missing.missingRequired,['missing']); assert.deepEqual(missing.ids,[]);
});

test('Explicit bypasses role lists and auto disabled; missing explicit only a warning',()=>{
 const available=[skill('review'),skill('security')];
 assert.deepEqual(extractExplicit('Please use skill:security then skill:security'),['security']);
 let r=selectBindings({available,promptText:'skill:security',autoBind:'off',ranked:[]});assert.deepEqual(r.ids,['security']);
 r=selectBindings({available,promptText:'skill:missing',requiredSkills:['review'],autoBind:'off',ranked:[]});
 assert.deepEqual(r.ids,['review']);assert.deepEqual(r.missingExplicit,['missing']);
});

test('Automatic selection respects off/workers/all and role allowlist',()=>{
 const available=[skill('review'),skill('security'),skill('other')];
 const ranked=[{skill:available[2],score:500,coverage:1},{skill:available[1],score:15,coverage:1}];
 const input={available,promptText:'security',roleName:'worker-a',role:{allowed:['review','security'],default:['review'],maxActive:1},ranked,minScore:1};
 assert.deepEqual(selectBindings({...input,autoBind:'off',isWorker:true}).ids,[]);
 assert.deepEqual(selectBindings({...input,autoBind:'workers',isWorker:false}).ids,[]);
 const r=selectBindings({...input,autoBind:'workers',isWorker:true});assert.deepEqual(r.ids,['security']);
});

test('Project roles gate extra project skills; role-declared allowed always possible',()=>{
 const available=[skill('review'),skill('proj','Implement checkout','project',{roles:['worker-a']}),skill('no-roles','Implement checkout','project'),skill('wrong-role','Implement checkout','project',{roles:['worker-b']})];
 let c=automaticCandidates({available,roleName:'worker-a',role:{allowed:['review'],maxActive:2},projectAutoBind:true});
 assert.deepEqual([...c],['review','proj']);
 c=automaticCandidates({available,roleName:'worker-a',role:{allowed:['review','no-roles']},projectAutoBind:false});
 assert.deepEqual([...c],['review','no-roles']);
});

test('Role defaults apply when lexical below threshold',()=>{
 const available=[skill('review'),skill('security')];
 const out=selectBindings({available,promptText:'unmatched task',roleName:'worker-a',role:normal,autoBind:'all',isWorker:false,ranked:[],minScore:5});
 assert.equal(out.source,'default');assert.deepEqual(out.ids,['review']);
});

test('Negative triggers deny automatic but never explicit skills',()=>{
 const available=[skill('deploy','Deployment', 'global',{negativeTriggers:['do not deploy']})];
 const q='do not deploy';const ranked=[{skill:available[0],score:99,coverage:1}];
 const args={available,roleName:'worker-a',role:{allowed:['deploy'],maxActive:1},promptText:q,autoBind:'all',ranked};
 assert.deepEqual(selectBindings(args).ids,[]);
 assert.deepEqual(selectBindings({...args,promptText:q+' skill:deploy'}).ids,['deploy']);
});

test('Extended metadata: aliases/triggers/negativeTriggers/languages/roles are normalized',()=>{
 const x=parseFrontmatter('---\nname: Review\ndescription: Code review\ntriggers: [code audit, security]\nnegativeTriggers: [not now]\nroles: [worker-a, worker-b]\nlanguages: [tr, en]\n---\nBODY');
 const ent=normalizeEntry(x.meta,'/tmp/my-skill/SKILL.md','/tmp',1,configure({}, {directory:'/tmp'}));
 assert.deepEqual(ent.triggers,['code audit','security']);assert.deepEqual(ent.negativeTriggers,['not now']);assert.deepEqual(ent.roles,['worker-a','worker-b']);assert.deepEqual(ent.languages,['tr','en']);assert.equal(ent.origin,'project');
});

test('Semantic output must be strict JSON and constrained to candidates',()=>{
 const allowed=new Set(['review','security']);
 assert.deepEqual(parseSemanticIDs('{"skills":["security","security","evil",4]}',allowed,2),['security']);
 assert.deepEqual(parseSemanticIDs('Sure: {"skills":["security"]}',allowed,2),[]);
 assert.deepEqual(parseSemanticIDs('["review"]',allowed,2),[]);
});

test('Semantic failure, timeout and cache are bounded and nonblocking',async()=>{
 let calls=0;
 const router=new SemanticRouter({enabled:true,timeoutMs:100,maxCandidates:5},async()=>{calls++;return {text:'{"skills":["security","bad"]}'};});
 const args={promptText:'nonmatching query',candidates:[skill('security')],maxActive:2,model:{providerID:'p',id:'m'}};
 assert.deepEqual(await router.select(args),['security']);assert.deepEqual(await router.select(args),['security']);assert.equal(calls,1);
 const broken=new SemanticRouter({enabled:true,timeoutMs:50,maxCandidates:5},async()=>{throw new Error('provider unavailable');});
 assert.deepEqual(await broken.select(args),[]);
});

test('V2 prompt skill attachments preserve existing native ones; auto mode chooses role-limited native skill',async()=>{
 const root=await mkdtemp(join(tmpdir(),'lazy-v2-coop-'));try{
 const m=fakeHost(root,{coexistence:'augment',autoBind:'workers',roles:{'worker-a':{allowed:['native-security'],maxActive:1}}},[{id:'native-security',name:'Security',description:'Security review of source code',autoinvoke:true}]);
 const cleanup=await createPlugin().setup(m.ctx);
 const event={sessionID:'child',prompt:{text:'Review source code security',skills:[{id:'already-selected'}]}};
 await m.hooks.get('prompt')(event);
 assert.deepEqual(event.prompt.skills.map(x=>x.id),['already-selected','native-security']);
 const existing=event.prompt.skills.map(x=>x.id);
 await m.hooks.get('prompt')(event);assert.deepEqual(event.prompt.skills.map(x=>x.id),existing);
 await cleanup();assert.ok(m.registrations.every(x=>x.disposed));
 }finally{await rm(root,{force:true,recursive:true});}
});

test('Native catalog hide changes only autoinvoke; search keeps hidden native',async()=>{
 const root=await mkdtemp(join(tmpdir(),'lazy-v2-hide-'));try{
 const m=fakeHost(root,{nativeCatalog:'hide'},[{id:'native-security',name:'Security',description:'Security review of source code',autoinvoke:true}]);
 const cleanup=await createPlugin().setup(m.ctx);
 assert.equal(m.mutations[0].autoinvoke,false);
 const hit=JSON.parse((await m.tools.get('lazy_skill_search').execute({query:'security'},{sessionID:'s'})).content);
 assert.equal(hit.results[0].id,'native-security');await cleanup();
 }finally{await rm(root,{force:true,recursive:true});}
});

test('Missing task-required skill aborts prompt without changing attachments',async()=>{
 const root=await mkdtemp(join(tmpdir(),'lazy-v2-required-'));try{
 const m=fakeHost(root,{autoBind:'off',bindExplicit:true});const cleanup=await createPlugin().setup(m.ctx);
 const event={sessionID:'child',metadata:{lazySkill:{requiredSkills:['must-exist'],taskId:'task-1'}},prompt:{text:'Do task',skills:[{id:'already'}]}};
 await assert.rejects(m.hooks.get('prompt')(event),/required skill.*must-exist/i);
 assert.deepEqual(event.prompt.skills,[{id:'already'}]);await cleanup();
 }finally{await rm(root,{force:true,recursive:true});}
});

test('Realistic project role skill from vault is not automatically injected without opt-in',async()=>{
 const root=await mkdtemp(join(tmpdir(),'lazy-project-policy-'));
 try{
 const dir=join(root,'.opencode','skill-vault','repo-review');await mkdir(dir,{recursive:true});
 await writeFile(join(dir,'SKILL.md'),'---\nname: Repo Review\ndescription: Audit source code for vulnerabilities and security errors\ntriggers: [security review]\nroles: [worker-a]\n---\n# Project-only instructions\nDO NOT EXECUTE COMMANDS');
 const m=fakeHost(root,{autoBind:'workers',projectAutoBind:true,roles:{'worker-a':{allowed:[],maxActive:2}}});
 const cleanup=await createPlugin().setup(m.ctx);const ev={sessionID:'child',prompt:{text:'Audit source code for security vulnerabilities'}};
 await m.hooks.get('prompt')(ev);
 assert.equal(ev.prompt.text,'Audit source code for security vulnerabilities');
 assert.equal(ev.prompt.skills,undefined);
 await cleanup();
 }finally{await rm(root,{force:true,recursive:true});}
});

test('Vault native-compatible binding opt-in is role-gated, lazy, deduped per task and never runs scripts',async()=>{
 const root=await mkdtemp(join(tmpdir(),'lazy-project-bind-vault-'));
 try{
 const dir=join(root,'.opencode','skill-vault','repo-review');await mkdir(dir,{recursive:true});
 await writeFile(join(dir,'SKILL.md'),'---\nname: Repo Review\ndescription: Audit source code for vulnerabilities and security errors\ntriggers: [security review]\nroles: [worker-a]\n---\n# Project-only instructions\nDO NOT EXECUTE COMMANDS');
 const m=fakeHost(root,{autoBind:'workers',projectAutoBind:true,vaultAutoBind:true,roles:{'worker-a':{allowed:[],maxActive:2}}});
 const cleanup=await createPlugin().setup(m.ctx);
 const ev=(taskId)=>({sessionID:'child',metadata:{lazySkill:{taskId}},prompt:{text:'Audit source code for security vulnerabilities'}});
 const a=ev('task-1');await m.hooks.get('prompt')(a);assert.match(a.prompt.text,/<lazy_bound_skill/);assert.match(a.prompt.text,/# Project-only instructions/);
 const b=ev('task-1');await m.hooks.get('prompt')(b);assert.doesNotMatch(b.prompt.text,/<lazy_bound_skill/);
 const c=ev('task-2');await m.hooks.get('prompt')(c);assert.match(c.prompt.text,/<lazy_bound_skill/);
 const status=JSON.parse((await m.tools.get('lazy_skill_status').execute({},{sessionID:'child'})).content);
 assert.deepEqual(status.receipt.ids,['repo-review']);
 assert.equal(JSON.stringify(status.receipt).includes('DO NOT EXECUTE'),false);
 await cleanup();
 }finally{await rm(root,{force:true,recursive:true});}
});

test('A required vault skill is blocked atomically if vaultAutoBind is disabled',async()=>{
 const root=await mkdtemp(join(tmpdir(),'lazy-hi-required-vault-'));
 try{
 const dir=join(root,'.opencode','skill-vault','must-skill');await mkdir(dir,{recursive:true});
 await writeFile(join(dir,'SKILL.md'),'---\ndescription: Required skill\n---\nbody');
 const m=fakeHost(root,{bindExplicit:true},[{id:'native',name:'Native',description:'Native skill'}]);
 const cleanup=await createPlugin().setup(m.ctx);
 const ev={sessionID:'child',metadata:{lazySkill:{requiredSkills:['must-skill','native']}},prompt:{text:'Task',skills:[]}};
 await assert.rejects(m.hooks.get('prompt')(ev),/Required vault skill/);
 assert.deepEqual(ev.prompt.skills,[]);assert.equal(ev.prompt.text,'Task');
 await cleanup();
 }finally{await rm(root,{force:true,recursive:true});}
});

test('Semantic fallback via host generator can fill role defaults but never unauthorized ids',async()=>{
 const root=await mkdtemp(join(tmpdir(),'lazy-hi-semantic-'));
 try{
 let calls=0;
 const native=[
  {id:'native-security',name:'Security Review',description:'Audit authentication and vulnerabilities'},
  {id:'native-doc',name:'Documentation',description:'Write clear documentation'},
  {id:'evil',name:'Other',description:'General purpose'}
 ];
 const m=fakeHost(root,{coexistence:'augment',autoBind:'workers',roles:{'worker-a':{allowed:['native-doc','native-security'],default:['native-doc'],maxActive:2}},semantic:{enabled:true,model:'test/multilingual',timeoutMs:200,maxCandidates:20}},native);
 m.ctx.experimental={generate:{text:async()=>{calls++;return {text:'{"skills":["evil","native-security","native-security"]}'}}}};
 const cleanup=await createPlugin().setup(m.ctx);
 const event={sessionID:'child',metadata:{lazySkill:{taskId:'task-a'}},prompt:{text:'🎵 irrelevant non-engineering phrasing'}};
 await m.hooks.get('prompt')(event);
 assert.equal(calls,1);
 assert.deepEqual(event.prompt.skills.map(x=>x.id),['native-doc','native-security']);
 const repeated={sessionID:'child',metadata:{lazySkill:{taskId:'task-a'}},prompt:{text:'🎵 irrelevant non-engineering phrasing'}};
 await m.hooks.get('prompt')(repeated);assert.equal(calls,1);
 await cleanup();
 }finally{await rm(root,{force:true,recursive:true});}
});

test('Role-less parent does not auto-bind in workers mode',async()=>{
 const root=await mkdtemp(join(tmpdir(),'lazy-hi-parent-'));
 try{
 const m=fakeHost(root,{coexistence:'augment',autoBind:'workers',roles:{'worker-a':{allowed:['native-security'],maxActive:1}}},[{id:'native-security',name:'Security',description:'security review'}]);
 m.sessions.set('parent',{agent:'worker-a'});
 const cleanup=await createPlugin().setup(m.ctx);
 const ev={sessionID:'parent',prompt:{text:'security review'}};
 await m.hooks.get('prompt')(ev);assert.equal(ev.prompt.skills,undefined);
 await cleanup();
 }finally{await rm(root,{force:true,recursive:true});}
});

test('Exact and AND matches outrank partial candidates even with large prefix overlap',async()=>{
 const {search,createSearchIndex}=await import('../dist/core/rank.js');
 const docs=[skill('both','migration audit'),...Array.from({length:100},(_,i)=>skill(`migration-${i}`,'migration migration migration migration migration'))];
 const index=createSearchIndex(docs);
 const r=search(index,'migration audit',{topK:1});assert.equal(r[0].skill.id,'both');
 const p=search(index,'migration unable-to-find',{topK:1});assert.ok(p.length>0);
});

test('Config rejects invalid role ids and caps semantic and role limits',()=>{
 const opts=configure({roles:{'worker-a':{allowed:['safe-id','../unsafe','safe-id'],default:['safe-id'],maxActive:999},'BAD ROLE':{allowed:['x']}},semantic:{enabled:true,timeoutMs:999999,maxCandidates:999},autoBind:'all'},{});
 assert.deepEqual(opts.roles['worker-a'].allowed,['safe-id']);assert.equal(opts.roles['worker-a'].maxActive,8);
 assert.equal(opts.semantic.timeoutMs,5000);assert.equal(opts.semantic.maxCandidates,120);
 assert.equal(Object.hasOwn(opts.roles,'BAD ROLE'),false);
});

test('Search defaults to short metadata, can request IDs only and detailed fields separately',async()=>{
 const root=await mkdtemp(join(tmpdir(),'lazy-hi-compact-'));
 try{
 const m=fakeHost(root,{},[{id:'long-skill',name:'Detailed',description:'A'.repeat(600)+' security audit skill'}]);
 const cleanup=await createPlugin().setup(m.ctx);
 const find=m.tools.get('lazy_skill_search');
 const short=JSON.parse((await find.execute({query:'security audit'},{sessionID:'s'})).content);
 assert.equal(short.detail,'summary');assert.ok(short.results[0].description.length<=140);
 const ids=JSON.parse((await find.execute({query:'security',detail:'ids'},{sessionID:'s'})).content);
 assert.equal(ids.detail,'ids');assert.equal(Object.hasOwn(ids.results[0],'description'),false);
 const full=JSON.parse((await find.execute({query:'security',detail:'full'},{sessionID:'s'})).content);
 assert.ok(full.results[0].description.length>140);
 await cleanup();
 }finally{await rm(root,{force:true,recursive:true});}
});

test('Required native IDs attach with explicit binding enabled even when automatic policy is off',async()=>{
 const root=await mkdtemp(join(tmpdir(),'lazy-hi-native-required-'));
 try{
 const m=fakeHost(root,{bindExplicit:true,autoBind:'off'},[{id:'native-doc',name:'Doc',description:'Documentation'}]);
 const cleanup=await createPlugin().setup(m.ctx);
 const ev={sessionID:'parent',metadata:{lazySkill:{requiredSkills:['native-doc']}},prompt:{text:'Please document project'}};
 await m.hooks.get('prompt')(ev);
 assert.deepEqual(ev.prompt.skills,[{id:'native-doc'}]);
 await cleanup();
 }finally{await rm(root,{force:true,recursive:true});}
});

test('No model provider call when semantic is disabled or no approved role exists',async()=>{
 const root=await mkdtemp(join(tmpdir(),'lazy-hi-no-model-'));
 try{
 let count=0;
 const m=fakeHost(root,{autoBind:'all',roles:{'worker-a':{allowed:[]}},semantic:{enabled:false,model:'a/b'}},[{id:'n',name:'Native',description:'Native skill'}]);
 m.ctx.experimental={generate:{text:async()=>{count++;return {text:'{"skills":["n"]}'}}}};
 const cleanup=await createPlugin().setup(m.ctx);
 await m.hooks.get('prompt')({sessionID:'child',prompt:{text:'irrelevant'}});
 assert.equal(count,0);await cleanup();
 }finally{await rm(root,{force:true,recursive:true});}
});

test('Required skill fails closed if live native catalog cannot be refreshed',async()=>{
 const root=await mkdtemp(join(tmpdir(),'lazy-hi-required-availability-'));
 try{
 const m=fakeHost(root,{bindExplicit:true},[{id:'native-doc',name:'Documentation',description:'Docs'}]);
 const cleanup=await createPlugin().setup(m.ctx);
 m.ctx.skill.list=async()=>{throw new Error('down');};
 const ev={sessionID:'s',metadata:{lazySkill:{requiredSkills:['native-doc']}},prompt:{text:'Document'}};
 await assert.rejects(m.hooks.get('prompt')(ev),/catalog is unavailable/);
 assert.equal(ev.prompt.skills,undefined);await cleanup();
 }finally{await rm(root,{force:true,recursive:true});}
});

test('A negative trigger bars semantic fallback too, despite model suggesting that skill',async()=>{
 const root=await mkdtemp(join(tmpdir(),'lazy-hi-negative-sem-'));
 try{
 let calls=0;
 const native=[{id:'deploy',name:'Deployment',description:'Deploy to production',negativeTriggers:['do not deploy']},{id:'document',name:'Docs',description:'Write documentation'}];
 const m=fakeHost(root,{coexistence:'augment',autoBind:'workers',roles:{'worker-a':{allowed:['deploy','document'],maxActive:2}},semantic:{enabled:true,model:'test/model',timeoutMs:200}},native);
 m.ctx.experimental={generate:{text:async()=>{calls++;return{text:'{"skills":["deploy"]}'}}}};
 const cleanup=await createPlugin().setup(m.ctx);
 const e={sessionID:'s',prompt:{text:'do not deploy - unclassified task'}};
 await m.hooks.get('prompt')(e);
 assert.ok(calls<=1);assert.equal(e.prompt.skills?.some(x=>x.id==='deploy')??false,false);
 await cleanup();
 }finally{await rm(root,{force:true,recursive:true});}
});

test('Incremental metadata cache reuses unchanged frontmatter and invalidates after content edit',async()=>{
 const root=await mkdtemp(join(tmpdir(),'lazy-hi-incremental-'));
 try{
 const dir=join(root,'.opencode','skill-vault','cached-skill');await mkdir(dir,{recursive:true});
 const fp=join(dir,'SKILL.md');
 await writeFile(fp,'---\ndescription: First revision\n---\n# full content never indexed');
 const m=fakeHost(root,{refreshMs:0});const cleanup=await createPlugin().setup(m.ctx);
 await m.tools.get('lazy_skill_status').execute({refresh:false},{sessionID:'s'});
 const status=async()=>JSON.parse((await m.tools.get('lazy_skill_status').execute({refresh:false},{sessionID:'s'})).content);
 let st=await status();assert.equal(st.metadataCache.metadataReads,0);assert.equal(st.metadataCache.metadataReuses,1);
 await writeFile(fp,'---\ndescription: Second revision longer\n---\n# full content never indexed');
 st=await status();assert.equal(st.metadataCache.metadataReads,1);
 const info=JSON.parse((await m.tools.get('lazy_skill_info').execute({id:'cached-skill'},{sessionID:'s'})).content);
 assert.equal(info.description,'Second revision longer');await cleanup();
 }finally{await rm(root,{force:true,recursive:true});}
});

test('Deleted skill is evicted from metadata cache and search on subsequent refresh',async()=>{
 const root=await mkdtemp(join(tmpdir(),'lazy-hi-eviction-'));
 try{
 const dir=join(root,'.opencode','skill-vault','evicted');await mkdir(dir,{recursive:true});
 await writeFile(join(dir,'SKILL.md'),'---\ndescription: Evict this metadata on deletion\n---\nbody');
 const m=fakeHost(root,{refreshMs:0});const cleanup=await createPlugin().setup(m.ctx);
 await rm(dir,{recursive:true,force:true});
 const result=JSON.parse((await m.tools.get('lazy_skill_info').execute({id:'evicted'},{sessionID:'s'})).content);
 assert.equal(result.error,'Skill not found');await cleanup();
 }finally{await rm(root,{force:true,recursive:true});}
});

test('Auto-binding prefers attachable native skill when a higher-scored vault skill is disabled',async()=>{
 const root=await mkdtemp(join(tmpdir(),'lazy-hi-attachable-'));
 try{
 const dir=join(root,'.opencode','skill-vault','vault-review');await mkdir(dir,{recursive:true});
 await writeFile(join(dir,'SKILL.md'),'---\ndescription: Audit code security vulnerabilities and authentication\ntriggers: [security review]\nroles: [worker-a]\n---\nbody');
 const native=[{id:'native-review',name:'Native Security Review',description:'Review code security'}];
 const m=fakeHost(root,{autoBind:'workers',projectAutoBind:true,vaultAutoBind:false,roles:{'worker-a':{allowed:['native-review'],maxActive:1}}},native);
 const cleanup=await createPlugin().setup(m.ctx);
 const ev={sessionID:'child',prompt:{text:'Review code security vulnerabilities and authentication'}};
 await m.hooks.get('prompt')(ev);
 assert.deepEqual(ev.prompt.skills,[{id:'native-review'}]);
 await cleanup();
 }finally{await rm(root,{force:true,recursive:true});}
});

test('Malformed required skill identifiers are rejected, never silently dropped',async()=>{
 const root=await mkdtemp(join(tmpdir(),'lazy-hi-invalid-required-'));
 try{
 const m=fakeHost(root,{bindExplicit:true});const cleanup=await createPlugin().setup(m.ctx);
 for(const requiredSkills of [['../hidden'],['OK_CAPS'],['safe',null],'not-an-array']){
   const event={sessionID:'x',metadata:{lazySkill:{requiredSkills}},prompt:{text:'Do work'}};
   await assert.rejects(m.hooks.get('prompt')(event),/Invalid requiredSkills metadata/);
   assert.equal(event.prompt.skills,undefined);
 }
 await cleanup();
 }finally{await rm(root,{force:true,recursive:true});}
});

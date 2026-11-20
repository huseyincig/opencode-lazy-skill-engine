import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPlugin} from '../dist/plugin.js';
import {SessionLedger} from '../dist/core/session.js';
import {renderHints,selectHints} from '../dist/core/hint.js';
import {configure} from '../dist/core/config.js';
function mock(root,opts={}){
 const tools=new Map(),hooks=new Map(),mutations=[];let disposals=0;
 const ctx={options:{roots:[root],refreshMs:0,...opts},location:{directory:root,project:{canonical:root}},
 skill:{list:async()=>({location:{directory:root},data:[{id:'native-security',name:'Security',description:'Review API authentication',autoinvoke:true,path:'/tmp/skill'}]}),transform:async cb=>{cb({list:()=>[{id:'native-security'}],update:(id,fn)=>{const x={description:'Review API authentication'};fn(x);mutations.push(x);}});return{dispose:async()=>disposals++};}},
 tool:{transform:async cb=>{cb({namespace:()=>{},add:def=>tools.set(`lazy_skill_${def.name}`,def)});return{dispose:async()=>disposals++};}},
 session:{hook:async(name,cb)=>{hooks.set(name,cb);return{dispose:async()=>disposals++};}}};
 return {ctx,tools,hooks,mutations,disposeCount:()=>disposals};
}
const fake=(sessionID='sess-1',agent='worker-a')=>({sessionID,agent,signal:new AbortController().signal});
async function setupFile(){const base=await mkdtemp(join(tmpdir(),'lazy-plugin-test-'));const skill=join(base,'project-review');await mkdir(join(skill,'references'),{recursive:true});await writeFile(join(skill,'SKILL.md'),'---\nname: Project Review\ndescription: Review pull requests, assess code quality and identify defects\nkeywords: [review, quality]\n---\n# Review\nRead references/checklist.md');await writeFile(join(skill,'references','checklist.md'),'1. Check inputs\n2. Write tests');return base;}
test('Package plugin identifier matches the canonical package name',()=>{assert.equal(createPlugin().id,'opencode-lazy-skill-engine');});
test('Metadata hint is small, escaped and not full-body',()=>{const opts=configure({hints:'hint'},{});const ledger=new SessionLedger(opts);const hits=[{score:30,coverage:1,skill:{id:'x',scope:'vault',autoinvoke:false,description:'<inject>'}}];const selected=selectHints('find skill to assess quality code review',hits,opts,ledger,'a');assert.equal(selected.length,1);assert.equal(renderHints(selected).includes('&lt;inject&gt;'),true);assert.equal(renderHints(selected).includes('<inject>'),false);});
test('Hint threshold prevents meaningless messages',()=>{const opts=configure({},{});const hits=[{score:20,coverage:1,skill:{id:'foo',scope:'vault',description:'foo'}}];const ledger=new SessionLedger(opts);assert.equal(selectHints('hello',hits,opts,ledger,'a').length,0);});
test('Session ledger has dedupe and bounded pruning',()=>{const v=new SessionLedger({sessionTtlMs:3600000,maxSessions:10});for(let i=0;i<15;i++)v.markHint('s'+i,'x');assert.equal(v.states.size,10);v.markLoad('a','s','p');assert.equal(v.loaded('a','s'),'p');v.clear();assert.equal(v.states.size,0);});
test('Plugin registers four tools, pre-admission hint and preserves native skills',async()=>{const base=await setupFile();try{const m=mock(base,{hints:'hint'});const teardown=await createPlugin().setup(m.ctx);assert.deepEqual([...m.tools.keys()].sort(),['lazy_skill_info','lazy_skill_load','lazy_skill_plan','lazy_skill_resource','lazy_skill_search','lazy_skill_status']);assert.ok(m.hooks.get('prompt'));
 const found=JSON.parse((await m.tools.get('lazy_skill_search').execute({query:'review code quality'},fake())).content);assert.equal(found.results[0].id,'project-review');
 const stats=JSON.parse((await m.tools.get('lazy_skill_status').execute({},fake())).content);assert.equal(stats.vault>=1,true);
 const native=JSON.parse((await m.tools.get('lazy_skill_load').execute({id:'native-security'},fake())).content);assert.equal(native.native,true);
 const loaded=await m.tools.get('lazy_skill_load').execute({id:'project-review'},fake());assert.match(loaded.content,/# Review/);assert.match(loaded.content,/Base directory:/);
 const again=JSON.parse((await m.tools.get('lazy_skill_load').execute({id:'project-review'},fake())).content);assert.equal(again.alreadyLoaded,true);
 const ref=await m.tools.get('lazy_skill_resource').execute({id:'project-review',path:'references/checklist.md'},fake());assert.match(ref.content,/Check inputs/);
 const info=JSON.parse((await m.tools.get('lazy_skill_info').execute({id:'project-review'},fake())).content);assert.deepEqual(info.resources,['references/checklist.md']);
 const event={sessionID:'other',prompt:{text:'Please perform a full review of this code and its quality'}};
 await m.hooks.get('prompt')(event);assert.match(event.prompt.text,/<lazy_skill_suggestions/);assert.ok(!event.prompt.text.includes('# Review'));
 await teardown();assert.equal(m.disposeCount(),2); // tools + prompt hook
}finally{await rm(base,{recursive:true,force:true});}});
test('Agent allowlist denies unapproved agents',async()=>{const base=await setupFile();try{const m=mock(base,{agents:['worker-b']});const cleanup=await createPlugin().setup(m.ctx);await assert.rejects(m.tools.get('lazy_skill_load').execute({id:'project-review'},fake('sess','worker-a')),/not permitted/);await cleanup();}finally{await rm(base,{recursive:true,force:true});}});
test('Disable hints and binding registers no prompt hook',async()=>{const base=await setupFile();try{const m=mock(base,{hints:'off',autoBind:'off',bindExplicit:false});const cleanup=await createPlugin().setup(m.ctx);assert.equal(m.hooks.size,0);await cleanup();}finally{await rm(base,{recursive:true,force:true});}});
test('Compact native catalog is explicit opt-in',async()=>{const base=await setupFile();try{const m=mock(base,{nativeCatalog:'compact',compactDescriptionChars:30});const cleanup=await createPlugin().setup(m.ctx);assert.equal(m.mutations.length,1);await cleanup();}finally{await rm(base,{recursive:true,force:true});}});
test('Cancelled tool call stops before resource read',async()=>{const base=await setupFile();try{const m=mock(base);const cleanup=await createPlugin().setup(m.ctx);const c=new AbortController();c.abort();await assert.rejects(m.tools.get('lazy_skill_load').execute({id:'project-review'},{...fake(),signal:c.signal}),/aborted/);await cleanup();}finally{await rm(base,{recursive:true,force:true});}});
test('Unknown and unsafe ids rejected',async()=>{const base=await setupFile();try{const m=mock(base);const cleanup=await createPlugin().setup(m.ctx);await assert.rejects(m.tools.get('lazy_skill_load').execute({id:'../../pass'},fake()),/Invalid skill id/);await assert.rejects(m.tools.get('lazy_skill_load').execute({id:'no-such-skill'},fake()),/not found/);await cleanup();}finally{await rm(base,{recursive:true,force:true});}});

test('Native skill ID overrides same-ID vault skill; native must not be custom-loaded',async()=>{const base=await setupFile();try{
 const same=join(base,'native-security');await mkdir(same);await writeFile(join(same,'SKILL.md'),'---\ndescription: Vault copy of security review\n---\nSHOULD-NOT-LOAD');
 const m=mock(base);const cleanup=await createPlugin().setup(m.ctx);
 const info=JSON.parse((await m.tools.get('lazy_skill_info').execute({id:'native-security'},fake())).content);
 assert.equal(info.scope,'native');
 const loaded=JSON.parse((await m.tools.get('lazy_skill_load').execute({id:'native-security'},fake())).content);
 assert.equal(loaded.native,true);assert.equal(loaded.message.includes('built-in'),true);
 await cleanup();
}finally{await rm(base,{recursive:true,force:true});}});

test('Explicit reload returns vault skill content again',async()=>{const base=await setupFile();try{
 const m=mock(base);const cleanup=await createPlugin().setup(m.ctx);
 const tool=m.tools.get('lazy_skill_load');const first=await tool.execute({id:'project-review'},fake());
 const second=await tool.execute({id:'project-review',reload:true},fake());
 assert.equal(first.content,second.content);await cleanup();
}finally{await rm(base,{recursive:true,force:true});}});

test('Repeated hint per session is deduplicated, cross-session hint is allowed',async()=>{const base=await setupFile();try{
 const m=mock(base,{hints:'hint'});const cleanup=await createPlugin().setup(m.ctx);const hint=m.hooks.get('prompt');
 const text='Review this code quality and pull request carefully';const ev=id=>({sessionID:id,prompt:{text}});
 const a=ev('same');await hint(a);assert.match(a.prompt.text,/<lazy_skill_suggestions/);
 const b=ev('same');await hint(b);assert.equal(b.prompt.text,text);
 const c=ev('different');await hint(c);assert.match(c.prompt.text,/<lazy_skill_suggestions/);
 await cleanup();
}finally{await rm(base,{recursive:true,force:true});}});

test('Directory absent is not an error; native catalog remains available',async()=>{
 const base=await mkdtemp(join(tmpdir(),'lazy-plugin-no-vault-'));
 try{const m=mock(base);const cleanup=await createPlugin().setup(m.ctx);
 const status=JSON.parse((await m.tools.get('lazy_skill_status').execute({},fake())).content);
 assert.equal(status.native,1);assert.equal(status.vault,0);
 await cleanup();}finally{await rm(base,{recursive:true,force:true});}
});

test('Partial setup failure disposes earlier transformations',async()=>{const base=await setupFile();try{
 const m=mock(base);m.ctx.session.hook=async()=>{throw new Error('hook unavailable')};
 await assert.rejects(createPlugin().setup(m.ctx),/hook unavailable/);
 assert.equal(m.disposeCount(),1); // tool transformer cleaned after hook failure
}finally{await rm(base,{recursive:true,force:true});}});

test('Near-duplicate skills do not consume both suggestion slots',()=>{
 const opts=configure({maxHints:2,hints:'hint'},{}),ledger=new SessionLedger(opts);
 const make=(id,name,description)=>({skill:{id,name,description,scope:'vault'},score:20,coverage:1});
 const hits=[
   make('review-basic','Review Basics','Review API code security quality'),
   make('review-basic-2','Review Basics','Review API code security quality'),
   make('code-security','Security Inspection','Analyze vulnerabilities in API code'),
 ];
 const selected=selectHints('review api code security quality',hits,opts,ledger,'sess');
 assert.deepEqual(selected.map(x=>x.skill.id),['review-basic','code-security']);
});

test('Localized hint includes selected language and excludes untrusted markup',()=>{
 const hit=[{score:40,coverage:1,skill:{id:'project-review',description:'<evil>',scope:'vault'}}];
 for(const locale of ['zh','en','hi','de','pt','ja','id','ru','fr','es','vi','nl','tr']){
   const msg=renderHints(hit,locale,'review code quality');
   assert.ok(msg.includes('lazy_skill_load'));assert.ok(!msg.includes('<evil>'));assert.ok(msg.includes('&lt;evil&gt;'));
 }
});

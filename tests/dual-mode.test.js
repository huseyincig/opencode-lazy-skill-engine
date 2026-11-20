import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPlugin } from '../dist/plugin.js';
import { configure } from '../dist/core/config.js';
import { selectBindings, automaticCandidates } from '../dist/core/selection.js';

function makeHost(root, options = {}, native = []) {
  const tools = new Map(), hooks = new Map(), sessions = new Map(), calls = { get:0 }, events = [];
  const ctx = {
    options:{roots:[root],refreshMs:0,hints:'off',...options},
    location:{directory:root, project:{canonical:root}},
    skill:{list:async()=>({data:native}), transform:async fn=>{fn({list:()=>native,update:(id,fn)=>{const s=native.find(x=>x.id===id);if(s)fn(s);}});return{dispose:async()=>events.push('skill disposed')};}},
    tool:{transform:async fn=>{fn({namespace:()=>{}, add:def=>tools.set(`lazy_skill_${def.name}`,def)});return{dispose:async()=>events.push('tool disposed')};}},
    session:{get:async({sessionID})=>{calls.get++;return{data:sessions.get(sessionID)??{agent:'build'}};},hook:async (name,fn)=>{hooks.set(name,fn);return {dispose:async()=>events.push(`${name} disposed`)};}}
  };
  return {ctx,tools,hooks,sessions,calls,events};
}
const SKILLS=[
 {id:'security-audit',name:'Security Audit',description:'Audit software security and vulnerabilities in APIs',autoinvoke:true},
 {id:'code-review',name:'Code Review',description:'Review source code for maintainability',autoinvoke:true},
 {id:'frontend-design',name:'Frontend Design',description:'Design frontend UI components',autoinvoke:true}
];
const invoke=async(m,sessionID,text,metadata,skills)=>{const e={sessionID,prompt:{text,...(skills?{skills}: {})},...(metadata?{metadata}: {})};await m.hooks.get('prompt')(e);return e;};

test('DEFAULT: without framework, no roles, single agent automatically selects applicable native skill',async t=>{
 const root=await mkdtemp(join(tmpdir(),'lazy-dual-single-'));t.after(()=>rm(root,{force:true,recursive:true}));
 const m=makeHost(root,{},structuredClone(SKILLS));const done=await createPlugin().setup(m.ctx);t.after(done);
 assert.equal(m.ctx.options.autoBind,undefined);
 const e=await invoke(m,'s-root','Audit software security vulnerabilities in APIs');
 assert.deepEqual(e.prompt.skills?.map(x=>x.id),['security-audit']);
 assert.equal(m.ctx.options.mode,undefined);
 const status=JSON.parse((await m.tools.get('lazy_skill_status').execute({}, {sessionID:'s-root'})).content);
 assert.equal(status.autoBind,'adaptive');assert.equal(status.mode,'auto');
 assert.equal(m.ctx.skill === undefined,false);
});

test('DEFAULT: without orchestration roles, child workers independently discover native skills',async t=>{
 const root=await mkdtemp(join(tmpdir(),'lazy-dual-worker-'));t.after(()=>rm(root,{force:true,recursive:true}));
 const m=makeHost(root,{},structuredClone(SKILLS));m.sessions.set('child',{agent:'specialist',parentID:'root'});
 const done=await createPlugin().setup(m.ctx);t.after(done);
 const e=await invoke(m,'child','Audit software security vulnerabilities in APIs');
 assert.deepEqual(e.prompt.skills?.map(x=>x.id),['security-audit']);
});

test('adaptive orchestrator: manager is not auto-bound; workers use role allowlists',async t=>{
 const root=await mkdtemp(join(tmpdir(),'lazy-dual-orchestrator-'));t.after(()=>rm(root,{force:true,recursive:true}));
 const m=makeHost(root,{roles:{manager:{allowed:['security-audit']},coder:{allowed:['code-review']}}},structuredClone(SKILLS));
 m.sessions.set('manager',{agent:'manager'});m.sessions.set('child',{agent:'coder',parentID:'manager'});
 const done=await createPlugin().setup(m.ctx);t.after(done);
 const p=await invoke(m,'manager','Audit software security vulnerabilities in APIs');
 assert.equal(p.prompt.skills,undefined);
 const c=await invoke(m,'child','Review source code for maintainability');
 assert.deepEqual(c.prompt.skills?.map(x=>x.id),['code-review']);
 const disallowed=await invoke(m,'child','Audit software security vulnerabilities in APIs');
 assert.ok(!disallowed.prompt.skills?.some(x=>x.id==='security-audit'));
});

test('forced single mode works when host session API is unavailable',async t=>{
 const root=await mkdtemp(join(tmpdir(),'lazy-dual-no-session-'));t.after(()=>rm(root,{force:true,recursive:true}));
 const m=makeHost(root,{mode:'single'},structuredClone(SKILLS));delete m.ctx.session.get;
 const done=await createPlugin().setup(m.ctx);t.after(done);
 const e=await invoke(m,'root','Audit software security vulnerabilities in APIs');
 assert.deepEqual(e.prompt.skills?.map(x=>x.id),['security-audit']);
});

test('orchestrator with unmapped role refuses auto-binding rather than widening permissions',async t=>{
 const root=await mkdtemp(join(tmpdir(),'lazy-dual-unknown-role-'));t.after(()=>rm(root,{force:true,recursive:true}));
 const m=makeHost(root,{mode:'orchestrator',roles:{coder:{allowed:['code-review']}}},structuredClone(SKILLS));
 m.sessions.set('child',{agent:'unknown',parentID:'root'});
 const done=await createPlugin().setup(m.ctx);t.after(done);
 const e=await invoke(m,'child','Audit software security vulnerabilities in APIs');assert.equal(e.prompt.skills,undefined);
});

test('single mode does not silently load unrelated skill, and still respects required explicit/native attachments',async t=>{
 const root=await mkdtemp(join(tmpdir(),'lazy-dual-pins-'));t.after(()=>rm(root,{force:true,recursive:true}));
 const m=makeHost(root,{},structuredClone(SKILLS));const done=await createPlugin().setup(m.ctx);t.after(done);
 const unrelated=await invoke(m,'single','Good morning, how are you?');assert.equal(unrelated.prompt.skills,undefined);
 const pins=await invoke(m,'single','skill:code-review', {lazySkill:{requiredSkills:['security-audit']}},[{id:'my-existing',mention:{start:0,end:1,text:'x'}}]);
 assert.deepEqual(pins.prompt.skills.map(x=>x.id),['my-existing','security-audit','code-review']);
});

test('generic auto pool includes native only, unless explicit vaultAutoBind is on; project vault needs projectAutoBind',()=>{
 const available=[
 {id:'native-skill',scope:'native',origin:'host'},
 {id:'global-vault',scope:'vault',origin:'global'},
 {id:'project-vault',scope:'vault',origin:'project',roles:[]}
 ];
 assert.deepEqual([...automaticCandidates({available,generic:true,vaultAutoBind:false})],['native-skill']);
 assert.deepEqual([...automaticCandidates({available,generic:true,vaultAutoBind:true,projectAutoBind:false})],['native-skill','global-vault']);
 assert.deepEqual([...automaticCandidates({available,generic:true,vaultAutoBind:true,projectAutoBind:true})],['native-skill','global-vault','project-vault']);
});

test('mode configuration rejects invalid values and keeps explicit override semantics',()=>{
 const defaultOptions=configure({},{project:{canonical:'/tmp/project'}});
 assert.equal(defaultOptions.autoBind,'adaptive');assert.equal(defaultOptions.mode,'auto');
 assert.equal(defaultOptions.nativeCatalog,'preserve');
 assert.equal(configure({mode:'orchestrator',autoBind:'workers',nativeCatalog:'preserve'},{}).autoBind,'workers');
 assert.equal(configure({mode:'bogus',autoBind:'invalid'},{}).mode,'auto');
});

test('orchestrator mode with zero role config still selects native skills for workers only',async t=>{
 const root=await mkdtemp(join(tmpdir(),'lazy-dual-openworker-'));t.after(()=>rm(root,{force:true,recursive:true}));
 const m=makeHost(root,{mode:'orchestrator'},structuredClone(SKILLS));m.sessions.set('parent',{agent:'coordinator'});m.sessions.set('worker',{agent:'specialist',parentID:'parent'});
 const done=await createPlugin().setup(m.ctx);t.after(done);
 const main=await invoke(m,'parent','Audit software security vulnerabilities in APIs');assert.equal(main.prompt.skills,undefined);
 const child=await invoke(m,'worker','Audit software security vulnerabilities in APIs');assert.deepEqual(child.prompt.skills?.map(x=>x.id),['security-audit']);
});

test('standalone allowed list is a hard automatic candidate boundary',async t=>{
 const root=await mkdtemp(join(tmpdir(),'lazy-dual-standalone-'));t.after(()=>rm(root,{force:true,recursive:true}));
 const m=makeHost(root,{singleAgent:{allowed:['code-review']}},structuredClone(SKILLS));const done=await createPlugin().setup(m.ctx);t.after(done);
 const s=await invoke(m,'root','Audit software security vulnerabilities in APIs');assert.equal(s.prompt.skills,undefined);
 const r=await invoke(m,'root','Review source code for maintainability');assert.deepEqual(r.prompt.skills?.map(x=>x.id),['code-review']);
});

test('role-only deployment fails closed when session API cannot provide authoritative role',async t=>{
 const root=await mkdtemp(join(tmpdir(),'lazy-dual-no-role-'));t.after(()=>rm(root,{force:true,recursive:true}));
 const m=makeHost(root,{roles:{coder:{allowed:['security-audit']}}},structuredClone(SKILLS));delete m.ctx.session.get;
 const done=await createPlugin().setup(m.ctx);t.after(done);
 const e=await invoke(m,'child','Audit software security vulnerabilities in APIs');assert.equal(e.prompt.skills,undefined);
});

test('plan previews single-agent routing without a predefined role or task metadata',async t=>{
 const root=await mkdtemp(join(tmpdir(),'lazy-dual-preview-'));t.after(()=>rm(root,{force:true,recursive:true}));
 const m=makeHost(root,{},structuredClone(SKILLS));const done=await createPlugin().setup(m.ctx);t.after(done);
 const p=JSON.parse((await m.tools.get('lazy_skill_plan').execute({query:'Audit software security vulnerabilities in APIs',worker:false},{sessionID:'root'})).content);
 assert.equal(p.mode,'single');assert.equal(p.bindMode,'all');assert.deepEqual(p.ids,['security-audit']);
});

test('native catalog hide transform covers native skills introduced after a host reload',async t=>{
 const root=await mkdtemp(join(tmpdir(),'lazy-dual-reload-'));t.after(()=>rm(root,{force:true,recursive:true}));
 const native=structuredClone(SKILLS).slice(0,1);
 let runTransform;const m=makeHost(root,{nativeCatalog:'hide'},native);
 m.ctx.skill.transform=async fn=>{runTransform=fn;fn({list:()=>native,update:(id,fn)=>{const x=native.find(y=>y.id===id);if(x)fn(x);}});return{dispose:async()=>{}};};
 const done=await createPlugin().setup(m.ctx);t.after(done);
 native.push({id:'new-native',name:'New skill',description:'Analyse performance metrics',autoinvoke:true});
 runTransform({list:()=>native,update:(id,fn)=>{const x=native.find(y=>y.id===id);if(x)fn(x);}});
 assert.equal(native[1].autoinvoke,false);
});

test('single-agent automatic matching is available across all 13 supported languages',async t=>{
 const corpus={
  zh:'请做代码安全审查',en:'Please perform a security code review',hi:'कोड की सुरक्षा समीक्षा करें',
  de:'Sicherheitsprüfung des Codes durchführen',pt:'Faça uma revisão de segurança do código',
  ja:'コードのセキュリティレビューをお願いします',id:'Tinjauan keamanan kode sekarang',
  ru:'Проведи проверку безопасности кода',fr:'Faire un audit de sécurité du code',
  es:'Realice una revisión de seguridad del código',vi:'Hãy đánh giá bảo mật mã nguồn',
  nl:'Doe een beveiligingscontrole van code',tr:'Lütfen kod güvenlik incelemesi yap'
 };
 const root=await mkdtemp(join(tmpdir(),'lazy-dual-multilang-'));t.after(()=>rm(root,{force:true,recursive:true}));
 const native=[{id:'secure-code-review',name:'Secure Code Review',description:'Review code security and vulnerabilities in repositories',autoinvoke:true},
  {id:'database-migration',name:'Database Migration',description:'Move schemas and data between databases',autoinvoke:true}];
 const m=makeHost(root,{},native);const done=await createPlugin().setup(m.ctx);t.after(done);
 for(const [lang,text] of Object.entries(corpus)){
   const e=await invoke(m,`lang-${lang}`,text);
   assert.deepEqual(e.prompt.skills?.map(x=>x.id),['secure-code-review'],lang);
 }
});

test('forced single-agent mode avoids unnecessary session API requests',async t=>{
 const root=await mkdtemp(join(tmpdir(),'lazy-dual-no-network-'));t.after(()=>rm(root,{force:true,recursive:true}));
 const m=makeHost(root,{mode:'single'},structuredClone(SKILLS));const done=await createPlugin().setup(m.ctx);t.after(done);
 await invoke(m,'root','Audit software security vulnerabilities in APIs');
 assert.equal(m.calls.get,0);
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseFrontmatter,scanVaults} from '../dist/core/scanner.js';
import {safeRead,inside} from '../dist/core/security.js';
import {configure} from '../dist/core/config.js';
const init=()=>mkdtemp(join(tmpdir(),'lazy-skill-test-'));
test('Frontmatter supports scalar and folded block',()=>{const r=parseFrontmatter('---\nname: "Test Skill"\ndescription: >-\n  Review the current\n  code carefully.\nkeywords: [review, "code quality"]\n---\nBody');assert.equal(r.meta.name,'Test Skill');assert.equal(r.meta.description,'Review the current code carefully.');assert.equal(r.body,'Body');});
test('Missing frontmatter preserves body',()=>assert.equal(parseFrontmatter('abc').body,'abc'));
test('Runaway frontmatter falls back safely',()=>assert.deepEqual(parseFrontmatter('---\n'+('a'.repeat(9000))+'\n---\nhello').meta,{}));
test('Reject arbitrary traversal, absolute files, and symlink escapes',async()=>{const tmp=await init();try{
 const root=join(tmp,'skills','foo');await mkdir(root,{recursive:true});await writeFile(join(root,'SKILL.md'),'ok');await writeFile(join(tmp,'outside'),'secret');await symlink(join(tmp,'outside'),join(root,'evil.md'));
 assert.equal(await safeRead(root,'SKILL.md',100),'ok');
 await assert.rejects(safeRead(root,'../foo/SKILL.md',100),/Invalid relative/);
 await assert.rejects(safeRead(root,join(tmp,'outside'),100),/Invalid relative/);
 await assert.rejects(safeRead(root,'evil.md',100),/symlink/);
 await assert.rejects(safeRead(root,'missing.md',100));
}finally{await rm(tmp,{recursive:true,force:true});}});
test('Reject binary and oversize resources',async()=>{const tmp=await init();try{await writeFile(join(tmp,'binary'),Buffer.from([1,0,1]));await writeFile(join(tmp,'large'),'12345');await assert.rejects(safeRead(tmp,'binary',10),/Binary/);await assert.rejects(safeRead(tmp,'large',4),/byte limit/);}finally{await rm(tmp,{recursive:true,force:true});}});
test('Within correct containment',()=>{assert.equal(inside('/tmp/foo','/tmp/foo/bar'),true);assert.equal(inside('/tmp/foo','/tmp/foo-evil'),false);});
test('Scanner recognizes root flat markdown and nested SKILL.md; project wins',async()=>{const tmp=await init();try{
 const global=join(tmp,'global'),project=join(tmp,'project');await mkdir(join(global,'code-review'),{recursive:true});await mkdir(join(project,'team','code-review'),{recursive:true});
 await writeFile(join(global,'code-review','SKILL.md'),'---\ndescription: old\n---\nGlobal');
 await writeFile(join(project,'team','code-review','SKILL.md'),'---\ndescription: project\nkeywords: [test, review]\n---\nProject');
 await writeFile(join(project,'flat.md'),'---\ndescription: flat description\n---\nFlat');
 await writeFile(join(project,'README.md'),'No frontmatter');
 const opts={...configure({maxDepth:5},{directory:tmp}),roots:[global,project]};const r=await scanVaults(opts);
 assert.equal(r.skills.length,2);assert.equal(r.skills.find(x=>x.id==='code-review').description,'project');assert.deepEqual(r.skills.find(x=>x.id==='code-review').keywords,['test','review']);
}finally{await rm(tmp,{recursive:true,force:true});}});
test('Scanner skips symlinked directories and unsafe names',async()=>{const tmp=await init();try{
 const a=join(tmp,'a');const ext=join(tmp,'ext');await mkdir(a);await mkdir(join(ext,'secret'),{recursive:true});await writeFile(join(ext,'secret','SKILL.md'),'---\ndescription: hidden\n---\nhello');await symlink(join(ext,'secret'),join(a,'linked'));await mkdir(join(a,'Bad_ID'));await writeFile(join(a,'Bad_ID','SKILL.md'),'---\ndescription: hello\n---\ncontent');const r=await scanVaults({...configure({},{}),roots:[a]});assert.equal(r.skills.length,0);
}finally{await rm(tmp,{recursive:true,force:true});}});
test('Config clamps bounds and avoids duplicates',()=>{const v=configure({maxSkills:999999,maxHints:999,roots:['.opencode/x','.opencode/x']},{directory:'/tmp/repo'});assert.equal(v.maxSkills,20000);assert.equal(v.maxHints,5);assert.equal(v.roots.length,3);});

test('Nested references/SKILL.md is not accidentally treated as a second skill',async()=>{const tmp=await init();try{
 const root=join(tmp,'vault');await mkdir(join(root,'main-skill','references','nested'),{recursive:true});
 await writeFile(join(root,'main-skill','SKILL.md'),'---\ndescription: Main skill\n---\nBody');
 await writeFile(join(root,'main-skill','references','nested','SKILL.md'),'---\ndescription: Hidden nested\n---\nBody');
 const r=await scanVaults({...configure({},{directory:tmp}),roots:[root]});
 assert.deepEqual(r.skills.map(x=>x.id),['main-skill']);
}finally{await rm(tmp,{recursive:true,force:true});}});

test('Scanner bounds metadata read to frontmatter and handles large body',async()=>{const tmp=await init();try{
 const dir=join(tmp,'long-skill');await mkdir(dir);await writeFile(join(dir,'SKILL.md'),'---\ndescription: Short metadata\n---\n'+('long-body-value '.repeat(4500)));
 const opts={...configure({maxSkillBytes:100000},{directory:tmp}),roots:[tmp]};
 const r=await scanVaults(opts);assert.equal(r.skills.length,1);assert.equal(r.skills[0].description,'Short metadata');
 const whole=await safeRead(dir,'SKILL.md',100000,tmp);assert.match(whole,/long-body-value/);
}finally{await rm(tmp,{recursive:true,force:true});}});

test('Vault root pinned path prevents symlinked replacement',async()=>{const tmp=await init();try{
 const project=join(tmp,'project'),outside=join(tmp,'outside');await mkdir(join(project,'demo'),{recursive:true});await mkdir(join(outside,'demo'),{recursive:true});
 await writeFile(join(outside,'demo','secret.md'),'exfiltrate');
 await rm(join(project,'demo'),{recursive:true});await symlink(join(outside,'demo'),join(project,'demo'));
 await assert.rejects(safeRead(join(project,'demo'),'secret.md',100,project),/trusted vault root/);
}finally{await rm(tmp,{recursive:true,force:true});}});

test('Multilingual frontmatter aliases are indexed safely',async()=>{const tmp=await init();try{
 const dir=join(tmp,'all-languages');await mkdir(dir);await writeFile(join(dir,'SKILL.md'),'---\ndescription: Review code\nkeywords_ja: [安全, コード]\nkeywords_tr: [güvenlik, inceleme]\nname_fr: Révision de code\n---\nContent');
 const r=await scanVaults({...configure({},{directory:tmp}),roots:[tmp]});
 assert.ok(r.skills[0].aliases.includes('安全'));assert.ok(r.skills[0].aliases.includes('güvenlik'));assert.ok(r.skills[0].aliases.includes('Révision de code'));
}finally{await rm(tmp,{recursive:true,force:true});}});

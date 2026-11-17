import {spawnSync} from 'node:child_process';
import {readdir} from 'node:fs/promises';
import {join} from 'node:path';
async function walk(dir){const out=[];for(const ent of await readdir(dir,{withFileTypes:true})){
  const path=join(dir,ent.name);if(ent.isDirectory())out.push(...await walk(path));else if(ent.name.endsWith('.js')||ent.name.endsWith('.mjs'))out.push(path);
}return out;}
const list=[...await walk('src'),...await walk('tests'),...await walk('scripts')];
for(const path of list){const r=spawnSync(process.execPath,['--check',path],{stdio:'inherit'});if(r.status!==0)process.exit(r.status??1);}
console.log(`PASS: ${list.length} JavaScript modules syntax`);
const t=spawnSync(process.execPath,['--test'],{stdio:'inherit'});process.exit(t.status??1);

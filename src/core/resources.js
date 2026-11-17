import { readdir,realpath } from 'node:fs/promises';
import { inside } from './security.js';
import { join,relative } from 'node:path';
export async function listResources(skill,max=40){
  if(skill.scope!=='vault')return [];
  const base=await realpath(skill.base);
  if(skill.root&&!inside(skill.root,base))throw new Error('Resource list escapes trusted vault root');
  const out=[];
  async function walk(dir,depth){
    if(depth>3||out.length>=max)return;
    let entries;try{entries=await readdir(dir,{withFileTypes:true});}catch{return;}
    for(const e of entries.sort((a,b)=>a.name.localeCompare(b.name))){
      if(e.name.startsWith('.')||e.isSymbolicLink()||e.name==='node_modules')continue;
      const path=join(dir,e.name);
      if(e.isDirectory())await walk(path,depth+1);
      else if(e.isFile()&&e.name!=='SKILL.md')out.push(relative(base,path).replaceAll('\\','/'));
      if(out.length>=max)break;
    }
  }
  await walk(base,0);return out;
}

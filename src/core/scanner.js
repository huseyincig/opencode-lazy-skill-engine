import { readdir, lstat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { inside, peekMetadata } from './security.js';
import { clipped } from './text.js';
import { LANGUAGES } from './concepts.js';

const GLOBAL_VAULT_ROOT=resolve(join(homedir(),'.config','opencode','skill-vault'));

const ignored = new Set(['.git','.hg','.svn','node_modules','.next','dist','build','.cache','__pycache__']);
const validID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
function disallowedYaml(v){const t=v.trim();return t.startsWith('&')||t.startsWith('*')||t.startsWith('!');}
function stripInlineComment(v){
  let quote=null;
  for(let i=0;i<v.length;i++){
    const ch=v[i];
    if(quote==='"'){if(ch==='\\'&&i+1<v.length){i++;continue;}if(ch==='"')quote=null;}
    else if(quote==="'"){if(ch==="'"&&v[i+1]==="'"){i++;continue;}if(ch==="'")quote=null;}
    else if(ch==='"'||ch==="'")quote=ch;
    else if(ch==='#'&&(i===0||/\s/.test(v[i-1])))return v.slice(0,i).trim();
  }
  return v.trim();
}
function scalar(v) {
  const x=stripInlineComment(v);
  if ((x.startsWith('"') && x.endsWith('"')) || (x.startsWith("'") && x.endsWith("'"))) return x.slice(1,-1).replace(/\\(["'\\])/g,'$1');
  return x;
}
function list(v) {
  const s=stripInlineComment(v);
  if(s.startsWith('[') && s.endsWith(']')) return s.slice(1,-1).split(/,(?=(?:[^"']|"[^"]*"|'[^']*')*$)/).map(scalar).filter(x=>x&&!disallowedYaml(x));
  return s&&!disallowedYaml(s) ? [scalar(s)] : [];
}
/** Intentionally bounded YAML frontmatter parser; no YAML tags, anchors or execution. */
export function parseFrontmatter(data, maxFrontmatterBytes=8192) {
  const src=typeof data==='string'&&data.charCodeAt(0)===0xFEFF?data.slice(1):data;
  const open=/^---[ \t]*\r?\n/.exec(src);
  if(!open)return {meta:{},body:src};
  const marker=/\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/g;
  marker.lastIndex=open[0].length;
  const match=marker.exec(src);
  if(!match || match.index>maxFrontmatterBytes)return {meta:{},body:src};
  const fm=src.slice(open[0].length,match.index);
  const body=src.slice(match.index+match[0].length);
  const meta={};let current=null, block=false;
  for(const line of fm.split(/\r?\n/)) {
    const kv=/^([a-zA-Z][\w/-]*):\s*(.*)$/.exec(line);
    if(kv){
      current=kv[1];const raw=stripInlineComment(kv[2]);
      block=/^[|>][+-]?$/.test(raw);
      if(block){meta[current]='';continue;}
      if(disallowedYaml(raw)){current=null;continue;}
      meta[current]=raw.startsWith('[')&&raw.endsWith(']')?list(raw):scalar(raw);continue;
    }
    if(current && /^\s+-\s+/.test(line) && !block){
      const item=stripInlineComment(line.replace(/^\s+-\s+/,''));
      if(!item||disallowedYaml(item))continue;
      if(!Array.isArray(meta[current]))meta[current]=meta[current]?list(meta[current]):[];
      meta[current].push(scalar(item));continue;
    }
    if(current && /^\s+\S/.test(line) && block){meta[current]+=(meta[current]?' ':'')+line.trim();}
  }
  return {meta,body};
}
const getList = v => Array.isArray(v) ? v : typeof v==='string' ? list(v) : [];
function idFromPath(file) { return basename(file)==='SKILL.md' ? basename(resolve(file,'..')) : basename(file,'.md'); }
function resolveOrigin(file, root, priority, opts) {
  const resolvedRoot=resolve(root);
  if(resolvedRoot===GLOBAL_VAULT_ROOT)return 'global';
  if(opts?.project && (inside(resolve(opts.project),resolvedRoot)||inside(resolve(opts.project),resolve(file))))return 'project';
  return priority===1?'project':priority===0?'global':'host';
}
export function normalizeEntry(meta, file, root, priority, opts) {
  const id=idFromPath(file).toLowerCase();
  if(!validID.test(id) || id.length>64 || opts.exclude.has(id))return null;
  const description=clipped(meta.description,700);
  if(!description)return null;
  return {
    id,
    name:clipped(meta.name || id,100),
    description,
    keywords:[...new Set([...getList(meta.keywords),...(opts.rules[id]||[])].map(clippedWord).filter(Boolean))].slice(0,40),
    aliases:[...new Set([...getList(meta.aliases),...LANGUAGES.flatMap(lang=>[...getList(meta[`keywords_${lang}`]),...getList(meta[`keywords-${lang}`]),meta[`name_${lang}`],meta[`description_${lang}`]].filter(Boolean))].map(clippedWord).filter(Boolean))].slice(0,60),
    tags:getList(meta.tags).map(clippedWord).filter(Boolean).slice(0,40),
    triggers:getList(meta.triggers).map(clippedWord).filter(Boolean).slice(0,64),
    negativeTriggers:getList(meta.negativeTriggers).map(clippedWord).filter(Boolean).slice(0,64),
    languages:getList(meta.languages).filter(x=>LANGUAGES.includes(x)).slice(0,13),
    roles:getList(meta.roles).map(clippedWord).filter(x=>/^[a-z][a-z0-9-]{0,62}$/.test(x)).slice(0,64),
    origin:resolveOrigin(file,root,priority,opts),
    path:file, base:resolve(file,'..'), root,
    scope:'vault', priority, source:'vault',
    trust:'untrusted',
  };
}
function clippedWord(s){return clipped(s,80);}
export async function scanVaults(opts,cache=new Map(),force=false) {
  const found=new Map();const diagnostics=[];
  let metadataReads=0,metadataReuses=0;
  const visitedPaths=new Set();
  // Scan highest-priority roots (project/custom) before global so a large global
  // vault cannot starve project skills when approaching maxSkills.
  for(let r=opts.roots.length-1;r>=0;r--) {
    const root=opts.roots[r];
    let realRoot;
    try {realRoot=await realpath(root);} catch(e) {if(e?.code!=='ENOENT')diagnostics.push({root,error:e.code||'READ_FAILED'});continue;}
    let visited=0;
    async function walk(dir,depth) {
      if(depth>opts.maxDepth || found.size>=opts.maxSkills || visited>opts.maxSkills*8)return;
      let entries;
      try{entries=await readdir(dir,{withFileTypes:true});}catch(e){diagnostics.push({root,error:e.code||'SCAN_FAILED'});return;}
      entries.sort((a,b)=>a.name.localeCompare(b.name));
      // A skill directory is an atomic unit: do not index supporting SKILL.md files inside it.
      if(depth>0 && entries.some(e=>e.name==='SKILL.md' && e.isFile()))entries=entries.filter(e=>e.name==='SKILL.md');
      for(const e of entries){
        if(found.size>=opts.maxSkills || visited>opts.maxSkills*8)break;
        if(e.name.startsWith('.') || ignored.has(e.name) || e.isSymbolicLink())continue;
        const p=join(dir,e.name);visited++;
        if(e.isDirectory()) {await walk(p,depth+1);continue;}
        if(!e.isFile() || (e.name!=='SKILL.md' && !(depth===0 && e.name.endsWith('.md'))))continue;
        try {
          const st=await lstat(p);
          if(st.size>opts.maxSkillBytes || !st.isFile())continue;
          const rp=await realpath(p);
          if(!inside(realRoot,rp))continue;
          const stamp=[st.dev,st.ino,st.size,st.mtimeMs,st.ctimeMs].join(':');
          const cached=cache.get(rp);
          let meta;
          if(!force && cached?.stamp===stamp){meta=cached.meta;metadataReuses++;}
          else{
            const text=await peekMetadata(rp,opts.maxSkillBytes,opts.maxFrontmatterBytes);
            if(text.includes('\0'))continue;
            meta=parseFrontmatter(text,opts.maxFrontmatterBytes).meta;
            metadataReads++;
            cache.set(rp,{stamp,meta});
          }
          visitedPaths.add(rp);
          const skill=normalizeEntry(meta,rp,realRoot,r,opts);
          if(skill && !found.has(skill.id))found.set(skill.id,skill); // Higher-priority roots (scanned first) win.
        } catch(e){diagnostics.push({root,error:e.code||'FILE_FAILED'});}
      }
    }
    await walk(realRoot,0);
  }
  // Evict deletions and renames to bound in-memory metadata and avoid stale
  // registration across future refreshes. The cache never holds skill bodies.
  for(const path of cache.keys())if(!visitedPaths.has(path))cache.delete(path);
  return {skills:[...found.values()],diagnostics,metadataReads,metadataReuses};
}

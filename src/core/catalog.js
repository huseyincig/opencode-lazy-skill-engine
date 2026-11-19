import { scanVaults } from './scanner.js';
import { createSearchIndex, search } from './rank.js';
import { clipped } from './text.js';
import { LANGUAGES } from './concepts.js';
import { parseFrontmatter } from './scanner.js';
import { inside } from './security.js';
import { existsSync, realpathSync } from 'node:fs';
import { resolve,join } from 'node:path';
const safeReal=p=>{try{return realpathSync(p);}catch{return resolve(p);}};
const hasProjectNative=(projectOpenCode,id)=>existsSync(join(projectOpenCode,'skills',id,'SKILL.md'))||existsSync(join(projectOpenCode,'skill',id,'SKILL.md'));
export function normalizeNative(result, opts) {
  const raw=Array.isArray(result) ? result : result?.skills ?? result?.items ?? result?.data ?? [];
  if(!Array.isArray(raw))throw new Error('Unexpected ctx.skill.list() response');
  const projectOpenCode=safeReal(join(opts.project,'.opencode'));
  return raw.filter(s=>s && typeof s.id==='string' && !opts.exclude.has(s.id)).map(s=>{
    // In V2 a native skill may already expose content and omit top-level description;
    // inspect only its bounded prefix, do not open another file or persist its large body.
    const meta=typeof s.content==='string'?parseFrontmatter(s.content.slice(0,opts.maxFrontmatterBytes+16),opts.maxFrontmatterBytes).meta:{};
    const values=(key)=>Array.isArray(s[key])?s[key]:Array.isArray(meta[key])?meta[key]:typeof meta[key]==='string'&&meta[key]?[meta[key]]:[];
    const origin=(typeof s.path==='string' && inside(projectOpenCode,safeReal(s.path)))||hasProjectNative(projectOpenCode,s.id)?'project':'host';
    const rawDescription=typeof s.description==='string'&&s.description.trim()?s.description:typeof meta.description==='string'&&meta.description.trim()?meta.description:typeof s.name==='string'&&s.name.trim()?s.name:'';
    return {
      id:s.id,name:clipped(s.name??s.id,100),description:clipped(rawDescription,700),
      keywords:[...new Set([...(opts.rules[s.id]||[]),...values('keywords')])].slice(0,64),
      aliases:[...new Set([...values('aliases'),...LANGUAGES.flatMap(lang=>[
        ...values(`keywords_${lang}`),...values(`keywords-${lang}`),...values(`name_${lang}`),...values(`description_${lang}`)
      ])])].slice(0,90),tags:values('tags').slice(0,64),
      triggers:values('triggers').slice(0,64),negativeTriggers:values('negativeTriggers').slice(0,64),
      languages:values('languages').slice(0,13),roles:values('roles').slice(0,64),
      scope:'native',origin,source:'native',path:typeof s.path==='string'?s.path:null,
      base:null,trust:'native',autoinvoke:s.autoinvoke!==false,
    };
  });
}
export class Catalog {
  constructor(ctx,opts) {this.ctx=ctx;this.opts=opts;this.index=createSearchIndex([],opts.weights);this.items=new Map();this.next=0;this.inflight=null;this.diagnostics=[];this.version=0;this.nativeReady=!opts.includeNative;this.metaCache=new Map();this.scanStats={metadataReads:0,metadataReuses:0};}
  invalidate(){this.next=0;}
  async refresh(force=false) {
    const now=Date.now();
    if(!force && this.next>now)return this;
    if(this.inflight){
      await this.inflight;
      if(!force)return this;
    }
    this.inflight=(async()=>{
      const {skills:vault,diagnostics,metadataReads,metadataReuses}=await scanVaults(this.opts,this.metaCache,force);
      let native=[];
      if(this.opts.includeNative){
        try{
          native=normalizeNative(await this.ctx.skill.list(),this.opts);this.nativeReady=true;
          if(this.originals)for(const s of native){if(this.originals.has(s.id))s.description=this.originals.get(s.id);else this.originals.set(s.id,s.description);}
        }catch(e){this.nativeReady=false;diagnostics.push({root:'native',error:String(e?.message||e)});native=[...this.items.values()].filter(s=>s.scope==='native');}
      }
      const all=new Map();
      for(const skill of vault) all.set(skill.id,skill);
      for(const skill of native) all.set(skill.id,skill); // native wins, no shadow of built-in permission path
      const sorted=[...all.values()].sort((a,b)=>a.id.localeCompare(b.id));
      this.items=all;
      this.index=createSearchIndex(sorted,this.opts.weights);
      this.scanStats={metadataReads,metadataReuses};this.diagnostics=diagnostics.slice(0,30);this.next=Date.now()+this.opts.refreshMs;this.version++;
      return this;
    })();
    try{return await this.inflight;} finally{this.inflight=null;}
  }
  async get(id) {await this.refresh();return this.items.get(id);}
  async search(query,opts={}) {await this.refresh(opts.force);return search(this.index,query,{topK:opts.topK??this.opts.maxResults,scope:opts.scope,allowedIds:opts.allowedIds,respectNegativeTriggers:opts.respectNegativeTriggers,preferFullCoverage:opts.preferFullCoverage});}
  async status(){await this.refresh();return {skills:this.items.size,native:[...this.items.values()].filter(s=>s.scope==='native').length,vault:[...this.items.values()].filter(s=>s.scope==='vault').length,version:this.version,metadataCache:this.scanStats,diagnostics:this.diagnostics};}
}

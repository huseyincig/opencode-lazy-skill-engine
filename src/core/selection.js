/** Host-neutral, role-aware skill binding policy. Never reads skill bodies. */
import { fold, tokenize } from './text.js';
const ID=/^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const BIND_MODES=new Set(['off','workers','all']);
const DEFAULT_MAX=3;
const ORIGIN_BONUS={project:1.08,global:1.03,bundled:1,host:1};
const uniq=x=>[...new Set(x)];
const idList=x=>Array.isArray(x)?uniq(x.filter(s=>typeof s==='string'&&ID.test(s)&&s.length<=64)).slice(0,128):[];

export function extractExplicit(text='', maxChars=12000) {
  if(typeof text!=='string')return [];
  return uniq([...text.slice(0,maxChars).matchAll(/\bskill\s*:\s*([a-z0-9]+(?:-[a-z0-9]+)*)\b/gi)]
    .map(m=>m[1].toLowerCase()).filter(id=>id.length<=64)).slice(0,128);
}

export function negativeTriggerMatch(text,skill){
  if(!Array.isArray(skill?.negativeTriggers)||!skill.negativeTriggers.length)return false;
  const foldedText=fold(text);
  const input=new Set(tokenize(text,true));
  const normalized=` ${foldedText.replace(/[^\p{L}\p{M}\p{N}]+/gu,' ').trim()} `;
  const compactText=foldedText.replace(/\s+/g,'');
  for(const raw of skill.negativeTriggers.slice(0,64)){
    if(typeof raw!=='string'||raw.length>200)continue;
    const words=tokenize(raw,true);
    if(!words.length)continue;
    if(words.length===1&&input.has(words[0]))return true;
    if(words.length>1 && normalized.includes(` ${words.join(' ')} `))return true;
    if(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(raw)&&compactText.includes(fold(raw).replace(/\s+/g,'')))return true;
  }
  return false;
}

export function automaticCandidates({available=[],roleName,role,projectAutoBind=false,generic=false,vaultAutoBind=false,genericAllowed=[],hostAllowed=null}) {
  const all=new Map(available.map(s=>[s.id,s]));
  const explicitlyAllowed=idList(genericAllowed);
  // Standalone and role-less orchestration share one safe, host-agnostic pool.
  // Native IDs stay attached by OpenCode (not loaded by our file reader).
  // A cold-vault project skill is never automatically selected unless both
  // vaultAutoBind and projectAutoBind have been explicitly enabled.
  const allowed=generic
    ? available.filter(s=>
        (s.scope==='native'||(vaultAutoBind&&s.scope==='vault'&&(s.origin!=='project'||projectAutoBind))) &&
        (!explicitlyAllowed.length||explicitlyAllowed.includes(s.id))
      ).map(s=>s.id)
    : idList(role?.allowed).filter(id=>all.has(id));
  if(projectAutoBind && typeof roleName==='string') {
    for(const skill of available){
      if(skill.origin==='project'&&Array.isArray(skill.roles)&&skill.roles.includes(roleName)&&!allowed.includes(skill.id))allowed.push(skill.id);
    }
  }
  // Never route into cold-vault content without an explicit vault opt-in.
  return new Set(allowed.filter(id=> (vaultAutoBind||all.get(id)?.scope!=='vault') && (!hostAllowed || hostAllowed.has(id))));
}

export function selectBindings({available=[],promptText='',requiredSkills=[],roleName,role,autoBind='off',isWorker=false,
  projectAutoBind=false,ranked=[],minScore=1.2,maxActive=DEFAULT_MAX,generic=false,vaultAutoBind=false,genericAllowed=[],hostAllowed=null,minCoverage=0,maxPromptChars=12000,bindExplicit=true}={}){
  const byId=new Map(available.map(s=>[s.id,s]));
  const required=idList(requiredSkills), explicit=extractExplicit(promptText,maxPromptChars);
  const missingRequired=required.filter(id=>!byId.has(id));
  const missingExplicit=explicit.filter(id=>!byId.has(id));
  const existExplicit=explicit.filter(id=>byId.has(id));
  const mode=BIND_MODES.has(autoBind)?autoBind:'off';
  const autoPermitted=mode==='all'||(mode==='workers'&&isWorker);
  // Hard required invariant: fail atomically before any native skill attachment.
  if(missingRequired.length)return {ids:[],source:'task',missingRequired,missingExplicit,scores:[]};
  if(required.length){
    let extra=existExplicit;
    if(!bindExplicit){
      const candidates=autoPermitted?automaticCandidates({available,roleName,role,projectAutoBind,generic,vaultAutoBind,genericAllowed,hostAllowed}):new Set();
      extra=existExplicit.filter(id=>candidates.has(id));
    }
    return {ids:uniq([...required,...extra]),source:'task',missingRequired,missingExplicit,scores:[]};
  }
  if(explicit.length&&bindExplicit)return {ids:existExplicit,source:existExplicit.length?'explicit':'none',missingRequired,missingExplicit,scores:[]};
  if(!autoPermitted)return {ids:[],source:'none',missingRequired,missingExplicit,scores:[]};
  const candidateIds=automaticCandidates({available,roleName,role,projectAutoBind,generic,vaultAutoBind,genericAllowed,hostAllowed});
  if(candidateIds.size===0)return {ids:[],source:'none',missingRequired,missingExplicit,scores:[]};
  if(explicit.length){
    const allowedExplicit=existExplicit.filter(id=>candidateIds.has(id));
    if(allowedExplicit.length)return {ids:allowedExplicit,source:'explicit',missingRequired,missingExplicit,scores:[]};
  }
  const limit=Math.max(1,Math.min(8,Number.isInteger(role?.maxActive)?role.maxActive:maxActive));
  const scored=ranked.filter(h=>candidateIds.has(h.skill?.id)&&!negativeTriggerMatch(promptText,h.skill))
    .map(h=>({id:h.skill.id,raw:h.score,score:h.score*(ORIGIN_BONUS[h.skill.origin]??1),coverage:h.coverage??0,origin:h.skill.origin}));
  scored.sort((a,b)=>b.score-a.score || b.coverage-a.coverage || a.id.localeCompare(b.id));
  const lexical=scored.filter(h=>h.raw>=minScore&&h.coverage>=minCoverage).slice(0,limit);
  if(lexical.length)return {ids:lexical.map(h=>h.id),source:'router',missingRequired,missingExplicit,scores:scored.slice(0,16)};
  const defaults=idList(role?.default).filter(id=>candidateIds.has(id)&&!negativeTriggerMatch(promptText,byId.get(id))).slice(0,limit);
  if(defaults.length)return {ids:defaults,source:'default',missingRequired,missingExplicit,scores:scored.slice(0,16)};
  return {ids:[],source:'none',missingRequired,missingExplicit,scores:scored.slice(0,16)};
}

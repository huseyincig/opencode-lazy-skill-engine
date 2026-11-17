import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { LANGUAGES } from './concepts.js';

const clampInt = (v, fallback, min, max) => Number.isFinite(v) ? Math.max(min, Math.min(max, Math.trunc(v))) : fallback;
const nonempty = v => typeof v === 'string' && v.trim().length > 0;
const arrayOfStrings = v => Array.isArray(v) ? v.filter(nonempty).map(s => s.trim()) : [];
const SKILL_ID=/^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const cleanIds = values => [...new Set(arrayOfStrings(values).filter(id=>SKILL_ID.test(id)&&id.length<=64))].slice(0,128);
function roleOptions(input){
  const result=Object.create(null);
  if(!input||typeof input!=='object'||Array.isArray(input))return result;
  for(const [role,raw] of Object.entries(input).slice(0,64)){
    if(!/^[a-z][a-z0-9-]{0,62}$/.test(role)||!raw||typeof raw!=='object'||Array.isArray(raw))continue;
    result[role]={allowed:cleanIds(raw.allowed),default:cleanIds(raw.default),maxActive:clampInt(raw.maxActive,3,1,8)};
  }
  return result;
}

export function configure(options = {}, location = {}) {
  if (options === null || Array.isArray(options) || typeof options !== 'object') throw new TypeError('Plugin options must be an object');
  const project = location.project?.canonical ?? location.project?.directory ?? location.directory ?? process.cwd();
  const globalRoot = join(homedir(), '.config', 'opencode', 'skill-vault');
  const vaultRoots = [globalRoot, join(project, '.opencode', 'skill-vault')];
  for (const root of arrayOfStrings(options.roots)) {
    const expanded = root === '~' ? homedir() : root.startsWith('~/') ? join(homedir(), root.slice(2)) : root;
    vaultRoots.push(isAbsolute(expanded) ? resolve(expanded) : resolve(project, expanded));
  }
  const hints = ['off', 'hint'].includes(options.hints) ? options.hints : 'off';
  const nativeCatalog = ['preserve', 'compact', 'hide'].includes(options.nativeCatalog) ? options.nativeCatalog : 'preserve';
  const weights = {
    id: 7, name: 6, keywords: 5, aliases: 4, tags: 3, triggers: 5, description: 1.8,
    ...(options.weights && typeof options.weights === 'object' && !Array.isArray(options.weights) ? Object.fromEntries(Object.entries(options.weights).filter(([k,v]) => ['id','name','keywords','aliases','tags','triggers','description'].includes(k) && Number.isFinite(v) && v >= 0 && v <= 20)) : {}),
  };
  const rules = {};
  if (options.rules && typeof options.rules === 'object' && !Array.isArray(options.rules)) {
    for (const [id, words] of Object.entries(options.rules)) {
      if (/^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$/.test(id)) rules[id] = arrayOfStrings(words).slice(0,32);
    }
  }
  return Object.freeze({
    project:resolve(project),
    roots: [...new Set(vaultRoots.map(root => resolve(root)))],
    includeNative: options.includeNative !== false,
    nativeCatalog,
    coexistence: options.coexistence === 'augment' ? 'augment' : 'respect',
    respectHostPermissions: options.respectHostPermissions !== false,
    searchDetail:['ids','summary','full'].includes(options.searchDetail)?options.searchDetail:'summary',
    autoBind:['off','workers','all','adaptive'].includes(options.autoBind)?options.autoBind:'adaptive',
    mode:['auto','single','orchestrator'].includes(options.mode)?options.mode:'auto',
    singleAgent:Object.freeze({
      allowed:cleanIds(options.singleAgent?.allowed),
      maxActive:clampInt(options.singleAgent?.maxActive,1,1,8),
      minScore:typeof options.singleAgent?.minScore==='number'&&Number.isFinite(options.singleAgent.minScore)?Math.max(0,Math.min(100,options.singleAgent.minScore)):5,
      minCoverage:typeof options.singleAgent?.minCoverage==='number'&&Number.isFinite(options.singleAgent.minCoverage)?Math.max(0,Math.min(1,options.singleAgent.minCoverage)):0.55,
    }),
    roles:roleOptions(options.roles),
    projectAutoBind:options.projectAutoBind===true,
    vaultAutoBind:options.vaultAutoBind===true,
    bindExplicit:options.bindExplicit===true,
    minAutoScore:typeof options.minAutoScore==='number'&&Number.isFinite(options.minAutoScore)?Math.max(0,Math.min(100,options.minAutoScore)):1.2,
    maxAutoSkills:clampInt(options.maxAutoSkills,3,1,8),
    semantic:Object.freeze({
      enabled:options.semantic?.enabled===true,
      model:typeof options.semantic?.model==='string'?options.semantic.model.slice(0,160):'',
      timeoutMs:clampInt(options.semantic?.timeoutMs,1500,50,5000),
      maxCandidates:clampInt(options.semantic?.maxCandidates,40,1,120)
    }),
    hints,
    language:LANGUAGES.includes(options.language)?options.language:'auto',
    maxHints: clampInt(options.maxHints, 2, 0, 5),
    minHintCoverage: typeof options.minHintCoverage === 'number' && options.minHintCoverage >= 0 && options.minHintCoverage <= 1 ? options.minHintCoverage : 0.65,
    maxResults: clampInt(options.maxResults, 8, 1, 30),
    refreshMs: clampInt(options.refreshMs, 30000, 0, 3600000),
    maxSkills: clampInt(options.maxSkills, 3000, 1, 20000),
    maxDepth: clampInt(options.maxDepth, 6, 1, 10),
    maxSkillBytes: clampInt(options.maxSkillBytes, 98304, 1024, 524288),
    maxResourceBytes: clampInt(options.maxResourceBytes, 65536, 1024, 524288),
    maxFrontmatterBytes: clampInt(options.maxFrontmatterBytes, 8192, 256, 32768),
    sessionTtlMs: clampInt(options.sessionTtlMs, 3600000, 60000, 86400000),
    maxSessions: clampInt(options.maxSessions, 200, 10, 2000),
    maxPromptChars: clampInt(options.maxPromptChars, 12000, 300, 100000),
    compactDescriptionChars: clampInt(options.compactDescriptionChars, 100, 30, 200),
    agents: arrayOfStrings(options.agents),
    rules,
    weights,
    exclude: new Set(arrayOfStrings(options.exclude)),
  });
}

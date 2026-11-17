/**
 * Optional, host-native skill admission introspection.
 * No named-agent assumptions; only host-provided capability and policy data are used.
 *
 * This only limits the plugin's OWN proposed attachments. Host permissions
 * remain authoritative for native tool calls and existing prompt attachments.
 */
export function globMatch(pattern, text) {
  if (typeof pattern !== 'string' || typeof text !== 'string' || pattern.length > 256 || text.length > 256) return false;
  let i = 0, j = 0, star = -1, previous = -1;
  while (j < text.length) {
    if (i < pattern.length && (pattern[i] === text[j] || pattern[i] === '?')) {i++; j++; continue;}
    if (i < pattern.length && pattern[i] === '*') {star = i++; previous = j; continue;}
    if (star !== -1) {i = star + 1; j = ++previous; continue;}
    return false;
  }
  while (i < pattern.length && pattern[i] === '*') i++;
  return i === pattern.length;
}

/** OpenCode ordered permission rule semantics: last matching rule wins. */
export function hasSkillRules(rules) {
  return Array.isArray(rules) && rules.some(rule => rule && typeof rule === 'object' && globMatch(rule.action, 'skill'));
}
export function skillPermissionDecision(rules, skillId) {
  if (!Array.isArray(rules) || rules.length > 2048 || typeof skillId !== 'string' || skillId.length > 256) return 'unknown';
  let verdict = 'unknown';
  for (const rule of rules) {
    if (!rule || typeof rule !== 'object' ||
      !globMatch(rule.action, 'skill') || !globMatch(rule.resource, skillId)) continue;
    verdict = ['allow', 'deny', 'ask'].includes(rule.effect) ? rule.effect : 'unknown';
  }
  return verdict;
}

function normalizeAgentList(result) {
  const agents = Array.isArray(result) ? result : Array.isArray(result?.data) ? result.data : null;
  return agents?.filter(item => item && typeof item.id === 'string').slice(0, 256) ?? null;
}

const ORCHESTRATED_ACTIONS = new Set(['skill', 'edit', 'shell', 'bash', 'subagent', 'task', 'question', '*']);
/** A roster with explicitly restricted specialist subagents indicates an orchestrated workspace. */
export function isOrchestratedRoster(agents) {
  return Array.isArray(agents) && agents.some(agent =>
    agent?.mode === 'subagent' && Array.isArray(agent.permissions) &&
    agent.permissions.some(rule => ORCHESTRATED_ACTIONS.has(rule?.action) && (rule.effect === 'deny' || rule.effect === 'ask'))
  );
}

export class HostSkillPolicy {
  constructor(agentDomain, ttl = 3000) {
    this.domain = agentDomain;
    this.ttl = ttl;
    this.until = 0;
    this.roster = null;
    this.pending = null;
  }
  async list() {
    if (typeof this.domain?.list !== 'function') return null;
    if (Date.now() < this.until) return this.roster;
    if (this.pending) return this.pending;
    this.pending = (async () => {
      let timer;
      try {
        const result = await Promise.race([
          Promise.resolve().then(() => this.domain.list()),
          new Promise(resolve => {timer = setTimeout(() => resolve(undefined), 900);})
        ]);
        this.roster = normalizeAgentList(result);
        this.until = Date.now() + this.ttl;
      } catch {
        this.until = Date.now() + Math.min(this.ttl, 500);
      } finally {
        clearTimeout(timer);
      }
      return this.roster;
    })();
    try {return await this.pending;} finally {this.pending = null;}
  }
  async forAgent(agentId) {
    if (typeof agentId !== 'string' || !agentId) return {roster: await this.list(), policy: null};
    const roster = await this.list();
    const agent = roster?.find(item => item.id === agentId);
    return {roster, policy: Array.isArray(agent?.permissions) ? agent.permissions : null};
  }
  clear() {this.roster = null;this.until = 0;this.pending = null;}
}

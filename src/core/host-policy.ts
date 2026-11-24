/**
 * Optional, host-native skill admission introspection.
 * No named-agent assumptions; only host-provided capability and policy data are used.
 */

export interface PermissionRule {
  action?: string;
  resource?: string;
  effect?: string;
}

export interface AgentInfo {
  id: string;
  mode?: string;
  permissions?: PermissionRule[];
}

export interface AgentDomainLike {
  list?: () => Promise<unknown> | unknown;
}

export type SkillDecision = "allow" | "deny" | "ask" | "unknown";

export function globMatch(pattern: string, text: string): boolean {
  if (typeof pattern !== "string" || typeof text !== "string" || pattern.length > 256 || text.length > 256) return false;
  let i = 0;
  let j = 0;
  let star = -1;
  let previous = -1;
  while (j < text.length) {
    if (i < pattern.length && (pattern[i] === text[j] || pattern[i] === "?")) {
      i++;
      j++;
      continue;
    }
    if (i < pattern.length && pattern[i] === "*") {
      star = i++;
      previous = j;
      continue;
    }
    if (star !== -1) {
      i = star + 1;
      j = ++previous;
      continue;
    }
    return false;
  }
  while (i < pattern.length && pattern[i] === "*") i++;
  return i === pattern.length;
}

/** OpenCode ordered permission rule semantics: last matching rule wins. */
export function hasSkillRules(rules: unknown): rules is PermissionRule[] {
  return Array.isArray(rules) && rules.some((rule) => rule && typeof rule === "object" && globMatch((rule as PermissionRule).action ?? "", "skill"));
}

export function skillPermissionDecision(rules: unknown, skillId: string): SkillDecision {
  if (!Array.isArray(rules) || rules.length > 2048 || typeof skillId !== "string" || skillId.length > 256) return "unknown";
  let verdict: SkillDecision = "unknown";
  for (const rule of rules as PermissionRule[]) {
    if (
      !rule ||
      typeof rule !== "object" ||
      !globMatch(rule.action ?? "", "skill") ||
      !globMatch(rule.resource ?? "", skillId)
    ) {
      continue;
    }
    verdict = rule.effect === "allow" || rule.effect === "deny" || rule.effect === "ask" ? rule.effect : "unknown";
  }
  return verdict;
}

function normalizeAgentList(result: unknown): AgentInfo[] | null {
  const resObj = result && typeof result === "object" && !Array.isArray(result) ? (result as { data?: unknown }) : null;
  const agents = Array.isArray(result) ? result : Array.isArray(resObj?.data) ? resObj.data : null;
  return agents?.filter((item): item is AgentInfo => Boolean(item && typeof item === "object" && typeof (item as AgentInfo).id === "string")).slice(0, 256) ?? null;
}

const ORCHESTRATED_ACTIONS = new Set(["skill", "edit", "shell", "bash", "subagent", "task", "question", "*"]);

/** A roster with explicitly restricted specialist subagents indicates an orchestrated workspace. */
export function isOrchestratedRoster(agents: unknown): boolean {
  return (
    Array.isArray(agents) &&
    agents.some(
      (agent) =>
        (agent as AgentInfo)?.mode === "subagent" &&
        Array.isArray((agent as AgentInfo).permissions) &&
        (agent as AgentInfo).permissions!.some(
          (rule) => ORCHESTRATED_ACTIONS.has(rule?.action ?? "") && (rule.effect === "deny" || rule.effect === "ask")
        )
    )
  );
}

export class HostSkillPolicy {
  private readonly domain: AgentDomainLike | undefined;
  private readonly ttl: number;
  private until = 0;
  private roster: AgentInfo[] | null = null;
  private pending: Promise<AgentInfo[] | null> | null = null;
  private generation = 0;

  constructor(agentDomain?: AgentDomainLike, ttl = 3000) {
    this.domain = agentDomain;
    this.ttl = ttl;
  }

  async list(): Promise<AgentInfo[] | null> {
    if (typeof this.domain?.list !== "function") return null;
    if (Date.now() < this.until) return this.roster;
    if (this.pending) return this.pending;
    const listFn = this.domain.list.bind(this.domain);
    const gen = this.generation;
    const run = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          Promise.resolve().then(() => listFn()),
          new Promise<undefined>((resolve) => {
            timer = setTimeout(() => resolve(undefined), 900);
            timer.unref?.();
          }),
        ]);
        const normalized = normalizeAgentList(result);
        if (gen === this.generation) {
          this.roster = normalized;
          this.until = Date.now() + this.ttl;
        }
        return normalized;
      } catch {
        if (gen === this.generation) {
          this.until = Date.now() + Math.min(this.ttl, 500);
        }
        return gen === this.generation ? this.roster : null;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    })();
    this.pending = run;
    try {
      return await run;
    } finally {
      if (this.pending === run) this.pending = null;
    }
  }

  async forAgent(agentId?: string): Promise<{ roster: AgentInfo[] | null; policy: PermissionRule[] | null }> {
    if (typeof agentId !== "string" || !agentId) return { roster: await this.list(), policy: null };
    const roster = await this.list();
    const agent = roster?.find((item) => item.id === agentId);
    return { roster, policy: Array.isArray(agent?.permissions) ? agent.permissions : null };
  }

  clear(): void {
    this.generation++;
    this.roster = null;
    this.until = 0;
    this.pending = null;
  }
}

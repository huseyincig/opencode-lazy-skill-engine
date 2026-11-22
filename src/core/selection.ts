/** Host-neutral, role-aware skill binding policy. Never reads skill bodies. */
import { fold, tokenize } from "./text.js";
import type { SkillEntry } from "./scanner.js";
import type { RoleConfig } from "./config.js";
import type { SearchHit } from "./rank.js";

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const BIND_MODES = new Set(["off", "workers", "all"]);
const DEFAULT_MAX = 3;
const ORIGIN_BONUS: Record<string, number> = { project: 1.08, global: 1.03, bundled: 1, host: 1 };
const uniq = (x: string[]): string[] => [...new Set(x)];
const idList = (x: unknown): string[] =>
  Array.isArray(x) ? uniq(x.filter((s): s is string => typeof s === "string" && ID.test(s) && s.length <= 64)).slice(0, 128) : [];

export interface ScoredCandidate {
  id: string;
  raw: number;
  score: number;
  coverage: number;
  origin: SkillEntry["origin"];
}

export interface BindingPlan {
  ids: string[];
  source: "task" | "explicit" | "router" | "default" | "semantic" | "none";
  missingRequired: string[];
  missingExplicit: string[];
  deniedRequired?: string[];
  scores: ScoredCandidate[];
}

export function extractExplicit(text = "", maxChars = 12000): string[] {
  if (typeof text !== "string") return [];
  return uniq(
    [...text.slice(0, maxChars).matchAll(/\bskill\s*:\s*([a-z0-9]+(?:-[a-z0-9]+)*)\b/gi)]
      .map((m) => (m[1] ?? "").toLowerCase())
      .filter((id) => id.length > 0 && id.length <= 64)
  ).slice(0, 128);
}

export function negativeTriggerMatch(text: string, skill?: Pick<SkillEntry, "negativeTriggers"> | null): boolean {
  if (!Array.isArray(skill?.negativeTriggers) || !skill.negativeTriggers.length) return false;
  const foldedText = fold(text);
  const input = new Set(tokenize(text, true));
  const normalized = ` ${foldedText.replace(/[^\p{L}\p{M}\p{N}]+/gu, " ").trim()} `;
  const compactText = foldedText.replace(/\s+/g, "");
  for (const raw of skill.negativeTriggers.slice(0, 64)) {
    if (typeof raw !== "string" || raw.length > 200) continue;
    const words = tokenize(raw, true);
    if (!words.length) continue;
    if (words.length === 1 && input.has(words[0]!)) return true;
    if (words.length > 1 && normalized.includes(` ${words.join(" ")} `)) return true;
    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(raw) && compactText.includes(fold(raw).replace(/\s+/g, ""))) {
      return true;
    }
  }
  return false;
}

export function automaticCandidates({
  available = [],
  roleName,
  role,
  projectAutoBind = false,
  generic = false,
  vaultAutoBind = false,
  genericAllowed = [],
  hostAllowed = null,
}: {
  available?: SkillEntry[];
  roleName?: string | undefined;
  role?: RoleConfig | undefined;
  projectAutoBind?: boolean;
  generic?: boolean;
  vaultAutoBind?: boolean;
  genericAllowed?: string[];
  hostAllowed?: Set<string> | null;
}): Set<string> {
  const all = new Map(available.map((s) => [s.id, s]));
  const explicitlyAllowed = idList(genericAllowed);
  const allowed = generic
    ? available
        .filter(
          (s) =>
            (s.scope === "native" || (vaultAutoBind && s.scope === "vault" && (s.origin !== "project" || projectAutoBind))) &&
            (!explicitlyAllowed.length || explicitlyAllowed.includes(s.id))
        )
        .map((s) => s.id)
    : idList(role?.allowed).filter((id) => all.has(id));

  if (projectAutoBind && typeof roleName === "string") {
    for (const skill of available) {
      if (skill.origin === "project" && Array.isArray(skill.roles) && skill.roles.includes(roleName) && !allowed.includes(skill.id)) {
        allowed.push(skill.id);
      }
    }
  }
  return new Set(allowed.filter((id) => (vaultAutoBind || all.get(id)?.scope !== "vault") && (!hostAllowed || hostAllowed.has(id))));
}

export function selectBindings({
  available = [],
  promptText = "",
  requiredSkills = [],
  roleName,
  role,
  autoBind = "off",
  isWorker = false,
  projectAutoBind = false,
  ranked = [],
  minScore = 1.2,
  maxActive = DEFAULT_MAX,
  generic = false,
  vaultAutoBind = false,
  genericAllowed = [],
  hostAllowed = null,
  minCoverage = 0,
  maxPromptChars = 12000,
  bindExplicit = true,
}: {
  available?: SkillEntry[];
  promptText?: string;
  requiredSkills?: string[];
  roleName?: string | undefined;
  role?: RoleConfig | undefined;
  autoBind?: "off" | "workers" | "all";
  isWorker?: boolean;
  projectAutoBind?: boolean;
  ranked?: SearchHit[];
  minScore?: number;
  maxActive?: number;
  generic?: boolean;
  vaultAutoBind?: boolean;
  genericAllowed?: string[];
  hostAllowed?: Set<string> | null;
  minCoverage?: number;
  maxPromptChars?: number;
  bindExplicit?: boolean;
} = {}): BindingPlan {
  const byId = new Map(available.map((s) => [s.id, s]));
  const required = idList(requiredSkills);
  const explicit = extractExplicit(promptText, maxPromptChars);
  const missingRequired = required.filter((id) => !byId.has(id));
  const missingExplicit = explicit.filter((id) => !byId.has(id));
  const existExplicit = explicit.filter((id) => byId.has(id));
  const mode = BIND_MODES.has(autoBind) ? autoBind : "off";
  const autoPermitted = mode === "all" || (mode === "workers" && isWorker);

  if (missingRequired.length) return { ids: [], source: "task", missingRequired, missingExplicit, scores: [] };
  if (required.length) {
    if (hostAllowed) {
      const deniedRequired = required.filter((id) => !hostAllowed.has(id));
      if (deniedRequired.length) {
        return { ids: [], source: "task", missingRequired, missingExplicit, deniedRequired, scores: [] };
      }
    }
    let extra = hostAllowed ? existExplicit.filter((id) => hostAllowed.has(id)) : existExplicit;
    if (!bindExplicit) {
      const candidates = autoPermitted
        ? automaticCandidates({ available, roleName, role, projectAutoBind, generic, vaultAutoBind, genericAllowed, hostAllowed })
        : new Set<string>();
      extra = extra.filter((id) => candidates.has(id));
    }
    return { ids: uniq([...required, ...extra]), source: "task", missingRequired, missingExplicit, scores: [] };
  }
  if (explicit.length && bindExplicit) {
    const allowedExplicit = hostAllowed ? existExplicit.filter((id) => hostAllowed.has(id)) : existExplicit;
    return { ids: allowedExplicit, source: allowedExplicit.length ? "explicit" : "none", missingRequired, missingExplicit, scores: [] };
  }
  if (!autoPermitted) return { ids: [], source: "none", missingRequired, missingExplicit, scores: [] };
  const candidateIds = automaticCandidates({
    available,
    roleName,
    role,
    projectAutoBind,
    generic,
    vaultAutoBind,
    genericAllowed,
    hostAllowed,
  });
  if (candidateIds.size === 0) return { ids: [], source: "none", missingRequired, missingExplicit, scores: [] };
  if (explicit.length) {
    const allowedExplicit = existExplicit.filter((id) => candidateIds.has(id));
    if (allowedExplicit.length) return { ids: allowedExplicit, source: "explicit", missingRequired, missingExplicit, scores: [] };
  }
  const limit = Math.max(1, Math.min(8, Number.isInteger(role?.maxActive) ? role!.maxActive : maxActive));
  const scored: ScoredCandidate[] = ranked
    .filter((h) => candidateIds.has(h.skill?.id) && !negativeTriggerMatch(promptText, h.skill))
    .map((h) => ({
      id: h.skill.id,
      raw: h.score,
      score: h.score * (ORIGIN_BONUS[h.skill.origin] ?? 1),
      coverage: h.coverage ?? 0,
      origin: h.skill.origin,
    }));
  scored.sort((a, b) => b.score - a.score || b.coverage - a.coverage || a.id.localeCompare(b.id));
  const lexical = scored.filter((h) => h.raw >= minScore && h.coverage >= minCoverage).slice(0, limit);
  if (lexical.length) return { ids: lexical.map((h) => h.id), source: "router", missingRequired, missingExplicit, scores: scored.slice(0, 16) };
  const defaults = idList(role?.default)
    .filter((id) => candidateIds.has(id) && !negativeTriggerMatch(promptText, byId.get(id)))
    .slice(0, limit);
  if (defaults.length) return { ids: defaults, source: "default", missingRequired, missingExplicit, scores: scored.slice(0, 16) };
  return { ids: [], source: "none", missingRequired, missingExplicit, scores: scored.slice(0, 16) };
}

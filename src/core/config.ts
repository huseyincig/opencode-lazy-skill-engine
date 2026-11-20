import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { LANGUAGES, type LanguageCode } from "./concepts.js";

export type FieldWeightKey = "id" | "name" | "keywords" | "aliases" | "tags" | "triggers" | "description";

export interface RoleConfig {
  allowed: string[];
  default: string[];
  maxActive: number;
}

export interface SingleAgentConfig {
  readonly allowed: string[];
  readonly maxActive: number;
  readonly minScore: number;
  readonly minCoverage: number;
}

export interface SemanticConfig {
  readonly enabled: boolean;
  readonly model: string;
  readonly timeoutMs: number;
  readonly maxCandidates: number;
}

export interface LazySkillOptions {
  readonly project: string;
  readonly roots: string[];
  readonly includeNative: boolean;
  readonly nativeCatalog: "preserve" | "compact" | "hide";
  readonly coexistence: "respect" | "augment";
  readonly respectHostPermissions: boolean;
  readonly searchDetail: "ids" | "summary" | "full";
  readonly autoBind: "off" | "workers" | "all" | "adaptive";
  readonly mode: "auto" | "single" | "orchestrator";
  readonly singleAgent: SingleAgentConfig;
  readonly roles: Record<string, RoleConfig>;
  readonly projectAutoBind: boolean;
  readonly vaultAutoBind: boolean;
  readonly bindExplicit: boolean;
  readonly minAutoScore: number;
  readonly maxAutoSkills: number;
  readonly semantic: SemanticConfig;
  readonly hints: "off" | "hint";
  readonly language: LanguageCode | "auto";
  readonly maxHints: number;
  readonly minHintCoverage: number;
  readonly maxResults: number;
  readonly refreshMs: number;
  readonly maxSkills: number;
  readonly maxDepth: number;
  readonly maxSkillBytes: number;
  readonly maxResourceBytes: number;
  readonly maxFrontmatterBytes: number;
  readonly sessionTtlMs: number;
  readonly maxSessions: number;
  readonly maxPromptChars: number;
  readonly compactDescriptionChars: number;
  readonly agents: string[];
  readonly rules: Record<string, string[]>;
  readonly weights: Record<FieldWeightKey, number>;
  readonly exclude: Set<string>;
}

const clampInt = (v: unknown, fallback: number, min: number, max: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.max(min, Math.min(max, Math.trunc(v))) : fallback;

const nonempty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const arrayOfStrings = (v: unknown): string[] => (Array.isArray(v) ? v.filter(nonempty).map((s) => s.trim()) : []);
const SKILL_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const cleanIds = (values: unknown): string[] =>
  [...new Set(arrayOfStrings(values).filter((id) => SKILL_ID.test(id) && id.length <= 64))].slice(0, 128);

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v && typeof v === "object" && !Array.isArray(v));
}

function roleOptions(input: unknown): Record<string, RoleConfig> {
  const result = Object.create(null) as Record<string, RoleConfig>;
  if (!isRecord(input)) return result;
  for (const [role, raw] of Object.entries(input).slice(0, 64)) {
    if (!/^[a-z][a-z0-9-]{0,62}$/.test(role) || !isRecord(raw)) continue;
    result[role] = {
      allowed: cleanIds(raw.allowed),
      default: cleanIds(raw.default),
      maxActive: clampInt(raw.maxActive, 3, 1, 8),
    };
  }
  return result;
}

export function configure(options: unknown = {}, location: unknown = {}): LazySkillOptions {
  if (!isRecord(options)) throw new TypeError("Plugin options must be an object");
  const loc = isRecord(location) ? location : {};
  const locProject = isRecord(loc.project) ? loc.project : {};
  const project =
    (typeof locProject.canonical === "string" && locProject.canonical) ||
    (typeof locProject.directory === "string" && locProject.directory) ||
    (typeof loc.directory === "string" && loc.directory) ||
    process.cwd();

  const globalRoot = join(homedir(), ".config", "opencode", "skill-vault");
  const vaultRoots = [globalRoot, join(project, ".opencode", "skill-vault")];
  for (const root of arrayOfStrings(options.roots)) {
    const expanded = root === "~" ? homedir() : root.startsWith("~/") ? join(homedir(), root.slice(2)) : root;
    vaultRoots.push(isAbsolute(expanded) ? resolve(expanded) : resolve(project, expanded));
  }

  const hints = options.hints === "hint" ? "hint" : "off";
  const nativeCatalog =
    options.nativeCatalog === "compact" || options.nativeCatalog === "hide" ? options.nativeCatalog : "preserve";
  const weightKeys: FieldWeightKey[] = ["id", "name", "keywords", "aliases", "tags", "triggers", "description"];
  const rawWeights = isRecord(options.weights)
    ? Object.fromEntries(
        Object.entries(options.weights).filter(
          ([k, v]) => weightKeys.includes(k as FieldWeightKey) && typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 20
        )
      )
    : {};
  const weights: Record<FieldWeightKey, number> = {
    id: 7,
    name: 6,
    keywords: 5,
    aliases: 4,
    tags: 3,
    triggers: 5,
    description: 1.8,
    ...rawWeights,
  };

  const rules: Record<string, string[]> = {};
  if (isRecord(options.rules)) {
    for (const [id, words] of Object.entries(options.rules)) {
      if (/^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$/.test(id)) rules[id] = arrayOfStrings(words).slice(0, 32);
    }
  }

  const single = isRecord(options.singleAgent) ? options.singleAgent : {};
  const sem = isRecord(options.semantic) ? options.semantic : {};

  return Object.freeze({
    project: resolve(project),
    roots: [...new Set(vaultRoots.map((root) => resolve(root)))],
    includeNative: options.includeNative !== false,
    nativeCatalog,
    coexistence: options.coexistence === "augment" ? "augment" : "respect",
    respectHostPermissions: options.respectHostPermissions !== false,
    searchDetail:
      options.searchDetail === "ids" || options.searchDetail === "full" ? options.searchDetail : "summary",
    autoBind:
      options.autoBind === "off" || options.autoBind === "workers" || options.autoBind === "all"
        ? options.autoBind
        : "adaptive",
    mode: options.mode === "single" || options.mode === "orchestrator" ? options.mode : "auto",
    singleAgent: Object.freeze({
      allowed: cleanIds(single.allowed),
      maxActive: clampInt(single.maxActive, 1, 1, 8),
      minScore:
        typeof single.minScore === "number" && Number.isFinite(single.minScore)
          ? Math.max(0, Math.min(100, single.minScore))
          : 5,
      minCoverage:
        typeof single.minCoverage === "number" && Number.isFinite(single.minCoverage)
          ? Math.max(0, Math.min(1, single.minCoverage))
          : 0.55,
    }),
    roles: roleOptions(options.roles),
    projectAutoBind: options.projectAutoBind === true,
    vaultAutoBind: options.vaultAutoBind === true,
    bindExplicit: options.bindExplicit === true,
    minAutoScore:
      typeof options.minAutoScore === "number" && Number.isFinite(options.minAutoScore)
        ? Math.max(0, Math.min(100, options.minAutoScore))
        : 1.2,
    maxAutoSkills: clampInt(options.maxAutoSkills, 3, 1, 8),
    semantic: Object.freeze({
      enabled: sem.enabled === true,
      model: typeof sem.model === "string" ? sem.model.slice(0, 160) : "",
      timeoutMs: clampInt(sem.timeoutMs, 1500, 50, 5000),
      maxCandidates: clampInt(sem.maxCandidates, 40, 1, 120),
    }),
    hints,
    language:
      typeof options.language === "string" && LANGUAGES.includes(options.language as LanguageCode)
        ? (options.language as LanguageCode)
        : "auto",
    maxHints: clampInt(options.maxHints, 2, 0, 5),
    minHintCoverage:
      typeof options.minHintCoverage === "number" && options.minHintCoverage >= 0 && options.minHintCoverage <= 1
        ? options.minHintCoverage
        : 0.65,
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

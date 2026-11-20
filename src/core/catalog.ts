import { scanVaults, parseFrontmatter, type CachedFrontmatter, type ScanDiagnostic, type SkillEntry } from "./scanner.js";
import { createSearchIndex, search, type SearchHit, type SearchIndex, type SearchOptions } from "./rank.js";
import { clipped } from "./text.js";
import { LANGUAGES, type LanguageCode } from "./concepts.js";
import { inside } from "./security.js";
import { existsSync, realpathSync } from "node:fs";
import { resolve, join } from "node:path";
import type { LazySkillOptions } from "./config.js";

const safeReal = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};
const hasProjectNative = (projectOpenCode: string, id: string): boolean =>
  existsSync(join(projectOpenCode, "skills", id, "SKILL.md")) || existsSync(join(projectOpenCode, "skill", id, "SKILL.md"));

export interface RawNativeSkill {
  id: string;
  name?: string;
  description?: string;
  content?: string;
  path?: string;
  autoinvoke?: boolean;
  [key: string]: unknown;
}

export interface SkillDomainLike {
  list?: () => Promise<unknown> | unknown;
}

export interface CatalogStatus {
  skills: number;
  native: number;
  vault: number;
  local: number;
  global: number;
  conflicts: number;
  conflictIds: string[];
  ready: "ready" | "degraded" | "partial";
  version: number;
  metadataCache: { metadataReads: number; metadataReuses: number };
  diagnostics: ScanDiagnostic[];
}

export function normalizeNative(
  result: unknown,
  opts: Pick<LazySkillOptions, "project" | "exclude" | "maxFrontmatterBytes" | "rules">
): SkillEntry[] {
  const resObj = result && typeof result === "object" && !Array.isArray(result) ? (result as Record<string, unknown>) : null;
  const raw = Array.isArray(result) ? result : resObj?.skills ?? resObj?.items ?? resObj?.data ?? [];
  if (!Array.isArray(raw)) throw new Error("Unexpected ctx.skill.list() response");
  const projectOpenCode = safeReal(join(opts.project, ".opencode"));

  return raw
    .filter((s): s is RawNativeSkill => Boolean(s && typeof s === "object" && typeof (s as RawNativeSkill).id === "string" && !opts.exclude.has((s as RawNativeSkill).id)))
    .map((s) => {
      const meta =
        typeof s.content === "string"
          ? parseFrontmatter(s.content.slice(0, opts.maxFrontmatterBytes + 16), opts.maxFrontmatterBytes).meta
          : {};
      const values = (key: string): string[] => {
        const direct = s[key];
        if (Array.isArray(direct)) return direct.filter((x): x is string => typeof x === "string");
        const fmVal = meta[key];
        if (Array.isArray(fmVal)) return fmVal;
        if (typeof fmVal === "string" && fmVal) return [fmVal];
        return [];
      };
      const origin: SkillEntry["origin"] =
        (typeof s.path === "string" && inside(projectOpenCode, safeReal(s.path))) || hasProjectNative(projectOpenCode, s.id)
          ? "project"
          : "host";
      const rawDescription =
        typeof s.description === "string" && s.description.trim()
          ? s.description
          : typeof meta.description === "string" && meta.description.trim()
            ? meta.description
            : typeof s.name === "string" && s.name.trim()
              ? s.name
              : "";
      return {
        id: s.id,
        name: clipped(s.name ?? s.id, 100),
        description: clipped(rawDescription, 700),
        keywords: [...new Set([...(opts.rules[s.id] || []), ...values("keywords")])].slice(0, 64),
        aliases: [
          ...new Set([
            ...values("aliases"),
            ...LANGUAGES.flatMap((lang) => [
              ...values(`keywords_${lang}`),
              ...values(`keywords-${lang}`),
              ...values(`name_${lang}`),
              ...values(`description_${lang}`),
            ]),
          ]),
        ].slice(0, 90),
        tags: values("tags").slice(0, 64),
        triggers: values("triggers").slice(0, 64),
        negativeTriggers: values("negativeTriggers").slice(0, 64),
        languages: values("languages").filter((x): x is LanguageCode => LANGUAGES.includes(x as LanguageCode)).slice(0, 13),
        roles: values("roles").slice(0, 64),
        scope: "native",
        origin,
        source: "native",
        path: typeof s.path === "string" ? s.path : null,
        base: null,
        trust: "native",
        autoinvoke: s.autoinvoke !== false,
      };
    });
}

export class Catalog {
  private readonly ctx: { skill?: SkillDomainLike };
  private readonly opts: LazySkillOptions;
  public index: SearchIndex;
  public items = new Map<string, SkillEntry>();
  public next = 0;
  private inflight: Promise<this> | null = null;
  public diagnostics: ScanDiagnostic[] = [];
  public version = 0;
  public nativeReady: boolean;
  private readonly metaCache = new Map<string, CachedFrontmatter>();
  public scanStats = { metadataReads: 0, metadataReuses: 0 };
  public conflictIds: string[] = [];
  public originals?: Map<string, string>;

  constructor(ctx: { skill?: SkillDomainLike }, opts: LazySkillOptions) {
    this.ctx = ctx;
    this.opts = opts;
    this.index = createSearchIndex([], opts.weights);
    this.nativeReady = !opts.includeNative;
  }

  invalidate(): void {
    this.next = 0;
  }

  async refresh(force = false): Promise<this> {
    const now = Date.now();
    if (!force && this.next > now) return this;
    if (this.inflight) {
      await this.inflight;
      if (!force) return this;
    }
    this.inflight = (async () => {
      const { skills: vault, conflictIds: vaultConflicts = [], diagnostics, metadataReads, metadataReuses } = await scanVaults(
        this.opts,
        this.metaCache,
        force
      );
      let native: SkillEntry[] = [];
      if (this.opts.includeNative) {
        try {
          native = normalizeNative(await this.ctx.skill?.list?.(), this.opts);
          this.nativeReady = true;
          if (this.originals) {
            for (const s of native) {
              if (this.originals.has(s.id)) s.description = this.originals.get(s.id)!;
              else this.originals.set(s.id, s.description);
            }
          }
        } catch (e) {
          this.nativeReady = false;
          diagnostics.push({ root: "native", error: String((e as Error)?.message || e) });
          native = [...this.items.values()].filter((s) => s.scope === "native");
        }
      }
      const conflicts = new Set(vaultConflicts);
      const vaultIds = new Set(vault.map((s) => s.id));
      const seenNativeIds = new Set<string>();
      for (const skill of native) {
        if (vaultIds.has(skill.id) || seenNativeIds.has(skill.id)) conflicts.add(skill.id);
        seenNativeIds.add(skill.id);
      }
      this.conflictIds = [...conflicts].sort();
      const all = new Map<string, SkillEntry>();
      for (const skill of vault) all.set(skill.id, skill);
      for (const skill of native) all.set(skill.id, skill);
      const sorted = [...all.values()].sort((a, b) => a.id.localeCompare(b.id));
      this.items = all;
      this.index = createSearchIndex(sorted, this.opts.weights);
      this.scanStats = { metadataReads, metadataReuses };
      this.diagnostics = diagnostics.slice(0, 30);
      this.next = Date.now() + this.opts.refreshMs;
      this.version++;
      return this;
    })();
    try {
      return await this.inflight;
    } finally {
      this.inflight = null;
    }
  }

  async get(id: string): Promise<SkillEntry | undefined> {
    await this.refresh();
    return this.items.get(id);
  }

  async search(query: string, opts: SearchOptions = {}): Promise<SearchHit[]> {
    await this.refresh(opts.force);
    return search(this.index, query, {
      topK: opts.topK ?? this.opts.maxResults,
      ...(opts.scope !== undefined ? { scope: opts.scope } : {}),
      ...(opts.allowedIds !== undefined ? { allowedIds: opts.allowedIds } : {}),
      ...(opts.respectNegativeTriggers !== undefined ? { respectNegativeTriggers: opts.respectNegativeTriggers } : {}),
      ...(opts.preferFullCoverage !== undefined ? { preferFullCoverage: opts.preferFullCoverage } : {}),
    });
  }

  async status(): Promise<CatalogStatus> {
    await this.refresh();
    const list = [...this.items.values()];
    const local = list.filter((s) => s.origin === "project").length;
    const global = list.filter((s) => s.origin !== "project").length;
    const ready: CatalogStatus["ready"] = !this.nativeReady ? "partial" : this.diagnostics.length > 0 ? "degraded" : "ready";
    return {
      skills: this.items.size,
      native: list.filter((s) => s.scope === "native").length,
      vault: list.filter((s) => s.scope === "vault").length,
      local,
      global,
      conflicts: this.conflictIds.length,
      conflictIds: this.conflictIds.slice(0, 20),
      ready,
      version: this.version,
      metadataCache: this.scanStats,
      diagnostics: this.diagnostics,
    };
  }
}

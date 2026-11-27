import {
  scanVaults,
  parseFrontmatter,
  extractDerivedSignals,
  readSidecarSync,
  type CachedFrontmatter,
  type ScanDiagnostic,
  type SkillEntry,
} from "./scanner.js";
import { createSearchIndex, search, type SearchHit, type SearchIndex, type SearchOptions } from "./rank.js";
import { clipped } from "./text.js";
import { LANGUAGES, type LanguageCode } from "./concepts.js";
import { inside } from "./security.js";
import { hashSkillContent } from "./reuse.js";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, resolve, join } from "node:path";
import type { LazySkillOptions } from "./config.js";

function catalogFingerprint(sorted: readonly SkillEntry[]): string {
  const hash = createHash("sha1");
  for (const s of sorted) {
    hash
      .update(s.id)
      .update("\0")
      .update(s.name)
      .update("\0")
      .update(s.description)
      .update("\0")
      .update(s.scope)
      .update("\0")
      .update(s.origin)
      .update("\0")
      .update(s.autoinvoke === false ? "0" : "1")
      .update("\0")
      .update(s.path ?? "")
      .update("\0")
      .update(s.keywords.join("\x1f"))
      .update("\0")
      .update(s.aliases.join("\x1f"))
      .update("\0")
      .update(s.tags.join("\x1f"))
      .update("\0")
      .update(s.triggers.join("\x1f"))
      .update("\0")
      .update(s.negativeTriggers.join("\x1f"))
      .update("\0")
      .update(s.languages.join("\x1f"))
      .update("\0")
      .update(s.roles.join("\x1f"))
      .update("\0")
      .update((s.derivedKeywords ?? []).join("\x1f"))
      .update("\0")
      .update((s.derivedAliases ?? []).join("\x1f"))
      .update("\0")
      .update(s.contentHash ?? "")
      .update("\n");
  }
  return hash.digest("hex");
}

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
      const parsed =
        typeof s.content === "string"
          ? parseFrontmatter(s.content.slice(0, opts.maxFrontmatterBytes + 16), opts.maxFrontmatterBytes)
          : { meta: {}, body: "" };
      const meta = parsed.meta;
      const skillDir =
        typeof s.path === "string" && s.path.trim()
          ? basename(s.path) === "SKILL.md"
            ? dirname(s.path)
            : existsSync(join(s.path, "SKILL.md"))
              ? s.path
              : null
          : null;
      const sidecar = skillDir ? readSidecarSync(skillDir, opts.maxFrontmatterBytes) : undefined;
      const values = (key: string): string[] => {
        const direct = s[key];
        const out: string[] = [];
        if (Array.isArray(direct)) out.push(...direct.filter((x): x is string => typeof x === "string"));
        const fmVal = meta[key];
        if (Array.isArray(fmVal)) out.push(...fmVal);
        else if (typeof fmVal === "string" && fmVal) out.push(fmVal);
        const scVal = sidecar && Object.hasOwn(sidecar, key) ? (sidecar as Record<string, unknown>)[key] : undefined;
        if (Array.isArray(scVal)) out.push(...scVal.filter((x): x is string => typeof x === "string"));
        return [...new Set(out)];
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
      const description = clipped(rawDescription, 700);
      const keywords = [...new Set([...(opts.rules[s.id] || []), ...values("keywords")])].slice(0, 64);
      const triggers = values("triggers").slice(0, 64);
      const derived =
        keywords.length === 0 && triggers.length === 0 ? extractDerivedSignals(description, parsed.body.slice(0, 2048)) : null;
      return {
        id: s.id,
        name: clipped(s.name ?? s.id, 100),
        description,
        keywords,
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
        triggers,
        negativeTriggers: values("negativeTriggers").slice(0, 64),
        languages: values("languages").filter((x): x is LanguageCode => LANGUAGES.includes(x as LanguageCode)).slice(0, 13),
        roles: values("roles").slice(0, 64),
        ...(derived?.derivedKeywords.length ? { derivedKeywords: derived.derivedKeywords } : {}),
        ...(derived?.derivedAliases.length ? { derivedAliases: derived.derivedAliases } : {}),
        scope: "native",
        origin,
        source: "native",
        path: typeof s.path === "string" ? s.path : null,
        base: null,
        trust: "native",
        autoinvoke: s.autoinvoke !== false,
        ...(typeof s.content === "string" && s.content.length > 0 ? { contentHash: hashSkillContent(s.content) } : {}),
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
  private invalidationGen = 0;
  public diagnostics: ScanDiagnostic[] = [];
  public version = 0;
  private fingerprint = "";
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
    this.invalidationGen++;
    this.next = 0;
  }

  async refresh(force = false): Promise<this> {
    const now = Date.now();
    if (!force && this.next > now) return this;
    if (this.inflight) {
      await this.inflight;
      if (!force && this.next > Date.now()) return this;
    }
    const startGen = this.invalidationGen;
    const run = (async () => {
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
              if (this.originals.has(s.id)) {
                const origDesc = this.originals.get(s.id)!;
                if (origDesc !== s.description) {
                  s.description = origDesc;
                  if (s.keywords.length === 0 && s.triggers.length === 0) {
                    const reDerived = extractDerivedSignals(origDesc);
                    const mergedKw = [...new Set([...reDerived.derivedKeywords, ...(s.derivedKeywords ?? [])])].slice(0, 32);
                    const mergedAl = [...new Set([...reDerived.derivedAliases, ...(s.derivedAliases ?? [])])].slice(0, 16);
                    if (mergedKw.length) s.derivedKeywords = mergedKw;
                    if (mergedAl.length) s.derivedAliases = mergedAl;
                  }
                }
              } else {
                this.originals.set(s.id, s.description);
              }
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
      const nextFingerprint = catalogFingerprint(sorted);
      this.items = all;
      if (force || this.version === 0 || nextFingerprint !== this.fingerprint) {
        this.index = createSearchIndex(sorted, this.opts.weights);
        this.fingerprint = nextFingerprint;
        this.version++;
      }
      this.scanStats = { metadataReads, metadataReuses };
      this.diagnostics = diagnostics.slice(0, 30);
      this.next = this.nativeReady && this.invalidationGen === startGen ? Date.now() + this.opts.refreshMs : 0;
      return this;
    })();
    this.inflight = run;
    try {
      return await run;
    } finally {
      if (this.inflight === run) this.inflight = null;
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

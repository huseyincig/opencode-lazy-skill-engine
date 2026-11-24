import { readdir, lstat, realpath } from "node:fs/promises";
import { constants as fsConstants, fstatSync, lstatSync, openSync, readSync, closeSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { inside, peekMetadata, safeRead } from "./security.js";
import { clipped } from "./text.js";
import { LANGUAGES, type LanguageCode } from "./concepts.js";
import type { LazySkillOptions } from "./config.js";

const GLOBAL_VAULT_ROOT = resolve(join(homedir(), ".config", "opencode", "skill-vault"));

const ignored = new Set([".git", ".hg", ".svn", "node_modules", ".next", "dist", "build", ".cache", "__pycache__"]);
const validID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const validRoleID = /^[a-z][a-z0-9-]{0,62}$/;
const SIDECAR_FILES = ["lazy-skill.json", "skill.meta.json"] as const;
const MAX_HEADING_PREFIX_CHARS = 2048;
const MAX_HEADING_LINES = 40;
const utf8Fatal = new TextDecoder("utf-8", { fatal: true });
const BOILERPLATE_HEADINGS = new Set([
  "overview",
  "when to use",
  "usage",
  "example",
  "examples",
  "reference",
  "references",
  "note",
  "notes",
  "summary",
  "introduction",
  "intro",
  "prerequisites",
  "checklist",
  "verification checklist",
  "red flags",
  "sources",
  "table of contents",
  "related skills",
  "see also",
]);

export type FrontmatterValue = string | string[];
export type FrontmatterMeta = Record<string, FrontmatterValue>;

export interface SidecarMeta {
  keywords?: string[];
  aliases?: string[];
  tags?: string[];
  triggers?: string[];
  negativeTriggers?: string[];
  languages?: LanguageCode[];
  roles?: string[];
}

export interface DerivedSignals {
  derivedKeywords: string[];
  derivedAliases: string[];
}

export interface SkillEntry {
  id: string;
  name: string;
  description: string;
  keywords: string[];
  aliases: string[];
  tags: string[];
  triggers: string[];
  negativeTriggers: string[];
  languages: LanguageCode[];
  roles: string[];
  derivedKeywords?: string[];
  derivedAliases?: string[];
  origin: "project" | "global" | "host" | "bundled";
  path: string | null;
  base: string | null;
  root?: string | null;
  scope: "native" | "vault";
  priority?: number;
  source: "native" | "vault";
  trust: "native" | "untrusted";
  autoinvoke?: boolean;
}

export interface ScanDiagnostic {
  root: string;
  error: string;
}

export interface CachedFrontmatter {
  stamp: string;
  meta: FrontmatterMeta;
  bodyPrefix?: string;
  sidecar?: SidecarMeta;
}

export interface ScanVaultResult {
  skills: SkillEntry[];
  conflictIds: string[];
  diagnostics: ScanDiagnostic[];
  metadataReads: number;
  metadataReuses: number;
}

function disallowedYaml(v: string): boolean {
  const t = v.trim();
  return t.startsWith("&") || t.startsWith("*") || t.startsWith("!");
}

function stripInlineComment(v: string): string {
  let quote: string | null = null;
  for (let i = 0; i < v.length; i++) {
    const ch = v[i]!;
    if (quote === '"') {
      if (ch === "\\" && i + 1 < v.length) {
        i++;
        continue;
      }
      if (ch === '"') quote = null;
    } else if (quote === "'") {
      if (ch === "'" && v[i + 1] === "'") {
        i++;
        continue;
      }
      if (ch === "'") quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "#" && (i === 0 || /\s/.test(v[i - 1] ?? ""))) {
      return v.slice(0, i).trim();
    }
  }
  return v.trim();
}

function scalar(v: string): string {
  const x = stripInlineComment(v);
  if ((x.startsWith('"') && x.endsWith('"')) || (x.startsWith("'") && x.endsWith("'"))) {
    return x.slice(1, -1).replace(/\\(["'\\])/g, "$1");
  }
  return x;
}

function list(v: string): string[] {
  const s = stripInlineComment(v);
  if (s.startsWith("[") && s.endsWith("]")) {
    return s
      .slice(1, -1)
      .split(/,(?=(?:[^"']|"[^"]*"|'[^']*')*$)/)
      .map(scalar)
      .filter((x) => x && !disallowedYaml(x));
  }
  return s && !disallowedYaml(s) ? [scalar(s)] : [];
}

/** Intentionally bounded YAML frontmatter parser; no YAML tags, anchors or execution. */
export function parseFrontmatter(data: string, maxFrontmatterBytes = 8192): { meta: FrontmatterMeta; body: string } {
  const src = typeof data === "string" && data.charCodeAt(0) === 0xfeff ? data.slice(1) : data;
  const open = /^---[ \t]*\r?\n/.exec(src);
  if (!open) return { meta: {}, body: src };
  const immediate = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(src.slice(open[0].length));
  if (immediate) return { meta: {}, body: src.slice(open[0].length + immediate[0].length) };
  const marker = /\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/g;
  marker.lastIndex = open[0].length;
  const match = marker.exec(src);
  if (!match || match.index > maxFrontmatterBytes) return { meta: {}, body: src };
  const fm = src.slice(open[0].length, match.index);
  const body = src.slice(match.index + match[0].length);
  const meta: FrontmatterMeta = {};
  let current: string | null = null;
  let block = false;
  for (const line of fm.split(/\r?\n/)) {
    const kv = /^([a-zA-Z][\w/-]*):\s*(.*)$/.exec(line);
    if (kv) {
      current = kv[1] ?? null;
      const raw = stripInlineComment(kv[2] ?? "");
      block = /^[|>][+-]?$/.test(raw);
      if (block && current) {
        meta[current] = "";
        continue;
      }
      if (disallowedYaml(raw)) {
        current = null;
        continue;
      }
      if (current) {
        meta[current] = raw.startsWith("[") && raw.endsWith("]") ? list(raw) : scalar(raw);
      }
      continue;
    }
    if (current && /^\s+-\s+/.test(line) && !block) {
      const item = stripInlineComment(line.replace(/^\s+-\s+/, ""));
      if (!item || disallowedYaml(item)) continue;
      const existing = meta[current];
      if (!Array.isArray(existing)) meta[current] = typeof existing === "string" && existing ? list(existing) : [];
      (meta[current] as string[]).push(scalar(item));
      continue;
    }
    if (current && /^\s+\S/.test(line)) {
      if (block) {
        meta[current] = `${typeof meta[current] === "string" ? meta[current] : ""}${meta[current] ? " " : ""}${line.trim()}`;
      } else if (typeof meta[current] === "string") {
        const part = scalar(line.trim());
        if (part) {
          meta[current] = `${meta[current]}${meta[current] ? " " : ""}${part}`;
        }
      }
    }
  }
  return { meta, body };
}

const getList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : typeof v === "string" ? list(v) : []);
function idFromPath(file: string): string {
  return basename(file) === "SKILL.md" ? basename(resolve(file, "..")) : basename(file, ".md");
}
function clippedWord(s: string): string {
  return clipped(s, 80);
}

function resolveOrigin(file: string, root: string, priority: number, opts: Pick<LazySkillOptions, "project">): "project" | "global" | "host" {
  const resolvedRoot = resolve(root);
  if (resolvedRoot === GLOBAL_VAULT_ROOT) return "global";
  if (opts?.project && (inside(resolve(opts.project), resolvedRoot) || inside(resolve(opts.project), resolve(file)))) {
    return "project";
  }
  return priority === 1 ? "project" : priority === 0 ? "global" : "host";
}

function dedupeClipped(values: readonly string[], limit: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const clean = clippedWord(raw);
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Extract bounded synthetic keyword/alias signals from standard `name + description` skills
 * without reading past `maxFrontmatterBytes` or mutating explicit frontmatter fields.
 */
export function extractDerivedSignals(description: string, bodyPrefix = ""): DerivedSignals {
  const desc = typeof description === "string" ? description.slice(0, 1200) : "";
  const rawKeywords: string[] = [];
  const rawAliases: string[] = [];

  if (desc) {
    // 1. Inline backtick code spans
    for (const m of desc.matchAll(/`([^`\r\n]{2,64})`/g)) {
      const inner = (m[1] ?? "").trim();
      if (inner && /[\p{L}\p{N}]/u.test(inner)) rawKeywords.push(inner);
    }
    // 2. Scoped packages (@scope/pkg or @scope/pkg/subpath)
    for (const m of desc.matchAll(/@[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)+/gi)) {
      rawKeywords.push(m[0]);
    }
    // 3. Dot notation identifiers (Plugin.define, model.transform, client.experimental.automation)
    for (const m of desc.matchAll(/\b[a-zA-Z_][\w$]*(?:\.[a-zA-Z_][\w$]*){1,4}\b/g)) {
      rawKeywords.push(m[0]);
    }
    // 4. camelCase / PascalCase identifiers (SyntaxStyle, CodeMode, autoBind)
    for (const m of desc.matchAll(/\b(?:[a-z]+[A-Z][a-zA-Z0-9]*|[A-Z][a-z0-9]+[A-Z][a-zA-Z0-9]*)\b/g)) {
      rawKeywords.push(m[0]);
    }
    // 5. kebab-case identifiers (supply-chain, prompt-cache, read-only)
    for (const m of desc.matchAll(/\b(?=[a-zA-Z0-9-]*[a-zA-Z])[a-zA-Z0-9]+(?:-[a-zA-Z0-9]+){1,5}\b/g)) {
      rawKeywords.push(m[0]);
    }
    // 6. UPPER_SNAKE_CASE constants (FORBIDDEN_TOOLS)
    for (const m of desc.matchAll(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g)) {
      rawKeywords.push(m[0]);
    }
    // 7. Trigger clauses ("Use when ...", "Apply when ...")
    for (const m of desc.matchAll(/\b(?:use|apply|invoke|trigger)\s+when\s+([^.\r\n;]{6,180})/gi)) {
      const clause = (m[1] ?? "").trim().replace(/^["'`]+|["'`]+$/g, "");
      if (!clause) continue;
      const colonIdx = clause.indexOf(":");
      if (colonIdx >= 6) {
        rawAliases.push(clause.slice(0, colonIdx).trim());
        const tail = clause.slice(colonIdx + 1);
        for (const part of tail.split(",").slice(0, 4)) {
          const item = part.trim();
          if (item.length >= 4 && item.length <= 64) rawAliases.push(item);
        }
      } else {
        const commaIdx = clause.indexOf(",");
        rawAliases.push(commaIdx >= 10 ? clause.slice(0, commaIdx).trim() : clause);
      }
    }
  }

  if (typeof bodyPrefix === "string" && bodyPrefix) {
    const lines = bodyPrefix.slice(0, MAX_HEADING_PREFIX_CHARS).split(/\r?\n/, MAX_HEADING_LINES);
    let inFence = false;
    let headingCount = 0;
    for (const line of lines) {
      if (/^\s*(?:```|~~~)/.test(line)) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;
      const h = /^#{1,2}[ \t]+(.+?)[ \t]*#*$/.exec(line);
      if (!h) continue;
      const clean = (h[1] ?? "")
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/[`*_~]+/g, "")
        .trim();
      if (clean.length < 3 || BOILERPLATE_HEADINGS.has(clean.toLowerCase())) continue;
      rawAliases.push(clean);
      headingCount++;
      if (headingCount >= 6) break;
    }
  }

  return {
    derivedKeywords: dedupeClipped(rawKeywords, 32),
    derivedAliases: dedupeClipped(rawAliases, 16),
  };
}

function sidecarStringList(obj: Record<string, unknown>, key: string): string[] {
  if (!Object.hasOwn(obj, key)) return [];
  const val = obj[key];
  if (!Array.isArray(val)) return [];
  return val.filter((x): x is string => typeof x === "string");
}

export function parseSidecarJson(raw: string): SidecarMeta | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const obj = parsed as Record<string, unknown>;
  const keywords = dedupeClipped(sidecarStringList(obj, "keywords"), 40);
  const aliases = dedupeClipped(sidecarStringList(obj, "aliases"), 60);
  const tags = dedupeClipped(sidecarStringList(obj, "tags"), 40);
  const triggers = dedupeClipped(sidecarStringList(obj, "triggers"), 64);
  const negativeTriggers = dedupeClipped(sidecarStringList(obj, "negativeTriggers"), 64);
  const languages = [...new Set(sidecarStringList(obj, "languages"))].filter((x): x is LanguageCode =>
    LANGUAGES.includes(x as LanguageCode)
  ).slice(0, 13);
  const roles = dedupeClipped(sidecarStringList(obj, "roles"), 64).filter((x) => validRoleID.test(x));
  return {
    ...(keywords.length ? { keywords } : {}),
    ...(aliases.length ? { aliases } : {}),
    ...(tags.length ? { tags } : {}),
    ...(triggers.length ? { triggers } : {}),
    ...(negativeTriggers.length ? { negativeTriggers } : {}),
    ...(languages.length ? { languages } : {}),
    ...(roles.length ? { roles } : {}),
  };
}

async function statSidecar(skillDir: string): Promise<{ name: (typeof SIDECAR_FILES)[number]; stamp: string } | null> {
  for (const name of SIDECAR_FILES) {
    try {
      const st = await lstat(join(skillDir, name));
      if (st.isSymbolicLink() || !st.isFile()) continue;
      return { name, stamp: `${name}:${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}` };
    } catch {
      continue;
    }
  }
  return null;
}

async function readSidecar(
  skillDir: string,
  name: string,
  maxBytes: number,
  trustedRoot: string
): Promise<SidecarMeta | undefined> {
  try {
    const raw = await safeRead(skillDir, name, maxBytes, trustedRoot);
    return parseSidecarJson(raw);
  } catch {
    return undefined;
  }
}

/** Synchronous, symlink-safe, bounded sidecar reader for native skill directories. */
export function readSidecarSync(skillDir: string, maxBytes = 8192): SidecarMeta | undefined {
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024) return undefined;
  let canonicalBase: string;
  try {
    canonicalBase = realpathSync(skillDir);
  } catch {
    return undefined;
  }
  for (const name of SIDECAR_FILES) {
    const candidate = resolve(canonicalBase, name);
    if (!inside(canonicalBase, candidate)) continue;
    try {
      const st = lstatSync(candidate);
      if (st.isSymbolicLink() || !st.isFile() || st.size > maxBytes) continue;
      const canonicalFile = realpathSync(candidate);
      if (!inside(canonicalBase, canonicalFile)) continue;
      const fd = openSync(canonicalFile, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      try {
        const fst = fstatSync(fd);
        if (!fst.isFile() || fst.size > maxBytes) continue;
        const buf = Buffer.allocUnsafe(Math.min(fst.size, maxBytes) + 1);
        let n = 0;
        while (n < buf.length) {
          const got = readSync(fd, buf, n, buf.length - n, n);
          if (!got) break;
          n += got;
        }
        if (n > maxBytes) continue;
        const bytes = buf.subarray(0, n);
        if (bytes.includes(0)) continue;
        const text = utf8Fatal.decode(bytes);
        const parsed = parseSidecarJson(text);
        if (parsed) return parsed;
      } finally {
        closeSync(fd);
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

export function normalizeEntry(
  meta: FrontmatterMeta,
  file: string,
  root: string,
  priority: number,
  opts: Pick<LazySkillOptions, "project" | "exclude" | "rules">,
  extra?: { bodyPrefix?: string; sidecar?: SidecarMeta }
): SkillEntry | null {
  const id = idFromPath(file).toLowerCase();
  if (!validID.test(id) || id.length > 64 || opts.exclude.has(id)) return null;
  const description = clipped(meta.description, 700);
  if (!description) return null;
  const nameVal = typeof meta.name === "string" && meta.name ? meta.name : id;
  const sidecar = extra?.sidecar;
  const keywords = [
    ...new Set([...getList(meta.keywords), ...(sidecar?.keywords ?? []), ...(opts.rules[id] || [])].map(clippedWord).filter(Boolean)),
  ].slice(0, 40);
  const aliases = [
    ...new Set(
      [
        ...getList(meta.aliases),
        ...(sidecar?.aliases ?? []),
        ...LANGUAGES.flatMap((lang) => [
          ...getList(meta[`keywords_${lang}`]),
          ...getList(meta[`keywords-${lang}`]),
          typeof meta[`name_${lang}`] === "string" ? meta[`name_${lang}`] : "",
          typeof meta[`description_${lang}`] === "string" ? meta[`description_${lang}`] : "",
        ]).filter((x): x is string => Boolean(x)),
      ]
        .map(clippedWord)
        .filter(Boolean)
    ),
  ].slice(0, 60);
  const tags = [...new Set([...getList(meta.tags), ...(sidecar?.tags ?? [])].map(clippedWord).filter(Boolean))].slice(0, 40);
  const triggers = [...new Set([...getList(meta.triggers), ...(sidecar?.triggers ?? [])].map(clippedWord).filter(Boolean))].slice(0, 64);
  const negativeTriggers = [
    ...new Set([...getList(meta.negativeTriggers), ...(sidecar?.negativeTriggers ?? [])].map(clippedWord).filter(Boolean)),
  ].slice(0, 64);
  const languages = [...new Set([...getList(meta.languages), ...(sidecar?.languages ?? [])])]
    .filter((x): x is LanguageCode => LANGUAGES.includes(x as LanguageCode))
    .slice(0, 13);
  const roles = [...new Set([...getList(meta.roles), ...(sidecar?.roles ?? [])].map(clippedWord))]
    .filter((x) => validRoleID.test(x))
    .slice(0, 64);
  const derived = keywords.length === 0 && triggers.length === 0 ? extractDerivedSignals(description, extra?.bodyPrefix ?? "") : null;

  return {
    id,
    name: clipped(nameVal, 100),
    description,
    keywords,
    aliases,
    tags,
    triggers,
    negativeTriggers,
    languages,
    roles,
    ...(derived?.derivedKeywords.length ? { derivedKeywords: derived.derivedKeywords } : {}),
    ...(derived?.derivedAliases.length ? { derivedAliases: derived.derivedAliases } : {}),
    origin: resolveOrigin(file, root, priority, opts),
    path: file,
    base: resolve(file, ".."),
    root,
    scope: "vault",
    priority,
    source: "vault",
    trust: "untrusted",
  };
}

export async function scanVaults(
  opts: Pick<LazySkillOptions, "roots" | "maxDepth" | "maxSkills" | "maxSkillBytes" | "maxFrontmatterBytes" | "project" | "exclude" | "rules">,
  cache: Map<string, CachedFrontmatter> = new Map(),
  force = false
): Promise<ScanVaultResult> {
  const found = new Map<string, SkillEntry>();
  const diagnostics: ScanDiagnostic[] = [];
  const vaultCounts = new Map<string, number>();
  let metadataReads = 0;
  let metadataReuses = 0;
  const visitedPaths = new Set<string>();

  for (let r = opts.roots.length - 1; r >= 0; r--) {
    const root = opts.roots[r]!;
    let realRoot: string;
    try {
      realRoot = await realpath(root);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT") diagnostics.push({ root, error: code || "READ_FAILED" });
      continue;
    }
    let visited = 0;
    async function walk(dir: string, depth: number): Promise<void> {
      if (depth > opts.maxDepth || visited > opts.maxSkills * 8) return;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (e) {
        const code = (e as NodeJS.ErrnoException)?.code;
        diagnostics.push({ root, error: code || "SCAN_FAILED" });
        return;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      if (depth > 0 && entries.some((e) => e.name === "SKILL.md" && e.isFile())) {
        entries = entries.filter((e) => e.name === "SKILL.md");
      }
      for (const e of entries) {
        if (visited > opts.maxSkills * 8) break;
        if (e.name.startsWith(".") || ignored.has(e.name) || e.isSymbolicLink()) continue;
        const p = join(dir, e.name);
        visited++;
        if (e.isDirectory()) {
          await walk(p, depth + 1);
          continue;
        }
        if (!e.isFile() || (e.name !== "SKILL.md" && !(depth === 0 && e.name.endsWith(".md")))) continue;
        const candidateId = idFromPath(p).toLowerCase();
        if (found.size >= opts.maxSkills && !found.has(candidateId)) continue;
        try {
          const st = await lstat(p);
          if (st.size > opts.maxSkillBytes || !st.isFile()) continue;
          const rp = await realpath(p);
          if (!inside(realRoot, rp)) continue;
          const sidecarStat = e.name === "SKILL.md" ? await statSidecar(resolve(rp, "..")) : null;
          const stamp = `${[st.dev, st.ino, st.size, st.mtimeMs, st.ctimeMs].join(":")}|${sidecarStat?.stamp ?? "none"}`;
          const cached = cache.get(rp);
          let meta: FrontmatterMeta;
          let bodyPrefix: string | undefined;
          let sidecar: SidecarMeta | undefined;
          if (!force && cached?.stamp === stamp) {
            meta = cached.meta;
            bodyPrefix = cached.bodyPrefix;
            sidecar = cached.sidecar;
            metadataReuses++;
          } else {
            const text = await peekMetadata(rp, opts.maxSkillBytes, opts.maxFrontmatterBytes);
            if (text.includes("\0")) continue;
            const parsed = parseFrontmatter(text, opts.maxFrontmatterBytes);
            meta = parsed.meta;
            bodyPrefix = parsed.body.slice(0, MAX_HEADING_PREFIX_CHARS);
            sidecar = sidecarStat
              ? await readSidecar(resolve(rp, ".."), sidecarStat.name, opts.maxFrontmatterBytes, realRoot)
              : undefined;
            metadataReads++;
            cache.set(rp, {
              stamp,
              meta,
              ...(bodyPrefix ? { bodyPrefix } : {}),
              ...(sidecar ? { sidecar } : {}),
            });
          }
          visitedPaths.add(rp);
          const skill = normalizeEntry(meta, rp, realRoot, r, opts, {
            ...(bodyPrefix ? { bodyPrefix } : {}),
            ...(sidecar ? { sidecar } : {}),
          });
          if (skill) {
            vaultCounts.set(skill.id, (vaultCounts.get(skill.id) ?? 0) + 1);
            if (!found.has(skill.id)) found.set(skill.id, skill);
          }
        } catch (e) {
          const code = (e as NodeJS.ErrnoException)?.code;
          diagnostics.push({ root, error: code || "FILE_FAILED" });
        }
      }
    }
    await walk(realRoot, 0);
  }

  for (const path of cache.keys()) if (!visitedPaths.has(path)) cache.delete(path);
  const conflictIds = [...vaultCounts.entries()]
    .filter(([, n]) => n > 1)
    .map(([id]) => id)
    .sort();
  return { skills: [...found.values()], conflictIds, diagnostics, metadataReads, metadataReuses };
}

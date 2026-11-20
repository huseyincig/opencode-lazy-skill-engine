import { readdir, lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { inside, peekMetadata } from "./security.js";
import { clipped } from "./text.js";
import { LANGUAGES, type LanguageCode } from "./concepts.js";
import type { LazySkillOptions } from "./config.js";

const GLOBAL_VAULT_ROOT = resolve(join(homedir(), ".config", "opencode", "skill-vault"));

const ignored = new Set([".git", ".hg", ".svn", "node_modules", ".next", "dist", "build", ".cache", "__pycache__"]);
const validID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type FrontmatterValue = string | string[];
export type FrontmatterMeta = Record<string, FrontmatterValue>;

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

export function normalizeEntry(
  meta: FrontmatterMeta,
  file: string,
  root: string,
  priority: number,
  opts: Pick<LazySkillOptions, "project" | "exclude" | "rules">
): SkillEntry | null {
  const id = idFromPath(file).toLowerCase();
  if (!validID.test(id) || id.length > 64 || opts.exclude.has(id)) return null;
  const description = clipped(meta.description, 700);
  if (!description) return null;
  const nameVal = typeof meta.name === "string" && meta.name ? meta.name : id;
  return {
    id,
    name: clipped(nameVal, 100),
    description,
    keywords: [...new Set([...getList(meta.keywords), ...(opts.rules[id] || [])].map(clippedWord).filter(Boolean))].slice(0, 40),
    aliases: [
      ...new Set(
        [
          ...getList(meta.aliases),
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
    ].slice(0, 60),
    tags: getList(meta.tags).map(clippedWord).filter(Boolean).slice(0, 40),
    triggers: getList(meta.triggers).map(clippedWord).filter(Boolean).slice(0, 64),
    negativeTriggers: getList(meta.negativeTriggers).map(clippedWord).filter(Boolean).slice(0, 64),
    languages: getList(meta.languages).filter((x): x is LanguageCode => LANGUAGES.includes(x as LanguageCode)).slice(0, 13),
    roles: getList(meta.roles)
      .map(clippedWord)
      .filter((x) => /^[a-z][a-z0-9-]{0,62}$/.test(x))
      .slice(0, 64),
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
          const stamp = [st.dev, st.ino, st.size, st.mtimeMs, st.ctimeMs].join(":");
          const cached = cache.get(rp);
          let meta: FrontmatterMeta;
          if (!force && cached?.stamp === stamp) {
            meta = cached.meta;
            metadataReuses++;
          } else {
            const text = await peekMetadata(rp, opts.maxSkillBytes, opts.maxFrontmatterBytes);
            if (text.includes("\0")) continue;
            meta = parseFrontmatter(text, opts.maxFrontmatterBytes).meta;
            metadataReads++;
            cache.set(rp, { stamp, meta });
          }
          visitedPaths.add(rp);
          const skill = normalizeEntry(meta, rp, realRoot, r, opts);
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

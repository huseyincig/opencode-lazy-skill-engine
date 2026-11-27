import { readdir, realpath } from "node:fs/promises";
import { inside } from "./security.js";
import { join, relative } from "node:path";

export interface ResourceSkillRef {
  scope: "native" | "vault";
  base: string | null;
  root?: string | null;
}

export const MAX_RESOURCE_VISITED = 2_000;
export const RESOURCE_WALK_DEADLINE_MS = 1_000;

export interface ResourceListOptions {
  max?: number;
  maxVisited?: number;
  deadlineMs?: number;
}

export interface ResourceListResult {
  resources: string[];
  diagnostic?: string;
}

export async function listResourcesWithDiagnostics(
  skill: ResourceSkillRef,
  options: ResourceListOptions = {}
): Promise<ResourceListResult> {
  if (skill.scope !== "vault" || !skill.base) return { resources: [] };
  const max = options.max ?? 40;
  const maxVisited = options.maxVisited ?? MAX_RESOURCE_VISITED;
  const deadline = Date.now() + (options.deadlineMs ?? RESOURCE_WALK_DEADLINE_MS);
  const base = await realpath(skill.base);
  if (skill.root && !inside(skill.root, base)) throw new Error("Resource list escapes trusted vault root");
  const out: string[] = [];
  let visited = 0;
  let diagnostic: string | undefined;
  let capped = false;

  const bounded = (): boolean => {
    if (diagnostic) return true;
    if (visited >= maxVisited) diagnostic = `resource walk stopped after ${maxVisited} entries`;
    else if (Date.now() > deadline) diagnostic = "resource walk deadline exceeded";
    return diagnostic !== undefined;
  };

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 3 || bounded()) return;
    if (out.length >= max) {
      capped = true;
      return;
    }
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const sorted = entries.sort((a, b) => a.name.localeCompare(b.name));
    if (sorted.length > maxVisited) capped = true;
    const limited = sorted.length > maxVisited ? sorted.slice(0, maxVisited) : sorted;
    for (const e of limited) {
      visited++;
      if (bounded()) return;
      if (e.name.startsWith(".") || e.isSymbolicLink() || e.name === "node_modules") continue;
      const path = join(dir, e.name);
      if (e.isDirectory()) await walk(path, depth + 1);
      else if (e.isFile() && e.name !== "SKILL.md") {
        if (out.length < max) out.push(relative(base, path).replaceAll("\\", "/"));
        else capped = true;
      }
      if (out.length >= max) {
        capped = true;
        break;
      }
      if (diagnostic) break;
    }
  }
  await walk(base, 0);
  if (!diagnostic && capped && out.length >= max) {
    diagnostic = `resource list truncated to ${max} entries`;
  }
  return { resources: out, ...(diagnostic ? { diagnostic } : {}) };
}

export async function listResources(skill: ResourceSkillRef, max = 40): Promise<string[]> {
  return (await listResourcesWithDiagnostics(skill, { max })).resources;
}

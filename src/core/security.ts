import { realpath, open } from "node:fs/promises";
import { constants as fs } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

const decoder = new TextDecoder("utf-8", { fatal: true });

export function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function checkRelative(userPath: unknown): asserts userPath is string {
  if (
    typeof userPath !== "string" ||
    !userPath ||
    userPath.length > 512 ||
    userPath.includes("\0") ||
    isAbsolute(userPath) ||
    userPath.split(/[\\/]/).includes("..") ||
    /^[a-zA-Z]:/.test(userPath) ||
    userPath.startsWith("\\\\") ||
    userPath.includes("\\")
  ) {
    throw new Error("Invalid relative resource path");
  }
}

async function boundedOpen(file: string, maxBytes: number, prefixBytes = 0): Promise<string> {
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024) {
    throw new Error("Invalid byte limit");
  }
  const handle = await open(file, fs.O_RDONLY | (fs.O_NOFOLLOW ?? 0));
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.size > maxBytes) throw new Error("Resource must be a file within byte limit");
    const budget = prefixBytes ? Math.min(maxBytes, prefixBytes) : maxBytes;
    const data = Buffer.allocUnsafe(Math.min(st.size, budget) + 1);
    let n = 0;
    while (n < data.length) {
      const result = await handle.read(data, n, data.length - n, n);
      if (!result.bytesRead) break;
      n += result.bytesRead;
    }
    if (!prefixBytes && n > maxBytes) throw new Error("Resource exceeds byte limit");
    const bytes = data.subarray(0, n);
    if (bytes.includes(0)) throw new Error("Binary resource rejected");
    try {
      return decoder.decode(bytes);
    } catch {
      if (prefixBytes) return bytes.toString("utf8");
      throw new Error("Binary/invalid UTF-8 resource rejected");
    }
  } finally {
    await handle.close();
  }
}

/** Canonical skill base and its parent vault are immutable trust constraints. */
export async function safeRead(base: string, userPath: string, maxBytes: number, trustedRoot = base): Promise<string> {
  checkRelative(userPath);
  const root = await realpath(trustedRoot);
  const canonicalBase = await realpath(base);
  if (!inside(root, canonicalBase)) throw new Error("Skill directory escapes trusted vault root");
  const candidate = resolve(canonicalBase, userPath);
  if (!inside(canonicalBase, candidate)) throw new Error("Resource escapes skill directory");
  const canonicalFile = await realpath(candidate);
  if (!inside(canonicalBase, canonicalFile) || !inside(root, canonicalFile)) {
    throw new Error("Resource escapes skill directory (symlink)");
  }
  return boundedOpen(canonicalFile, maxBytes);
}

/** Scanner reads only a bounded frontmatter prefix, never a whole skill body. */
export async function peekMetadata(file: string, maxSkillBytes: number, maxFrontmatterBytes: number): Promise<string> {
  const allowed = Math.min(maxSkillBytes, maxFrontmatterBytes + 16);
  return boundedOpen(file, maxSkillBytes, allowed);
}

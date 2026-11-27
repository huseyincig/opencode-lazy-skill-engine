import { realpath, open, lstat, type FileHandle } from "node:fs/promises";
import { constants as fs } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const VAULT_READ_DEADLINE_MS = 2_000;
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

async function descriptorPath(handle: FileHandle): Promise<string | undefined> {
  if (process.platform !== "linux") return undefined;
  try {
    return await realpath(`/proc/self/fd/${handle.fd}`);
  } catch {
    return undefined;
  }
}

async function boundedOpen(
  file: string,
  maxBytes: number,
  prefixBytes = 0,
  contain: readonly string[] = []
): Promise<string> {
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024) {
    throw new Error("Invalid byte limit");
  }
  const gate = await lstat(file);
  if (!gate.isFile() || gate.size > maxBytes) throw new Error("Resource must be a file within byte limit");

  let timer: ReturnType<typeof setTimeout> | undefined;
  let handle: FileHandle | undefined;
  let timedOut = false;
  let finished = false;
  let closed = false;
  const closeOnce = async (): Promise<void> => {
    if (closed || !handle) return;
    closed = true;
    await handle.close().catch(() => undefined);
  };
  const work = (async (): Promise<string> => {
    const flags = fs.O_RDONLY | (fs.O_NOFOLLOW ?? 0) | (fs.O_NONBLOCK ?? 0);
    handle = await open(file, flags);
    if (timedOut || finished) {
      await closeOnce();
      throw new Error("Vault read deadline exceeded");
    }
    const st = await handle.stat();
    if (!st.isFile() || st.size > maxBytes) throw new Error("Resource must be a file within byte limit");
    if (st.dev !== gate.dev || st.ino !== gate.ino) throw new Error("Resource changed during open");
    if (contain.length > 0) {
      const real = await descriptorPath(handle);
      if (real !== undefined && !contain.every((root) => inside(root, real))) {
        throw new Error("Resource escapes skill directory (descriptor)");
      }
    }
    const budget = prefixBytes ? Math.min(maxBytes, prefixBytes) : maxBytes;
    const data = Buffer.allocUnsafe(Math.min(st.size, budget) + 1);
    let n = 0;
    while (n < data.length) {
      if (timedOut) throw new Error("Vault read deadline exceeded");
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
  })();
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Error("Vault read deadline exceeded"));
    }, VAULT_READ_DEADLINE_MS);
    timer.unref?.();
  });
  try {
    return await Promise.race([work, limit]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    work.catch(() => undefined);
    finished = true;
    await closeOnce();
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
  return boundedOpen(canonicalFile, maxBytes, 0, [root, canonicalBase]);
}

/** Scanner reads only a bounded frontmatter prefix, never a whole skill body. */
export async function peekMetadata(file: string, maxSkillBytes: number, maxFrontmatterBytes: number): Promise<string> {
  const allowed = Math.min(maxSkillBytes, maxFrontmatterBytes + 16);
  return boundedOpen(file, maxSkillBytes, allowed);
}

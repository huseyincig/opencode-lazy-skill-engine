import { createHash } from "node:crypto";

export interface ContextSkillEntry {
  text: string;
  messageID: string;
  createdAt?: number;
}

export interface NativeSkillReuseRecord {
  skillID: string;
  sourceHash: string;
  contentHash?: string;
  messageID?: string;
  state: "attached" | "reusable";
  updatedAt: number;
}

export interface NativeSkillReusePlan {
  fresh: string[];
  reused: string[];
  hashes: Map<string, string>;
  bytes: Map<string, number>;
}

/** Bounds on live-context parsing; keeps long sessions (>200 msgs) reusable while bounding memory. */
export const MAX_SCAN_MESSAGES = 1_000;
export const MAX_CONTEXT_SKILL_ENTRIES = 64;
export const MAX_CONTEXT_SKILL_BYTES = 1024 * 1024;
/** Tolerance for host user-message timestamps created just before the prompt hook runs. */
const CLOCK_ORDER_TOLERANCE_MS = 5_000;
const PREPARED_SKILL_WRAPPER_PREFIX = '<skill_content name="';
const PREPARED_SKILL_BODY_HEADER = "\n# Skill: ";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isHostMessageID(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("msg_");
}

function isHostPreparedSkill(text: string): boolean {
  return text.startsWith(PREPARED_SKILL_WRAPPER_PREFIX) && text.includes(PREPARED_SKILL_BODY_HEADER);
}

/** SHA-256 hex digest of skill source or prepared context text (never stores raw body). */
export function hashSkillContent(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Extract message array from common OpenCode V2 `ctx.session.context()` return shapes. */
export function extractContextMessages(raw: unknown): unknown[] | undefined {
  if (Array.isArray(raw)) return raw;
  if (!isRecord(raw)) return undefined;
  if (Array.isArray(raw.messages)) return raw.messages;
  if (Array.isArray(raw.data)) return raw.data;
  if (isRecord(raw.data) && Array.isArray(raw.data.messages)) return raw.data.messages;
  return undefined;
}

/**
 * Parse host-shaped skill entries from live `ctx.session.context()` messages.
 * Scans up to the most recent MAX_SCAN_MESSAGES messages while strictly capping
 * skill entry count and total skill bytes (fail-closed on overflow).
 */
export function extractContextSkillTexts(messages: readonly unknown[]): Map<string, ContextSkillEntry> {
  const found = new Map<string, ContextSkillEntry>();
  if (!Array.isArray(messages) || messages.length === 0) return found;
  const start = messages.length > MAX_SCAN_MESSAGES ? messages.length - MAX_SCAN_MESSAGES : 0;
  let entries = 0;
  let bytes = 0;

  const accept = (
    id: unknown,
    name: unknown,
    text: unknown,
    messageID: string,
    createdAt: number | undefined
  ): boolean => {
    if (!nonEmpty(id) || !nonEmpty(name) || !nonEmpty(text)) return true;
    entries += 1;
    bytes += Buffer.byteLength(text, "utf8");
    if (entries > MAX_CONTEXT_SKILL_ENTRIES || bytes > MAX_CONTEXT_SKILL_BYTES) return false;
    found.set(id, {
      text,
      messageID,
      ...(createdAt !== undefined ? { createdAt } : {}),
    });
    return true;
  };

  for (let i = start; i < messages.length; i++) {
    const message = messages[i];
    if (!isRecord(message) || !isHostMessageID(message.id)) continue;
    const rawCreated = isRecord(message.time) ? message.time.created : undefined;
    const createdAt = typeof rawCreated === "number" && Number.isFinite(rawCreated) ? rawCreated : undefined;

    if (message.type === "skill") {
      const skill = message.skill;
      const ok = isRecord(skill)
        ? accept(skill.id, skill.name, skill.text, message.id, createdAt)
        : accept(skill, message.name, message.text, message.id, createdAt);
      if (!ok) return new Map();
      continue;
    }
    if (message.type !== "user" || !Array.isArray(message.skills)) continue;
    for (const item of message.skills) {
      if (!isRecord(item)) continue;
      if (!accept(item.id, item.name, item.text, message.id, createdAt)) return new Map();
    }
  }
  return found;
}

/**
 * Decide per selected native skill whether live session context proves it is still
 * present and unchanged. Fail-closed: any missing hash, mismatch, or absence forces fresh attach.
 */
export function planNativeSkillReuse(input: {
  selected: readonly string[];
  records: ReadonlyMap<string, NativeSkillReuseRecord>;
  context: ReadonlyMap<string, ContextSkillEntry>;
  sourceHashes: ReadonlyMap<string, string>;
}): NativeSkillReusePlan {
  const plan: NativeSkillReusePlan = { fresh: [], reused: [], hashes: new Map(), bytes: new Map() };
  for (const id of input.selected) {
    const record = input.records.get(id);
    const live = input.context.get(id);
    const currentSourceHash = input.sourceHashes.get(id);
    if (!record || !live || !nonEmpty(live.text) || !nonEmpty(currentSourceHash) || record.sourceHash !== currentSourceHash) {
      plan.fresh.push(id);
      continue;
    }
    const preparedHash = hashSkillContent(live.text);
    const sameMessage = Boolean(record.messageID && live.messageID === record.messageID);
    const timeValid =
      sameMessage ||
      (typeof live.createdAt === "number" &&
        Number.isFinite(live.createdAt) &&
        live.createdAt + CLOCK_ORDER_TOLERANCE_MS >= record.updatedAt);
    const ok =
      (record.state === "attached" &&
        (isHostPreparedSkill(live.text) || (sameMessage && live.text.length >= 16)) &&
        (record.contentHash === undefined || record.contentHash === preparedHash) &&
        timeValid) ||
      (record.state === "reusable" && record.contentHash !== undefined && record.contentHash === preparedHash);

    if (ok) {
      plan.reused.push(id);
      plan.hashes.set(id, preparedHash);
      plan.bytes.set(id, Buffer.byteLength(live.text, "utf8"));
    } else {
      plan.fresh.push(id);
    }
  }
  return plan;
}

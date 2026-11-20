import { fold, tokenize, parseQuery, editDistanceWithinOne, variants } from "./text.js";
import { matchConcepts } from "./concepts.js";
import { negativeTriggerMatch } from "./selection.js";
import type { SkillEntry } from "./scanner.js";
import type { FieldWeightKey } from "./config.js";

const FIELDS: FieldWeightKey[] = ["id", "name", "keywords", "aliases", "tags", "triggers", "description"];
const C = "~"; // Explicit concept namespace: cannot collide with natural metadata tokens.
const conceptToken = (t: string): string => C + t;

interface TokenStrength {
  score: number;
  name: boolean;
}

export interface SearchIndex {
  docs: Array<{ skill: SkillEntry; strengths: Map<string, TokenStrength> }>;
  postings: Map<string, number[]>;
  byId: Map<string, number>;
  avg: Record<string, number>;
  fuzzyBuckets: Map<string, string[]>;
}

export interface SearchHit {
  skill: SkillEntry;
  score: number;
  coverage: number;
  matched: string[];
}

export interface SearchOptions {
  topK?: number;
  scope?: "native" | "vault";
  allowedIds?: ReadonlySet<string> | readonly string[] | null;
  respectNegativeTriggers?: boolean;
  preferFullCoverage?: boolean;
  force?: boolean;
}

function features(text: string): string[] {
  const words = tokenize(text, true);
  const expanded = [...words];
  for (const w of words) {
    for (const v of variants(w)) if (v !== w) expanded.push(v);
  }
  for (const concept of matchConcepts(text).keys()) expanded.push(conceptToken(concept));
  return expanded;
}

/** Sparse inverted postings: candidate evaluation costs depend on matching docs, not total skill count. */
export function createSearchIndex(skills: SkillEntry[], weights: Partial<Record<FieldWeightKey, number>> = {}): SearchIndex {
  const rawDocs: Array<{ skill: SkillEntry; fields: Record<string, { tf: Map<string, number>; len: number }> }> = [];
  const postings = new Map<string, number[]>();
  const byId = new Map<string, number>();
  const df = new Map<string, number>();
  const sumLength = Object.fromEntries(FIELDS.map((f) => [f, 0])) as Record<string, number>;
  const fuzzyBuckets = new Map<string, string[]>();

  for (let i = 0; i < skills.length; i++) {
    const skill = skills[i]!;
    const fields: Record<string, { tf: Map<string, number>; len: number }> = {};
    const bag = new Set<string>();
    byId.set(fold(skill.id), i);
    for (const f of FIELDS) {
      const counts = new Map<string, number>();
      const rawVal = skill[f];
      const input = Array.isArray(rawVal) ? rawVal.join(" ") : String(rawVal ?? "");
      const terms = features(input);
      for (const t of terms.slice(0, 130)) counts.set(t, Math.min(3, (counts.get(t) ?? 0) + 1));
      const len = Math.max(1, terms.length);
      fields[f] = { tf: counts, len };
      sumLength[f] = (sumLength[f] ?? 0) + len;
      for (const t of counts.keys()) bag.add(t);
    }
    rawDocs.push({ skill, fields });
    for (const term of bag) {
      let posting = postings.get(term);
      if (!posting) {
        posting = [];
        postings.set(term, posting);
      }
      posting.push(i);
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  }

  for (const token of postings.keys()) {
    if (token.startsWith(C) || [...token].length < 4) continue;
    const prefix = [...token].slice(0, 2).join("");
    let list = fuzzyBuckets.get(prefix);
    if (!list) {
      list = [];
      fuzzyBuckets.set(prefix, list);
    }
    list.push(token);
  }

  const avg = Object.fromEntries(
    FIELDS.map((f) => [f, Math.max(1, (sumLength[f] ?? 0) / Math.max(1, rawDocs.length))])
  ) as Record<string, number>;
  const n = Math.max(1, rawDocs.length);
  const idf = new Map<string, number>();
  for (const [token, count] of df) {
    idf.set(
      token,
      Math.max(0.25, Math.min(4, Math.log(1 + (n - count + 0.5) / (count + 0.5)))) * (token.startsWith(C) ? 0.87 : 1)
    );
  }

  const defaultWeights: Record<FieldWeightKey, number> = {
    id: 7,
    name: 6,
    keywords: 5,
    aliases: 4,
    tags: 3,
    triggers: 5,
    description: 1.8,
  };

  const docs = rawDocs.map((doc) => {
    const strengths = new Map<string, TokenStrength>();
    for (const f of FIELDS) {
      const { tf, len } = doc.fields[f]!;
      const weight = weights[f] ?? defaultWeights[f];
      for (const [token, freq] of tf) {
        const val = weight * (freq / (freq + 1.2 * (0.25 + (0.75 * len) / (avg[f] ?? 1))));
        const rec = strengths.get(token) ?? { score: 0, name: false };
        rec.score += val;
        if (f === "id" || f === "name") rec.name = true;
        strengths.set(token, rec);
      }
    }
    for (const [token, record] of strengths) record.score *= idf.get(token) ?? 1;
    return { skill: doc.skill, strengths };
  });

  return { docs, postings, byId, avg, fuzzyBuckets };
}

function termsFor(raw: string, _words: string[], concepts: string[]): string[] {
  const out = concepts.map(conceptToken);
  const used = new Set(out);
  const source = fold(raw);
  const matched = matchConcepts(source);
  const mask = source.split("");
  for (const entry of matched.values()) {
    for (const { start, end } of entry.spans ?? [entry]) {
      for (let i = start; i < end; i++) mask[i] = " ";
    }
  }
  const residual = tokenize(mask.join(""));
  for (const term of residual) {
    if (!used.has(term)) {
      used.add(term);
      out.push(term);
    }
  }
  return out.slice(0, 24);
}

function fuzzyAlternatives(index: SearchIndex, term: string): Array<{ term: string; weight: number }> {
  if (term.startsWith(C) || [...term].length < 4 || index.postings.has(term)) return [];
  const result: Array<{ term: string; weight: number }> = [];
  const a = [...term];
  const prefix = a.slice(0, 2).join("");
  for (const candidate of (index.fuzzyBuckets.get(prefix) ?? []).slice(0, 300)) {
    if (candidate.startsWith(term)) result.push({ term: candidate, weight: 0.48 });
    else if (editDistanceWithinOne(term, candidate)) result.push({ term: candidate, weight: 0.28 });
    if (result.length >= 12) break;
  }
  return result;
}

/** Compact retrieval with negative filters, native/vault scoping, phrase/ID boosts and honest coverage. */
export function search(index: SearchIndex, query: string, options: SearchOptions = {}): SearchHit[] {
  const parsed = parseQuery(query);
  const topK = Math.min(30, Math.max(1, typeof options.topK === "number" && Number.isInteger(options.topK) ? options.topK : 8));
  const allowed =
    options.allowedIds instanceof Set
      ? options.allowedIds
      : Array.isArray(options.allowedIds)
        ? new Set(options.allowedIds)
        : null;
  const listAll = query.trim() === "" || query.trim() === "*";
  if (listAll) {
    return index.docs
      .filter((d) => (!options.scope || d.skill.scope === options.scope) && (!allowed || allowed.has(d.skill.id)))
      .slice(0, topK)
      .map((d) => ({ skill: d.skill, score: 0, coverage: 0, matched: [] }));
  }

  const normalizedQuery = fold(query.trim());
  const pos = termsFor(parsed.positiveRaw, parsed.positive, parsed.positiveConcepts);
  const neg = termsFor(parsed.negativeRaw, parsed.negative, parsed.negativeConcepts);
  const alternatives = new Map<string, Array<{ term: string; weight: number }>>();
  const ids = new Set<number>();

  for (const term of pos) {
    const stemAlts = term.startsWith(C) ? [] : variants(term).filter((v) => v !== term).map((v) => ({ term: v, weight: 0.85 }));
    const alts = [{ term, weight: 1 }, ...stemAlts, ...fuzzyAlternatives(index, term)];
    alternatives.set(term, alts);
    for (const a of alts) for (const id of index.postings.get(a.term) ?? []) ids.add(id);
  }
  if (parsed.explicit) {
    const id = fold(parsed.explicit);
    const target = index.byId.get(id);
    if (target !== undefined) ids.add(target);
  }

  const complete: SearchHit[] = [];
  const partial: SearchHit[] = [];
  const better = (a: SearchHit, b: SearchHit): boolean =>
    a.score > b.score ||
    (a.score === b.score && (a.coverage > b.coverage || (a.coverage === b.coverage && a.skill.id.localeCompare(b.skill.id) < 0)));

  const push = (hit: SearchHit): void => {
    const heap = options.preferFullCoverage !== false && hit.coverage === 1 ? complete : partial;
    if (heap.length < topK) {
      heap.push(hit);
      let i = heap.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (!better(heap[p]!, heap[i]!)) break;
        [heap[p], heap[i]] = [heap[i]!, heap[p]!];
        i = p;
      }
      return;
    }
    if (!better(hit, heap[0]!)) return;
    heap[0] = hit;
    let i = 0;
    while (true) {
      const a = i * 2 + 1;
      const b = a + 1;
      let j = i;
      if (a < heap.length && better(heap[j]!, heap[a]!)) j = a;
      if (b < heap.length && better(heap[j]!, heap[b]!)) j = b;
      if (i === j) break;
      [heap[i], heap[j]] = [heap[j]!, heap[i]!];
      i = j;
    }
  };

  for (const id of ids) {
    const d = index.docs[id]!;
    if (options.scope && d.skill.scope !== options.scope) continue;
    if (allowed && !allowed.has(d.skill.id)) continue;
    if (options.respectNegativeTriggers && negativeTriggerMatch(query, d.skill)) continue;
    if (neg.some((term) => d.strengths.has(term) || (!term.startsWith(C) && variants(term).some((v) => d.strengths.has(v))))) continue;

    let value = 0;
    let hits = 0;
    let names = 0;
    const matched: string[] = [];
    for (const term of pos) {
      let best: TokenStrength = { score: 0, name: false };
      for (const alt of alternatives.get(term) ?? []) {
        const candidate = d.strengths.get(alt.term);
        if (!candidate) continue;
        if (candidate.score * alt.weight > best.score) best = { score: candidate.score * alt.weight, name: candidate.name };
      }
      if (best.score > 0) {
        hits++;
        matched.push(term.startsWith(C) ? term.slice(1) : term);
        value += best.score;
        if (best.name) names++;
      }
    }

    const exactId = Boolean(parsed.explicit && fold(parsed.explicit) === fold(d.skill.id));
    if (exactId) value += 40;
    if (!hits && !exactId) continue;
    const coverage = hits / Math.max(1, pos.length);
    value *= Math.pow(coverage, 1.3) * (1 + 0.08 * Math.min(6, hits));
    if (parsed.phrases.length) {
      const whole = fold(
        `${d.skill.id} ${d.skill.name} ${d.skill.description} ${(d.skill.keywords ?? []).join(" ")} ${(d.skill.aliases ?? []).join(" ")} ${(d.skill.triggers ?? []).join(" ")} ${(d.skill.tags ?? []).join(" ")}`
      );
      for (const phrase of parsed.phrases) if (whole.includes(phrase)) value += 4;
    }
    if (normalizedQuery === d.skill.id) value += 30;
    value += Math.min(names, 3) * 0.45;
    push({ skill: d.skill, score: Number(value.toFixed(4)), coverage, matched });
  }

  const byScore = (a: SearchHit, b: SearchHit): number =>
    b.score - a.score || b.coverage - a.coverage || a.skill.id.localeCompare(b.skill.id);
  complete.sort(byScore);
  partial.sort(byScore);
  const results = options.preferFullCoverage !== false && complete.length ? [...complete, ...partial] : partial;
  return results.slice(0, topK);
}

import { fold, tokenize, parseQuery, editDistanceWithinOne, variants } from "./text.js";
import { matchConcepts } from "./concepts.js";
import { negativeTriggerMatch } from "./selection.js";
import type { SkillEntry } from "./scanner.js";
import type { FieldWeightKey } from "./config.js";

type IndexFieldKey = FieldWeightKey | "derivedKeywords" | "derivedAliases";
const EXPLICIT_META_FIELDS: readonly FieldWeightKey[] = ["keywords", "aliases", "tags", "triggers"];
const INDEX_FIELDS: readonly IndexFieldKey[] = [
  "id",
  "name",
  "keywords",
  "aliases",
  "tags",
  "triggers",
  "description",
  "derivedKeywords",
  "derivedAliases",
];
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
  const rawDocs: Array<{ skill: SkillEntry; fields: Record<IndexFieldKey, { tf: Map<string, number>; len: number }> }> = [];
  const postings = new Map<string, number[]>();
  const byId = new Map<string, number>();
  const df = new Map<string, number>();
  const sumLength = Object.fromEntries(INDEX_FIELDS.map((f) => [f, 0])) as Record<IndexFieldKey, number>;
  const nonEmptyCount = Object.fromEntries(INDEX_FIELDS.map((f) => [f, 0])) as Record<IndexFieldKey, number>;
  const fuzzyBuckets = new Map<string, string[]>();

  for (let i = 0; i < skills.length; i++) {
    const skill = skills[i]!;
    const fields = {} as Record<IndexFieldKey, { tf: Map<string, number>; len: number }>;
    const bag = new Set<string>();
    byId.set(fold(skill.id), i);
    for (const f of INDEX_FIELDS) {
      const counts = new Map<string, number>();
      const rawVal = skill[f];
      const input = Array.isArray(rawVal) ? rawVal.join(" ") : String(rawVal ?? "");
      const terms = features(input);
      for (const t of terms.slice(0, 130)) counts.set(t, Math.min(3, (counts.get(t) ?? 0) + 1));
      const len = terms.length;
      fields[f] = { tf: counts, len: Math.max(1, len) };
      if (len > 0) {
        sumLength[f] += len;
        nonEmptyCount[f] += 1;
      }
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
    INDEX_FIELDS.map((f) => [f, Math.max(1, sumLength[f] / Math.max(1, nonEmptyCount[f]))])
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
  const resolvedWeights: Record<FieldWeightKey, number> = {
    id: weights.id ?? defaultWeights.id,
    name: weights.name ?? defaultWeights.name,
    keywords: weights.keywords ?? defaultWeights.keywords,
    aliases: weights.aliases ?? defaultWeights.aliases,
    tags: weights.tags ?? defaultWeights.tags,
    triggers: weights.triggers ?? defaultWeights.triggers,
    description: weights.description ?? defaultWeights.description,
  };
  const derivedKeywordsWeight = resolvedWeights.keywords * 0.6;
  const derivedAliasesWeight = resolvedWeights.aliases * 0.55;
  const metaAnchor = Math.max(1, resolvedWeights.keywords, resolvedWeights.triggers, resolvedWeights.description);
  const metaKnee = metaAnchor * 0.64;
  const metaCap = metaAnchor * 1.0;
  const metaHead = Math.max(0.01, metaCap - metaKnee);

  const docs = rawDocs.map((doc) => {
    const hasExplicitMeta = EXPLICIT_META_FIELDS.some((f) => doc.fields[f].tf.size > 0);
    const effectiveDescWeight =
      !hasExplicitMeta && resolvedWeights.description > 0
        ? Math.max(resolvedWeights.description, Math.min(metaAnchor, resolvedWeights.description * 2.5))
        : resolvedWeights.description;
    const parts = new Map<string, { identity: number; meta: number; name: boolean }>();

    for (const f of INDEX_FIELDS) {
      const { tf, len } = doc.fields[f];
      if (tf.size === 0) continue;
      const weight =
        f === "description"
          ? effectiveDescWeight
          : f === "derivedKeywords"
            ? derivedKeywordsWeight
            : f === "derivedAliases"
              ? derivedAliasesWeight
              : resolvedWeights[f];
      if (weight <= 0) continue;
      const denomBase = 1.2 * (0.25 + (0.75 * len) / (avg[f] ?? 1));
      const isIdentity = f === "id" || f === "name";
      for (const [token, freq] of tf) {
        const val = weight * (freq / (freq + denomBase));
        const rec = parts.get(token) ?? { identity: 0, meta: 0, name: false };
        if (isIdentity) {
          rec.identity += val;
          rec.name = true;
        } else {
          rec.meta += val;
        }
        parts.set(token, rec);
      }
    }

    const strengths = new Map<string, TokenStrength>();
    for (const [token, part] of parts) {
      const saturatedMeta =
        part.meta <= metaKnee
          ? part.meta
          : metaKnee + metaHead * ((part.meta - metaKnee) / (part.meta - metaKnee + metaHead));
      strengths.set(token, {
        score: (part.identity + saturatedMeta) * (idf.get(token) ?? 1),
        name: part.name,
      });
    }
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
        `${d.skill.id} ${d.skill.name} ${d.skill.description} ${(d.skill.keywords ?? []).join(" ")} ${(d.skill.aliases ?? []).join(" ")} ${(d.skill.triggers ?? []).join(" ")} ${(d.skill.tags ?? []).join(" ")} ${(d.skill.derivedKeywords ?? []).join(" ")} ${(d.skill.derivedAliases ?? []).join(" ")}`
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

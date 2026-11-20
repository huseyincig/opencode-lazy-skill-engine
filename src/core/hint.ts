import { parseQuery, clipped, xmlEscape, detectLanguage, tokenize } from "./text.js";
import { HINT_I18N, type LanguageCode } from "./concepts.js";
import type { SearchHit } from "./rank.js";
import type { LazySkillOptions } from "./config.js";
import type { SessionLedger } from "./session.js";

export function selectHints(
  query: string,
  found: SearchHit[],
  opts: Pick<LazySkillOptions, "hints" | "maxHints" | "minHintCoverage">,
  ledger: SessionLedger,
  sessionID: string
): SearchHit[] {
  if (opts.hints === "off" || opts.maxHints === 0) return [];
  const parsed = parseQuery(query);
  if (query.trim().length < 12 && !parsed.explicit) return [];
  if (parsed.positiveConcepts.length + parsed.positive.length < 2 && !parsed.explicit) return [];
  const eligible = found
    .filter((r) => r.coverage >= opts.minHintCoverage && r.score >= 2.5)
    .filter((r) => !ledger.hinted(sessionID, r.skill.id) && !ledger.loaded(sessionID, r.skill.id))
    .filter((r) => r.skill.scope === "vault" || !r.skill.autoinvoke);
  const selected: SearchHit[] = [];
  const similarity = (a: SearchHit, b: SearchHit): number => {
    const x = new Set(tokenize(`${a.skill.id} ${a.skill.name} ${a.skill.description}`));
    const y = new Set(tokenize(`${b.skill.id} ${b.skill.name} ${b.skill.description}`));
    const shared = [...x].filter((w) => y.has(w)).length;
    return shared / Math.max(1, x.size + y.size - shared);
  };
  for (const candidate of eligible) {
    if (selected.some((previous) => similarity(candidate, previous) >= 0.85)) continue;
    selected.push(candidate);
    if (selected.length >= opts.maxHints) break;
  }
  return selected;
}

export function renderHints(items: SearchHit[], language: LanguageCode | "auto" = "auto", query = ""): string {
  if (!items.length) return "";
  const locale = detectLanguage(query, language);
  const intro = HINT_I18N[locale] ?? HINT_I18N.en;
  const lines = items.map(
    (r) => `- id="${xmlEscape(clipped(r.skill.id, 64))}" desc="${xmlEscape(clipped(r.skill.description, 140))}" source="${r.skill.scope}"`
  );
  return `\n\n<lazy_skill_suggestions advisory="true">\n${xmlEscape(intro)}\n${lines.join("\n")}\n</lazy_skill_suggestions>`;
}

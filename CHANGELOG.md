# Changelog

## 1.4.4

- Verify packed-artifact (`npm pack`) installation and loading inside an isolated `opencode v2.3.0 --standalone` sandbox (`debug agents` and `debug config`).
- Align `README.md`, `docs/ARCHITECTURE.md`, `docs/COEXISTENCE.md`, and `docs/QUALITY.md` with all v1.4.3–v1.4.4 capabilities, hooks, and verification gates.

## 1.4.3

- Add camelCase/acronym boundary splitting in `tokenize()` and conservative Turkish/English suffix stemming in `variants()` with weighted stem alternatives in `search()`.
- Broaden `isOrchestratedRoster()` to detect subagent rosters with restrictive `edit`, `shell`/`bash`, `subagent`/`task`, `question`, `*`, or `skill` permissions.
- Strip markdown code fences in `parseSemanticIDs()`, preserve `model.variant` in semantic routing, and support `ctx.generate.text` fallback.
- Detect `origin: "project"` for native skills present in `.opencode/skills` or `.opencode/skill` even when `ctx.skill.list()` omits `path`.
- Skip automatic binding and hints on synthetic/internal prompts (`synthetic: true` / `internal: true`) unless explicit or required skills are present.
- Strip YAML inline `#` comments and reject disallowed YAML tokens (`&`, `*`, `!`) in `parseFrontmatter()`, parsing inline `[...]` arrays directly.
- Support array `query` in `lazy_skill_search`, batch `ids` in `lazy_skill_info`, and inject `<lazy_skill_catalog>` on-demand discovery guidance into `ctx.session.hook("context")` when `nativeCatalog: "hide"`.

## 1.4.2

- Enforce host agent `skill` permissions (`respectHostPermissions`) via `ctx.session.get()` under `mode: "single"` and `autoBind: "off"` whenever `ctx.agent.list()` is available, failing closed on transient lookup failures.
- Prevent `skill:<id>` explicit binding from bypassing `vaultAutoBind: false` or `projectAutoBind: false`, and align `lazy_skill_plan` with `prompt` hook permission/scope filtering.
- Preserve non-concept CJK (Chinese/Japanese) domain terms alongside matched concepts, add Japanese/Chinese polite request stopwords, align UTF-16 concept masks, support unspaced CJK multi-word `negativeTriggers`, and backfill remaining `topK` slots with partial matches after full-coverage hits.
- Fix Turkish uppercase `İ` and repeated-substring handling in `detectLanguage()`, align `parseQuery` and `extractExplicit` with `maxPromptChars`, and include `triggers` and `tags` in quoted phrase scoring.
- Classify custom `options.roots` inside the project directory as `origin: "project"`, fix `listResources()` canonical relative paths and Windows separators, canonicalize `trustedRoot` in `safeRead()`, and escape closing boundary tags in `<skill>`, `<vault_resource>`, and `<lazy_bound_skill>`.
- Preserve original descriptions on reload under `nativeCatalog: "compact"`, fix `Catalog.refresh(true)` concurrency with inflight non-forced refreshes, support UTF-8 BOM and trailing spaces in `parseFrontmatter()`, and align `SessionLedger` load keys.
- Translate all repository documentation into English.

## 1.4.1

- Removed external project/product references from code, comments, tests, documentation, and installation examples.
- Standardized naming on `opencode-lazy-skill-engine` and official OpenCode interfaces.
- Preserved runtime imports, test commands, SDK package identifiers, and original license.
- No functional changes to single-agent, multi-agent, search, or permission contracts.

## 1.4.0

- Capability-based host coexistence without external orchestrator IDs or pinned version checks.
- Safe defaults: `nativeCatalog: "preserve"`, `hints: "off"`, `coexistence: "respect"`.
- Automatic skill filtering via `ctx.agent.list()` ordered allow/ask/deny and wildcard rules.
- Preserve existing `prompt.skills` attachments owned by the host or other plugins; halt automatic additions by default.
- Disable automatic worker expansion when a host agent roster exists but worker policy cannot be verified.
- Infer multi-agent mode from generic subagent skill restrictions.

Previous releases supplied the multilingual index, role-aware selection, native binding, cold vault, semantic fallback, and standalone auto mode. See the test suite for ongoing compatibility contracts.

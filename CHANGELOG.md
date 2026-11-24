# Changelog

## 1.7.2

- **Security Hardening (`src/plugin.ts`, `src/core/scanner.ts`):**
  - Enforce `projectAutoBind: false`, `vaultAutoBind`, and `meshProfile.allowedSkills` on explicit `skill:<id>` prompt mentions even when `requiredSkills` is also present (`source: "task"`), preventing untrusted repository `.opencode/skill-vault` content or out-of-role skills from bypassing policy in both `session.hook("prompt")` and `lazy_skill_plan`; normalize `plan.source` to `"none"` when post-filtering empties `plan.ids`.
  - Add post-open `fstatSync(fd)` size and regular-file verification to `readSidecarSync()` (`src/core/scanner.ts`), eliminating the `lstatSync` -> `openSync` TOCTOU window.
- **Concurrency & Cache Consistency (`src/core/host-policy.ts`, `src/core/catalog.ts`):**
  - Guard `HostSkillPolicy.list()` with a monotonic `generation` counter incremented by `clear()` so stale pre-update in-flight `ctx.agent.list()` resolutions never overwrite fresher permission rosters or clobber newer pending calls.
  - Guard `Catalog.refresh()` with an `invalidationGen` counter incremented by `invalidate()` so mid-flight `skill.updated` / `plugin.updated` invalidations never get masked by a stale 30s TTL cache.
- **Plan/Status Parity & Timer Hygiene (`src/plugin.ts`, `src/tui.tsx`, `src/core/semantic.ts`, `README.md`):**
  - Report `bindReason: "binding_owned_by_peer"`, `bindingOwner`, and `baselineMode` from `lazy_skill_plan`, expose `baselineMode` in `lazy_skill_status`, and declare matching properties in `PLAN_OUTPUT_SCHEMA` and `STATUS_OUTPUT_SCHEMA`.
  - Call `.unref?.()` on bounded timeout timers in `boundedLookup`, `HostSkillPolicy.list`, `SemanticRouter.select`, and `LazySidebar` RPC calls; align `README.md` TUI sidebar default view documentation (`Expanded View (Default)`).
- **Verification:**
  - Add `tests/deep-audit-fixes.test.js` (5 security, concurrency, TOCTOU, and parity regression tests) expanding the suite to **217 / 217** passing tests across 17 suites (`43 / 43` JS modules, `0` strict typecheck errors against `@opencode/plugin@2.4.1`, `0` audit vulnerabilities).

## 1.7.1

- **Idle Performance & Zero-Waste Polling (`src/core/catalog.ts`, `src/tui.tsx`):**
  - Fingerprint sorted catalog entries (`catalogFingerprint`) in `Catalog.refresh()` so non-forced TTL refreshes with unchanged skills reuse the existing `SearchIndex` and skip redundant BM25F rebuilds and `version` increments (while forced refreshes and real skill edits rebuild immediately).
  - Replace the fixed 5s `setInterval` in `LazySidebar` (`src/tui.tsx`) with an adaptive `schedulePoll()` (`5s` only while connecting, **`30s`** once connected; `plugin.updated`, `skill.updated`, and session switches still trigger immediate refresh) and add `sameSnapshot()` shallow equality before `setSnapshot()` to eliminate redundant SolidJS TUI re-renders.
  - Add idle-performance regression tests in `tests/tui-rpc.test.js` (**212 / 212** passing tests across 16 suites, `42 / 42` JS modules, `0` strict typecheck errors on `@opencode/plugin@2.4.1`).

## 1.7.0

- **Adaptive Role Baseline Binding (`baselineMode`) (`src/core/config.ts`, `src/core/selection.ts`, `src/plugin.ts`):**
  - Add `baselineMode: "adaptive" | "always" | "fallback"` (default `"adaptive"`) and `resolveBaselineMode()`.
  - Under `"adaptive"`, standalone and non-orchestrated setups retain legacy `"fallback"` (either-or: lexical router wins, else `role.default`), while mesh-managed profiles (`bindingOwner: "self" | "external"` or `managedBy: "opencode-hi"`) automatically resolve to `"always"`: safe non-project `role.default` baseline skills bind first (still enforcing `candidateIds`, `hostAllowed`, `role.allowed`, and `negativeTriggers`) and lexical/semantic routing fills remaining slots up to `maxActive`.
- **Explicit Mesh Binding Ownership (`bindingOwner`) (`src/bridge.ts`, `src/plugin.ts`):**
  - Add `MeshAgentProfile.bindingOwner?: "self" | "external"` to `src/bridge.ts`.
  - When a mesh orchestrator declares `bindingOwner: "self"`, automatic binding is suppressed (`autoBind = "off"`) even under `autoBind: "all"`, while explicit `skill:<id>` and `requiredSkills` remain honored; `bindingOwner: "external"` permits Lazy automatic binding; unknown wire values are ignored safely.
- **Verification:**
  - Add `tests/baseline-mode.test.js` (11 unit & mesh-integration tests) expanding the suite to **210 / 210** passing tests across 16 suites (`42 / 42` JS modules, `0` strict typecheck errors against `@opencode/plugin@2.4.1`).

## 1.6.1

- **Fix OpenCode V2.4.x Tool `output` Schema Contract (`src/plugin.ts`):**
  - Declare explicit JSON Schema `output` definitions (`SEARCH_OUTPUT_SCHEMA`, `INFO_OUTPUT_SCHEMA`, `PLAN_OUTPUT_SCHEMA`, `STATUS_OUTPUT_SCHEMA`, `LOAD_OUTPUT_SCHEMA`, `RESOURCE_OUTPUT_SCHEMA`) on all 6 `lazy_skill_*` tool registrations so OpenCode `v2.4.1` host `outputSchema` validation accepts structured `{ content, output }` results in both standalone and multi-plugin setups.
  - Return consistent schema-compliant structured `output` across every branch of `lazy_skill_load` (including vault loads: `{ id, scope, loaded, base }`) and `lazy_skill_resource` (`{ id, path, bytes }`), and type `output?: unknown` in `PluginContextLike`.
  - Add contract verification suite (`tests/tool-output-schema.test.js`) validating all 6 tools and every return branch against their declared JSON Schemas, plus live verification inside an isolated `opencode v2.4.1 --standalone` host (**199 / 199** passing tests across 15 suites).

## 1.6.0

- **Strict-Frontmatter Compatible BM25F Scoring (`src/core/rank.ts`):**
  - Compute BM25F field length averages (`avg[f]`) exclusively across documents where field `f` is non-empty so sparse metadata fields never distort length normalization.
  - Apply adaptive `description` weight compensation (default `1.8 -> 4.5`) for standard `name + description` skills (Agent Skills / OpenCode V2 / Claude / Antigravity format with empty `keywords`/`triggers`/`tags`/`aliases`), paired with per-token non-identity metadata saturation so keyword-stuffed frontmatter cannot unfairly drown out strict skills.
  - Index synthetic `derivedKeywords` and `derivedAliases` fields at lower weight than explicit frontmatter fields (`3.0` / `2.2` vs `5` / `4`) and include them in quoted phrase boosts.
- **Safe Bounded Auto-Extraction (`src/core/scanner.ts`, `src/core/catalog.ts`):**
  - Automatically derive bounded synthetic signals (`extractDerivedSignals`) for standard skills with empty `keywords`/`triggers` without mutating explicit fields: inline backticks, `@scope/pkg`, `dot.notation`, `camelCase`/`PascalCase`, `kebab-case`, `UPPER_SNAKE_CASE`, `Use when ...` trigger clauses, and `#`/`##` headings from the bounded body prefix (skipping fenced code blocks and boilerplate headings, respecting `maxFrontmatterBytes`).
  - Apply derived extraction consistently across vault skills, native skills (`normalizeNative`), and `nativeCatalog: "compact"` refresh cycles.
- **Optional Sidecar Metadata (`lazy-skill.json` / `skill.meta.json`):**
  - Safely load optional per-skill sidecar JSON metadata (`keywords`, `aliases`, `triggers`, `tags`, `negativeTriggers`, `languages`, `roles`) for both vault and native skills and merge with `options.rules` while keeping `SKILL.md` frontmatter pure.
  - Enforce symlink rejection (`lstat` + `O_NOFOLLOW` + `inside`), `maxFrontmatterBytes` cap, UTF-8/prototype-pollution sanitization, and incremental cache invalidation when a sidecar file changes.
- **Expanded 13-Language Concept Bridge (`src/core/concepts.ts`, `src/core/text.ts`):**
  - Add 5 new 13-language engineering concepts (`plugin`, `permission`, `compaction`, `ui`, `orchestration`, bringing total to `38`), strengthen Turkish/English mappings (`security`, `review`, `api`, `automation`, `configuration`, `caching`), and expand Turkish technical clues in `detectLanguage()`.
- **OpenCode v2.4.1 Alignment (`package.json`):**
  - Align `peerDependencies` `@opentui/core` and `@opentui/solid` floor to `>=0.8.0` (matching `@opencode/plugin@2.4.1`) and update `devDependencies` to `@opencode/plugin@^2.4.1`, `@opentui/core@^0.9.9`, `@opentui/solid@^0.9.9`.
  - Expand automated verification suite to **198 / 198** passing tests across 14 suites (`tests/strict-frontmatter.test.js`).

## 1.5.4

- Align with **OpenCode v2.4.0** (`@opencode/plugin@2.4.0`, `@opentui/core >=0.9.4`, `@opentui/solid >=0.9.4`):
  - Subscribe to `plugin.updated` and `session.compaction.ended` in `src/plugin.ts`; invalidate catalog/policy caches on hot-reloaded plugins and reset session `loads`/`hints` via `SessionLedger.resetCompacted()` after compaction so vault skills can re-bind cleanly.
  - Return structured `output` alongside `content` in `Tool.Result` responses across all `lazy_skill_*` JSON tools.
  - Update `LazySidebar` (`src/tui.tsx`) to consume `sidebar.content` slot `{ sessionID }` input and resolve `context.data.session.get(sessionID)` and `context.data.location.default()`.
  - Raise `peerDependencies` `@opentui/core` and `@opentui/solid` floor to `>=0.9.4` and verify against `@opencode/plugin@2.4.0` (`186 / 186` passing tests).

## 1.5.3

- Decouple `lazy_skill_plan` target-role previews (`agent: "<role>"`) from the caller session's primary `meshProfile`, infer worker status from host `roster` (`mode: "subagent"`) or configured `roles`, and return `bindReason` (`"bound"`, `"primary_session_off"`, `"below_score_or_coverage_threshold"`, etc.) plus `outsideRoleAllowed`.
- Enforce `hostAllowed` directly inside `selectBindings()` across `requiredSkills` (`deniedRequired`) and `explicit` (`skill:<id>`) branches as defense-in-depth alongside `plugin.ts` host policy verification.
- Include `matched` terms in `lazy_skill_search` default `summary` detail mode and add `roleProfiles` (per-role `allowedCount`, `default`, `maxActive`, `effectiveBindMode`) plus `vaultNote` to `lazy_skill_status`.
- Expand automated verification suite to **185 / 185** passing tests across 13 suites.

## 1.5.2

- Clean up external sibling repository links in `README.md` in favor of capability-based OpenCode V2 mesh descriptions while preserving all required runtime protocol keys.
- Verify packed `opencode-lazy-se` artifact loading, live `opencode serve` (`v2.3.2`) session lifecycle, multilingual discovery, conflict detection, symlink/traversal/binary/forged-metadata defenses, and workspace hygiene in an isolated sandbox (`184 / 184` automated tests passing).

## 1.5.1

- Optimize out-of-the-box defaults for balanced skill activation on relevant prompts (`maxAutoSkills: 4`, `vaultAutoBind: true`, `bindExplicit: true`, `hints: "hint"`, `singleAgent: { minScore: 2.5, minCoverage: 0.3, maxActive: 2 }`, while keeping `projectAutoBind: false` for repo safety).
- Enforce `meshProfile.allowedSkills` and host `ctx.agent.list()` permissions across `lazy_skill_plan`, explicit `skill:<id>` prompt mentions, `lazy_skill_load`, `lazy_skill_resource`, and `<lazy_skill_suggestions>` hints (with `respectNegativeTriggers: true`).
- Harden mesh turn coordination: prioritize synthetic control markers (`opencode-guardian`, `hi-internal: "silent-reprompt"`, `opencode-mesh.kind: "remediation"`) over stale delegation flags, re-check `peekPromptSkillClaim` after async lookups, and update `src/bridge.ts` to `BRIDGE_REVISION = "2.3.1"`.
- Add bounded 2500ms RPC timeout and stale in-flight directory-switch guard to `LazySidebar` (`src/tui.tsx`), and skip the 30s cache TTL in `Catalog.refresh()` after transient `ctx.skill.list()` failures.
- Expand test coverage to **184 / 184** passing tests and align documentation, SVG badge, package keywords, and GitHub repository metadata.

## 1.5.0

- Migrate the entire codebase to strict TypeScript (`.ts` / `.tsx`) with compiled `dist/` output, declaration files (`.d.ts`), dual-target OpenTUI/Solid emission (`scripts/emit-tui.mjs`), and root entry shims (`index.js`, `tui.js`).
- Publish package under npm name **`opencode-lazy-se`** while preserving internal plugin ID `opencode-lazy-skill-engine` for seamless mesh interoperability.
- Add `LazySidebar` OpenCode V2 TUI sidebar extension (`./tui`) and typed `opencode-lazy-skill.stats` RPC contract (`./rpc`) reporting `version`, `catalogVersion`, `ready`, `skills`, `native`, `vault`, `local`, `global`, `conflicts`, and `conflictIds`, with automatic stale-snapshot reset on workspace directory changes.
- Add Universal OpenCode V2 Plugin Mesh bridge (`src/bridge.ts`, `BRIDGE_REVISION = "2.3.0"`) for zero-dependency interoperability with `opencode-hi`, `opencode-guardian`, and `opencode-smart-questions` (`skills.catalog` capability, `queryMeshSkills`, `claimPromptSkillBinding` turn ownership protection, `isTrustedMeshMessage` provenance verification, `skill-injection` metadata protection, and `session.deleted` state cleanup).
- Detect multi-vault, native-vs-vault, native-vs-native, and `maxSkills`-capped skill ID conflicts in `Catalog.refresh()` and `scanVaults()`.
- Handle empty frontmatter (`---\n---`), multiline indented scalars, and indented YAML comments (`  # comment`) cleanly in `parseFrontmatter()`, and improve doubled-consonant stemming (`running` -> `run`, `debugging` -> `debug`) in `variants()`.
- Expand documentation (`README.md`, `docs/ARCHITECTURE.md`, `docs/COEXISTENCE.md`, `docs/QUALITY.md`) with full Global, Project-Local, `.opencode/plugins/` Symlink, `file://`, and Remote TUI (`cli.json`) installation guides and verification matrix (`179 / 179` passing tests).

## 1.4.5

- Subscribe to `skill.updated` and `agent.updated` via `ctx.event.subscribe` and invalidate the catalog cache on `ctx.skill.transform` replay to eliminate the 30s stale-cache startup race with late-loading plugins.
- Support optional `Skill.Info.description` in `normalizeNative()` by falling back to frontmatter `meta.description` or `s.name` instead of silently dropping native skills.
- Pass `bindExplicit` into `selectBindings()` so `bindExplicit: false` prevents inline `skill:<id>` mentions from bypassing `autoBind` mode or `role.allowed` / `singleAgent.allowed` allowlists.
- Scan vault roots in highest-priority-first order inside `scanVaults()` so a large global vault reaching `maxSkills` cannot starve project skills.
- Tighten `lazy_skill_search` (reject empty/whitespace-only array queries) and `lazy_skill_info` (require `id` or non-empty `ids`), check `abortIfNeeded(context)` after async steps in tool handlers, expose `semanticSkipped` in `lazy_skill_plan`, and detect nested plugin `synthetic`/`internal`/`autoContinue` flags in `prompt` hook metadata.
- Verify `166 / 166` unit/integration tests (`tests/v232-audit.test.js`) and packed-artifact (`npm pack`) loading inside an isolated `opencode v2.3.2 --standalone` sandbox.

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

# Architecture

`src/core/` contains pure or bounded-I/O modules independent of any orchestrator. `src/plugin.js` is the OpenCode V2 server adapter.

- **Catalog**: Combines native `ctx.skill.list()` entries with opt-in local vault roots; native entries take precedence over same-ID vault entries. Custom `roots` inside the project directory are classified as `origin: "project"`. Uses bounded frontmatter reads and atomic index refreshes.
- **Search**: Unicode normalization, script-aware tokenization, 13-language concept bridge (preserving CJK domain terms), inverted postings index, weighted BM25F-style scoring, and full-coverage-first bounded Top-K retrieval.
- **Selection**: Enforces required/explicit binding precedence, automatic candidate allowlists, negative triggers (including unspaced CJK phrases), origin bonuses, and coverage/score thresholds; `lazy_skill_plan` mirrors `prompt` hook filtering.
- **Host Permissions**: `src/core/host-policy.js` reads ordered `skill` permission rules from `ctx.agent.list()` using linear glob matching. Missing records never synthesize grants. Session identity is resolved even under `mode: "single"` or `autoBind: "off"` when `ctx.agent.list()` is present, failing closed on transient lookup failures. Roster lookups are TTL-cached.
- **Coexistence**: Existing `prompt.skills` arrays are preserved; default mode (`coexistence: "respect"`) avoids automatic additions when attachments are already present. Catalog hiding/compaction and prompt hints are opt-in.
- **Binding**: Native skills attach via `event.prompt.skills`; vault contents attach only on explicit opt-in via bounded file reads with XML closing-tag boundary escaping. File containment and role gating are independent defense layers.
- **Semantic Selection**: Disabled by default; when enabled and host `experimental.generate.text` is available, performs strict JSON ID selection over bounded role-approved candidates with an LRU cache.

No external orchestrator API, fixed role catalog, network access, database, or command execution engine is required. The only runtime contract is the OpenCode V2 server plugin API.

# Quality & Verification Matrix

Target runtime: OpenCode V2 Promise server plugin. Local verification uses `node:test` with a simulated V2 host and zero external runtime dependencies.

| Gate / Check | Evidence | Status |
|---|---|---|
| 13-language search & concepts | `tests/multilingual.test.js`, `tests/dual-mode.test.js` | PASS (Local) |
| Native/Vault path & symlink security | `tests/scanner-security.test.js`, `tests/plugin.test.js` | PASS (Local) |
| Standalone single-agent / multi-agent | `tests/dual-mode.test.js` | PASS (Simulated host) |
| Coexistence, permissions, existing attachments | `tests/coexistence.test.js` | PASS (Simulated host) |
| Ranking, fuzzing, bounded Top-K | `tests/text-rank.test.js`, `tests/robustness.test.js` | PASS (Local) |
| Required/explicit binding & semantic fallback | `tests/selection-parity.test.js` | PASS (Local) |
| Security, CJK, permission & lifecycle regressions | `tests/regression-audit.test.js` | PASS (Local) |
| Host-neutral orchestration, stemming & YAML hardening | `tests/host-hardening.test.js` | PASS (Local) |
| OpenCode V2.4.1 contract alignment, tool `output` schemas, compaction reset & hot-reload | `tests/tool-output-schema.test.js`, `tests/v232-audit.test.js`, `tests/debug-audit.test.js` | PASS (Local) |
| Strict `name + description` scoring, bounded extraction, sidecar security & TR→EN concepts | `tests/strict-frontmatter.test.js` | PASS (Local) |
| Adaptive role baseline (`baselineMode`) & mesh `bindingOwner` handoff | `tests/baseline-mode.test.js` | PASS (Local) |
| Mesh bridge provenance, rollback, YAML/stemming & session cleanup | `tests/debug-audit.test.js` | PASS (Local) |
| TUI sidebar lifecycle, idle polling, catalog reuse, RPC schema & conflict detection | `tests/tui-rpc.test.js` | PASS (Local) |
| Deep-audit security (`projectAutoBind`/TOCTOU), cache-race guards & plan/status parity | `tests/deep-audit-fixes.test.js` | PASS (Local) |
| Syntax & full unit test suite (217 tests / 17 files) | `npm run check` | PASS (Local) |
| Package tarball surface | `npm pack --dry-run` | PASS (Local) |
| Sandbox OpenCode V2.4.1 live host tool load & execution | `opencode v2.4.1 --standalone` isolated probe across all 6 `lazy_skill_*` tools (`hasOutputSchema: true`) | PASS (Isolated sandbox) |
| Multi-plugin live load order & multi-turn sessions | Multi-plugin live host session | **NOT_RUN** |

Static contract inspection and simulated-host tests do not replace full multi-plugin live session verification.

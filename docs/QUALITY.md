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
| Host-neutral orchestration, stemming & YAML hardening | `tests/hi-lessons.test.js` | PASS (Local) |
| Syntax & full unit test suite | `npm run check` | PASS (Local) |
| Package tarball surface | `npm pack --dry-run` | PASS (Local) |
| Sandbox OpenCode V2 plugin load & `setup(ctx)` | `opencode v2.3.0 --standalone debug agents` | PASS (Isolated sandbox) |
| Multi-plugin live load order & multi-turn sessions | Multi-plugin live host session | **NOT_RUN** |

Static contract inspection and simulated-host tests do not replace full multi-plugin live session verification.

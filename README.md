# opencode-lazy-skill-engine

An OpenCode V2 server plugin providing host-neutral, 13-language skill discovery, native skill binding, and safe cold-vault access for both **single-agent** and **multi-agent** workspaces. It does not require any external orchestrator package, fixed role names, custom task tools, specific model, or pinned host patch version.

## Design Principles

- **The host remains authoritative.** Native skills registered by other plugins, the built-in `skill` tool, agent permissions, and existing `prompt.skills` attachments are preserved.
- **Capability-based adaptation.** Uses only standard `ctx.skill`, `ctx.session`, `ctx.agent`, and `ctx.tool` contracts; never calls another plugin's private APIs.
- **Minimal intervention.** Defaults to `nativeCatalog: "preserve"`, `hints: "off"`, and `coexistence: "respect"`. Catalog compaction/hiding and full-body loading are explicit opt-ins.
- **Fast local search.** Uses bounded frontmatter scanning, an inverted postings index, BM25F-style scoring, Unicode tokenization, a 13-language concept bridge, and bounded Top-K retrieval. No network, database, or external embeddings required.
- **No privilege escalation.** When `ctx.agent.list()` is available, ordered host `skill` permissions filter automatic candidates. Last matching rule wins. Existing user or third-party `prompt.skills` attachments are never removed or overwritten.

## Installation

Place the package directory at `./plugins/lazy-skills/` in your project (containing `package.json` and `src/`), then configure `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{
    "package": "./plugins/lazy-skills",
    "options": {
      "mode": "auto",
      "autoBind": "adaptive",
      "coexistence": "respect",
      "respectHostPermissions": true,
      "nativeCatalog": "preserve",
      "hints": "off"
    }
  }]
}
```

These options are illustrative: omitting `options` applies the same safe defaults. For global installation, resolve the package path relative to your global OpenCode `opencode.jsonc`. The `@opencode/plugin` peer dependency is resolved from the running OpenCode V2 host within the **V2 major version range** declared in `package.json`.

## Operating Modes

| `mode` | Automatic skill binding | Intended use |
|---|---|---|
| `auto` (default) | High-confidence native skills in single-agent mode; workers only when host subagent/role restrictions are detected | General setups |
| `single` | Single-agent logic with `autoBind: adaptive` | Force single-agent behavior |
| `orchestrator` | Workers only with `autoBind: adaptive` | Explicit multi-agent separation |

`autoBind` options: `adaptive` (default), `off`, `workers`, `all`. With `coexistence: "respect"` (default), **no new automatic skills are added** when `prompt.skills` is already populated. Explicit `requiredSkills` task contracts are evaluated separately. Use `coexistence: "augment"` only when you intentionally want to combine two binders.

When `ctx.agent.list()` is available, the host's ordered permission rules filter automatic candidates; skills without an explicit `allow` decision are not auto-bound. If an agent roster exists but a worker's policy cannot be resolved (or `session.get` fails), automatic binding is disabled for safety. If the host does not expose `ctx.agent.list()`, the plugin operates only within its configured role/scope bounds and **cannot guarantee independent runtime permission enforcement**; set `autoBind: "off"` if needed. `respectHostPermissions: false` is provided strictly as an explicit recovery escape hatch.

`nativeCatalog: "preserve"` leaves other plugins' `autoinvoke` flags untouched. `hide` and `compact` are **explicit opt-ins** and should be tested alongside any other skill-registering plugins.

## Skill Binding Contract

Selection precedence:
1. Existing host attachments in `prompt.skills` (preserved unchanged)
2. Task-required skills (`metadata.lazySkill.requiredSkills`)
3. Explicit inline selection (`skill:<id>`)
4. Eligible role/single-agent candidates and lexical scoring
5. Optional semantic fallback (`experimental.generate.text`)

If a required skill is missing from the active catalog or denied by host agent permissions, the prompt fails **atomically** before mutating `prompt.skills` or `prompt.text`. Automatic selection respects role `allowed` lists, origin bonuses, `negativeTriggers`, and active caps.

An orchestrator may optionally pass `{ taskId, requiredSkills }` under `event.metadata.lazySkill`; **this field is optional and not tied to any external plugin API**. Native skills are always attached via `event.prompt.skills`; cold-vault bodies are never auto-injected unless `vaultAutoBind: true` (and `projectAutoBind: true` for project-local vault skills) is explicitly enabled.

## Tools

| Tool | Purpose |
|---|---|
| `lazy_skill_search` | Multilingual skill search with `ids`, `summary`, or `full` detail |
| `lazy_skill_info` | Inspect skill metadata, origin, and relative resource file paths |
| `lazy_skill_plan` | Read-only binding preview matching `prompt` hook permission/scope rules |
| `lazy_skill_status` | Catalog counts, active configuration, and last session binding receipt |
| `lazy_skill_load` | Safely load one selected cold-vault skill body on demand |
| `lazy_skill_resource` | Bounded UTF-8 text read of a relative resource file in a vault skill |

The first four tools never load full skill bodies. Native skills must be loaded using the host's built-in `skill` tool. Content read from a vault is treated as untrusted data wrapped in escaped XML boundaries and cannot override system instructions or host permissions.

## Language Support

Supports 13 languages: Chinese (`zh`), English (`en`), Hindi (`hi`), German (`de`), Portuguese (`pt`), Japanese (`ja`), Indonesian (`id`), Russian (`ru`), French (`fr`), Spanish (`es`), Vietnamese (`vi`), Dutch (`nl`), and Turkish (`tr`). This is a finite, dependency-free local engineering concept bridge—not a machine translation engine.

## Verification

```sh
npm test
npm run check
npm run benchmark
npm pack --dry-run
```

Unit and integration tests run via `node:test` against a simulated V2 host. Additionally, plugin discovery, `setup(ctx)`, and clean shutdown were verified in an isolated `opencode v2.3.0 --standalone` sandbox. **Multi-plugin live turn-by-turn orchestration has not been executed (`NOT_RUN`).** See [Coexistence](docs/COEXISTENCE.md), [Quality](docs/QUALITY.md), and [Architecture](docs/ARCHITECTURE.md).

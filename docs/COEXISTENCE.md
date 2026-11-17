# Standalone & Multi-Plugin Coexistence

This plugin **does not need to know about any specific orchestrator**. It adapts to the host's V2 session, agent, skill, and tool capabilities.

## Standalone

With `mode: "auto"` and default `autoBind: "adaptive"`: in a normal single-agent session, only high-confidence native skills are bound. Unrelated prompts receive no attachments. Set `mode: "single"` to lock single-agent behavior. Native catalog visibility is preserved by default.

## Multi-Agent Environments

- A child session is detected when `ctx.session.get` returns a non-empty `parentID`.
- Restrictive permissions on `subagent` roles in `ctx.agent.list()` (`skill`, `edit`, `shell`/`bash`, `subagent`/`task`, `question`, or `*` with `deny`/`ask`) signal an orchestrated workspace without checking any vendor-specific agent names.
- Synthetic/internal prompts (`synthetic: true` / `internal: true`) skip automatic binding and hints unless explicit `skill:<id>` or `requiredSkills` are provided.
- Default `adaptive` mode does not force automatic skills onto primary/manager sessions; workers are evaluated within their role/permission scope.
- When `ctx.agent.list()` is available, ordered `action/resource/effect` rules filter automatic candidates to explicit `allow` decisions. This narrows **only the plugin's own proposed attachments**; the host remains the authoritative enforcement boundary.
- If another plugin has already populated `prompt.skills`, `coexistence: "respect"` suppresses new automatic additions. `requiredSkills` and explicit user selections remain atomic.
- Other plugins' `ctx.skill.transform`, `ctx.agent.transform`, task ledgers, and system prompts are never modified.

## Configuration Examples

Standard setup:

```jsonc
{"plugins":[{"package":"./plugins/lazy-skills"}]}
```

Discovery-only (when another binder manages all automatic skill selection):

```jsonc
{"plugins":[{"package":"./plugins/lazy-skills","options":{"autoBind":"off","nativeCatalog":"preserve","hints":"off"}}]}
```

Opt-in catalog hiding and prompt hints:

```jsonc
{"plugins":[{"package":"./plugins/lazy-skills","options":{"nativeCatalog":"hide","hints":"hint"}}]}
```

Test the last example before combining with another skill-catalog plugin: `hide` sets `autoinvoke: false` on native catalog entries, which may affect other plugins' expectations.

## Known Boundaries

1. The plugin does not detect orchestrators by name or version and cannot foresee mutations made by plugins that run **after** its `prompt` hook. Set `autoBind: "off"` if strict single-owner binding is required.
2. Per-session permission overrides not reflected in `ctx.agent.list()` cannot be pre-evaluated by the plugin; the native OpenCode host enforces final runtime permissions.
3. No fixed agent names are assumed unless `roles` is explicitly configured.
4. If `requiredSkills` is used, the caller or orchestrator must supply `event.metadata.lazySkill.requiredSkills`.
5. In live multi-plugin deployments, verify `opencode plugin list`, native `skill` behavior, plugin load order, manager/worker isolation, allow/deny rules, compaction, and reload.

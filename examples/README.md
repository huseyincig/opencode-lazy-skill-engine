# Configuration Examples

Copy any configuration below into `~/.config/opencode/opencode.jsonc` (global) or `<project>/opencode.jsonc` (project-local), then adjust skill IDs and model names to match your setup.

| File | When to use it |
| :--- | :--- |
| [opencode.jsonc](opencode.jsonc) | Standard setup showing the built-in balanced defaults (`mode: "auto"`, `autoBind: "adaptive"`, `sessionReuse: true`, `hints: "hint"`). |
| [semantic-fallback.jsonc](semantic-fallback.jsonc) | Enable optional LLM semantic fallback with a dedicated fast model (`semantic.model: "providerID/modelID[#variant]"`). |
| [multi-agent-roles.jsonc](multi-agent-roles.jsonc) | Orchestrator/worker separation with per-role `allowed` / `default` / `maxActive` profiles and `baselineMode: "always"`. |
| [cold-vault-and-tuning.jsonc](cold-vault-and-tuning.jsonc) | Custom cold-vault `roots`, `projectAutoBind`, custom `rules` per skill ID, `exclude`, BM25F `weights`, and `nativeCatalog: "compact"`. |
| [discovery-only.jsonc](discovery-only.jsonc) | Keep only the 6 `lazy_skill_*` tools, TUI sidebar, and shared catalog while disabling automatic binding and hints. |
| [sidecar-skill-meta.json](sidecar-skill-meta.json) | Place as `lazy-skill.json` or `skill.meta.json` next to any `SKILL.md` to add keywords, triggers, negative triggers, aliases, or roles without editing the skill file. |

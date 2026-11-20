export const LAZY_SKILL_STATS_RPC_ID = "opencode-lazy-skill.stats" as const;

export interface LazySkillStatsSnapshot {
  version: string;
  catalogVersion?: number;
  ready: "ready" | "degraded" | "partial";
  skills: number;
  native?: number;
  vault?: number;
  local: number;
  global: number;
  conflicts: number;
  conflictIds?: string[];
  [key: string]: unknown;
}

export const LAZY_SKILL_STATS_RPC = {
  id: LAZY_SKILL_STATS_RPC_ID,
  methods: {
    snapshot: {
      input: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          version: { type: "string" },
          catalogVersion: { type: "number" },
          ready: { type: "string" },
          skills: { type: "number" },
          native: { type: "number" },
          vault: { type: "number" },
          local: { type: "number" },
          global: { type: "number" },
          conflicts: { type: "number" },
          conflictIds: { type: "array", items: { type: "string" } },
        },
        required: ["ready", "skills", "local", "global", "conflicts"],
        additionalProperties: true,
      },
    },
  },
  events: {},
} as const;

export default LAZY_SKILL_STATS_RPC;

/** @jsxImportSource @opentui/solid */
import type { Plugin } from "@opencode/plugin/tui";
import { createSignal, Show } from "solid-js";
import { readFileSync } from "node:fs";
import { LAZY_SKILL_STATS_RPC, type LazySkillStatsSnapshot } from "./stats-rpc.js";

const pkgVersion = (() => {
  try {
    return (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
  } catch {
    return "1.5.0";
  }
})();

interface LazyThemeColors {
  accent: string;
  text: string;
  muted: string;
  background: string;
  success: string;
  warning: string;
  error: string;
}

interface LazyThemeInput {
  theme?: {
    brand?: { primary?: { base?: string } };
    status?: { info?: { base?: string }; success?: { base?: string }; warning?: { base?: string }; error?: { base?: string } };
    text?: { base?: string; muted?: string };
    background?: { base?: string; panel?: string };
  };
}

function resolveLazyTheme(context: LazyThemeInput): LazyThemeColors {
  const theme = context?.theme;
  return {
    accent: theme?.brand?.primary?.base ?? theme?.status?.info?.base ?? theme?.text?.base ?? "cyan",
    text: theme?.text?.base ?? "white",
    muted: theme?.text?.muted ?? theme?.text?.base ?? "gray",
    background: theme?.background?.base ?? theme?.background?.panel ?? "black",
    success: theme?.status?.success?.base ?? "green",
    warning: theme?.status?.warning?.base ?? "yellow",
    error: theme?.status?.error?.base ?? "red",
  };
}

function StatRow(props: {
  label: string;
  value: () => string | number;
  valueColor: () => string;
  muted: () => string;
}) {
  return (
    <box width="100%" flexDirection="row" justifyContent="space-between">
      <text fg={props.muted()} flexShrink={0}>
        {props.label}
      </text>
      <text fg={props.valueColor()} flexShrink={1} marginLeft={1}>
        <b>{props.value()}</b>
      </text>
    </box>
  );
}

export const setup: Plugin.Definition["setup"] = async (context) => {
  if (!context || typeof context.ui?.slot !== "function") return;

  const [snapshot, setSnapshot] = createSignal<LazySkillStatsSnapshot | null>(null);
  const [open, setOpen] = createSignal(true);
  let disposed = false;
  let inflight: Promise<void> | null = null;
  let lastDirectory: string | undefined;

  const resolveLocation = (): { directory?: string } | undefined => {
    try {
      const active =
        typeof (context.data?.session as { active?: () => { location?: { directory?: string } } } | undefined)?.active ===
        "function"
          ? (context.data!.session as unknown as { active: () => { location?: { directory?: string } } }).active()
          : undefined;
      return active?.location ?? (context.location as { directory?: string } | undefined);
    } catch {
      return context.location as { directory?: string } | undefined;
    }
  };

  const refresh = (): Promise<void> => {
    if (disposed || typeof context.client?.rpc !== "function") return Promise.resolve();
    if (inflight) return inflight;
    inflight = (async () => {
      const loc = resolveLocation();
      const currentDir = loc?.directory;
      const dirChanged = currentDir !== lastDirectory;
      try {
        const callOpts = currentDir ? { location: loc } : undefined;
        const rpcClient = (
          context.client.rpc as unknown as (
            contract: typeof LAZY_SKILL_STATS_RPC
          ) => { snapshot: (input: Record<string, never>, opts?: { location?: { directory?: string } }) => Promise<LazySkillStatsSnapshot> }
        )(LAZY_SKILL_STATS_RPC);
        const res = await rpcClient.snapshot({}, callOpts);
        if (!disposed && res && typeof res === "object") {
          lastDirectory = currentDir;
          setSnapshot(res);
        }
      } catch {
        // Server plugin may still be loading (v2.2.7+); if directory changed, clear stale cross-project snapshot.
        if (!disposed && dirChanged) {
          lastDirectory = currentDir;
          setSnapshot(null);
        }
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  };

  const cleanups: Array<(() => void) | undefined> = [];
  if (typeof context.data?.on === "function") {
    for (const evType of ["plugin.updated", "skill.updated"] as const) {
      try {
        cleanups.push(
          (context.data.on as (type: string, cb: () => void) => () => void)(evType, () => {
            void refresh();
          })
        );
      } catch {}
    }
  }

  const timer = setInterval(() => {
    void refresh();
  }, 5000);
  timer.unref?.();
  cleanups.push(() => clearInterval(timer));

  const LazySidebar = () => {
    const colors = () => resolveLazyTheme(context as unknown as LazyThemeInput);
    const statusLabel = () => {
      const s = snapshot();
      if (!s) return "◷ connecting";
      if (s.ready === "ready") return "● ready";
      if (s.ready === "degraded") return "! degraded";
      return "! partial";
    };
    const statusColor = () => {
      const c = colors();
      const s = snapshot();
      if (!s) return c.muted;
      if (s.ready === "ready") return c.success;
      return c.warning;
    };

    const conflictValue = () => {
      const s = snapshot();
      if (!s) return "—";
      if (!s.conflicts) return "0";
      const preview =
        Array.isArray(s.conflictIds) && s.conflictIds.length
          ? ` (${s.conflictIds.slice(0, 2).join(", ")}${s.conflictIds.length > 2 ? ", …" : ""})`
          : "";
      return `! ${s.conflicts}${preview}`;
    };

    return (
      <box width="100%" flexDirection="column" gap={0}>
        <box width="100%" flexDirection="row" onMouseDown={() => setOpen((v) => !v)}>
          <text fg={colors().muted}>{open() ? "▼ " : "▶ "}</text>
          <box paddingLeft={1} paddingRight={1} backgroundColor={colors().accent}>
            <text fg={colors().background}>lazy</text>
          </box>
          <text fg={colors().muted}>{` v${snapshot()?.version ?? pkgVersion}`}</text>
          <text fg={statusColor()} flexShrink={1} truncate={true} wrapMode="none">
            {` · ${statusLabel()}`}
          </text>
        </box>
        <Show when={open()}>
          <box width="100%" flexDirection="column" paddingLeft={1}>
            <StatRow label="Skills" value={() => snapshot()?.skills ?? "—"} valueColor={() => colors().text} muted={() => colors().muted} />
            <StatRow label="Local" value={() => snapshot()?.local ?? "—"} valueColor={() => colors().accent} muted={() => colors().muted} />
            <StatRow label="Global" value={() => snapshot()?.global ?? "—"} valueColor={() => colors().muted} muted={() => colors().muted} />
            <StatRow
              label="Conflicts"
              value={conflictValue}
              valueColor={() => ((snapshot()?.conflicts ?? 0) > 0 ? colors().warning : colors().muted)}
              muted={() => colors().muted}
            />
          </box>
        </Show>
      </box>
    );
  };

  const slotDisposer = context.ui.slot({
    append: "sidebar.content",
    render: () => <LazySidebar />,
  });
  cleanups.push(typeof slotDisposer === "function" ? slotDisposer : undefined);
  void refresh();

  return () => {
    disposed = true;
    for (const fn of cleanups.splice(0).reverse()) {
      try {
        fn?.();
      } catch {}
    }
  };
};

export default {
  id: "opencode-lazy-skill-engine.tui",
  setup,
};

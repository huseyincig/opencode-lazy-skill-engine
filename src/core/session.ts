export interface SessionReceipt {
  ids: string[];
  source: string;
  mode: "native" | "vault" | "mixed";
  at: number;
}

interface SessionState {
  last: number;
  hints: Set<string>;
  loads: Map<string, string>;
  receipt: SessionReceipt | null;
  semanticTasks: Map<string, string[]>;
}

export class SessionLedger {
  private readonly ttl: number;
  private readonly max: number;
  private readonly states = new Map<string, SessionState>();

  constructor({ sessionTtlMs, maxSessions }: { sessionTtlMs: number; maxSessions: number }) {
    this.ttl = sessionTtlMs;
    this.max = maxSessions;
  }

  state(id: string | undefined, create = true): SessionState | null {
    if (typeof id !== "string" || !id) return null;
    const now = Date.now();
    for (const [key, v] of this.states) if (now - v.last > this.ttl) this.states.delete(key);
    let s = this.states.get(id);
    if (!s && create) {
      if (this.states.size >= this.max) {
        const oldest = this.states.keys().next().value;
        if (oldest !== undefined) this.states.delete(oldest);
      }
      s = { last: now, hints: new Set(), loads: new Map(), receipt: null, semanticTasks: new Map() };
      this.states.set(id, s);
    }
    if (s) {
      s.last = now;
      this.states.delete(id);
      this.states.set(id, s);
    }
    return s ?? null;
  }

  hinted(id: string | undefined, skill: string): boolean {
    return !!this.state(id, false)?.hints.has(skill);
  }

  markHint(id: string | undefined, skill: string): void {
    const state = this.state(id);
    if (!state) return;
    if (state.hints.size >= 128) {
      const oldest = state.hints.values().next().value;
      if (oldest !== undefined) state.hints.delete(oldest);
    }
    state.hints.add(skill);
  }

  loaded(id: string | undefined, skill: string): string | undefined {
    return this.state(id, false)?.loads.get(skill);
  }

  markLoad(id: string | undefined, skill: string, path: string): void {
    const state = this.state(id);
    if (!state) return;
    if (state.loads.size >= 128) {
      const oldest = state.loads.keys().next().value;
      if (oldest !== undefined) state.loads.delete(oldest);
    }
    state.loads.set(skill, path);
  }

  record(id: string | undefined, receipt: Omit<SessionReceipt, "at">): void {
    const state = this.state(id);
    if (!state) return;
    state.receipt = {
      ids: [...receipt.ids].slice(0, 128),
      source: receipt.source,
      mode: receipt.mode,
      at: Date.now(),
    };
  }

  receipt(id: string | undefined): SessionReceipt | null {
    return this.state(id, false)?.receipt ?? null;
  }

  getTaskSelection(id: string | undefined, task: string): string[] | undefined {
    return this.state(id, false)?.semanticTasks.get(task);
  }

  setTaskSelection(id: string | undefined, task: string, selection: string[]): void {
    const state = this.state(id);
    if (!state) return;
    if (state.semanticTasks.size >= 64) {
      const oldest = state.semanticTasks.keys().next().value;
      if (oldest !== undefined) state.semanticTasks.delete(oldest);
    }
    state.semanticTasks.set(task, [...selection]);
  }

  delete(id: string | undefined): void {
    if (typeof id === "string" && id) this.states.delete(id);
  }

  clear(): void {
    this.states.clear();
  }
}

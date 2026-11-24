import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPlugin } from '../dist/plugin.js';
import { configure } from '../dist/core/config.js';
import { selectBindings, resolveBaselineMode } from '../dist/core/selection.js';
import { registerMeshPeer, registerRoleProfileResolver, resetMeshStateForTests } from '../dist/bridge.js';

const skill = (id, origin = 'global', extra = {}) => ({
  id, name: id, description: 'Safe code review', keywords: [], aliases: [], tags: [], triggers: [],
  negativeTriggers: [], roles: [], scope: 'native', origin, ...extra,
});
const hit = (s, score = 10, coverage = 1) => ({ skill: s, score, coverage });

const available = [skill('base-a'), skill('base-b'), skill('r1'), skill('r2'), skill('r3')];
const role = { allowed: ['base-a', 'base-b', 'r1', 'r2', 'r3'], default: ['base-a', 'base-b'], maxActive: 3 };
const ranked = [hit(available[2], 30), hit(available[3], 20), hit(available[4], 10)];
const input = { available, promptText: 'review', roleName: 'w', role, autoBind: 'all', ranked, minScore: 1 };

test('config: baselineMode defaults to adaptive and normalizes invalid values', () => {
  assert.equal(configure({}, { directory: '/tmp' }).baselineMode, 'adaptive');
  assert.equal(configure({ baselineMode: 'bogus' }, { directory: '/tmp' }).baselineMode, 'adaptive');
  assert.equal(configure({ baselineMode: 7 }, { directory: '/tmp' }).baselineMode, 'adaptive');
  assert.equal(configure({ baselineMode: 'always' }, { directory: '/tmp' }).baselineMode, 'always');
  assert.equal(configure({ baselineMode: 'fallback' }, { directory: '/tmp' }).baselineMode, 'fallback');
});

test('resolveBaselineMode: adaptive cues', () => {
  assert.equal(resolveBaselineMode('adaptive'), 'fallback');
  assert.equal(resolveBaselineMode('adaptive', { managedBy: 'other' }), 'fallback');
  assert.equal(resolveBaselineMode('adaptive', { managedBy: 'opencode-hi' }), 'always');
  assert.equal(resolveBaselineMode('adaptive', { bindingOwner: 'self' }), 'always');
  assert.equal(resolveBaselineMode('adaptive', { bindingOwner: 'external' }), 'always');
  assert.equal(resolveBaselineMode('adaptive', { bindingOwner: 'weird' }), 'fallback');
  assert.equal(resolveBaselineMode('always'), 'always');
  assert.equal(resolveBaselineMode('fallback', { managedBy: 'opencode-hi' }), 'fallback');
});

test('always: defaults first, router fills remaining slots, deduped and capped', () => {
  const r = selectBindings({ ...input, baselineMode: 'always' });
  assert.deepEqual(r.ids, ['base-a', 'base-b', 'r1']);
  assert.equal(r.source, 'router');
  const dup = selectBindings({ ...input, baselineMode: 'always', ranked: [hit(available[0], 99), ...ranked] });
  assert.deepEqual(dup.ids, ['base-a', 'base-b', 'r1']);
  const capped = selectBindings({ ...input, baselineMode: 'always', role: { ...role, maxActive: 1 } });
  assert.deepEqual(capped.ids, ['base-a']);
  assert.equal(capped.source, 'default');
});

test('always: defaults alone when router empty; router alone when no defaults; none when neither', () => {
  assert.deepEqual(selectBindings({ ...input, baselineMode: 'always', ranked: [] }).ids, ['base-a', 'base-b']);
  assert.deepEqual(selectBindings({ ...input, baselineMode: 'always', role: { ...role, default: [] } }).ids, ['r1', 'r2', 'r3']);
  const none = selectBindings({ ...input, baselineMode: 'always', ranked: [], role: { ...role, default: [] } });
  assert.deepEqual(none.ids, []);
  assert.equal(none.source, 'none');
});

test('always: thresholds, negative triggers and allowlist still apply to baseline', () => {
  const neg = [skill('base-a', 'global', { negativeTriggers: ['review'] }), ...available.slice(1)];
  assert.deepEqual(selectBindings({ ...input, available: neg, baselineMode: 'always', ranked: [] }).ids, ['base-b']);
  const low = selectBindings({ ...input, baselineMode: 'always', minScore: 100 });
  assert.deepEqual(low.ids, ['base-a', 'base-b']);
  const notAllowed = selectBindings({ ...input, baselineMode: 'always', role: { ...role, allowed: ['base-b', 'r1'] } });
  assert.deepEqual(notAllowed.ids, ['base-b', 'r1']);
  const missing = selectBindings({ ...input, baselineMode: 'always', role: { ...role, default: ['ghost', 'base-b'] }, ranked: [] });
  assert.deepEqual(missing.ids, ['base-b']);
});

test('always: host-origin baseline admitted, project provenance excluded', () => {
  const mixed = [skill('base-a', 'project'), skill('base-b', 'host'), skill('base-c', 'bundled'), skill('base-d', undefined)];
  const r = selectBindings({
    available: mixed, promptText: 'x', roleName: 'w', autoBind: 'all', ranked: [], baselineMode: 'always',
    role: { allowed: mixed.map((s) => s.id), default: mixed.map((s) => s.id), maxActive: 8 }, projectAutoBind: true,
  });
  assert.deepEqual(r.ids, ['base-b', 'base-c', 'base-d']);
  assert.ok(!r.ids.includes('base-a'));
});

test('fallback and absent param preserve either-or behavior', () => {
  for (const extra of [{ baselineMode: 'fallback' }, {}]) {
    assert.deepEqual(selectBindings({ ...input, ...extra }).ids, ['r1', 'r2', 'r3']);
    assert.deepEqual(selectBindings({ ...input, ...extra, ranked: [] }).ids, ['base-a', 'base-b']);
  }
  // adaptive without profile == fallback; with Hi profile == always
  assert.deepEqual(selectBindings({ ...input, baselineMode: 'adaptive' }).ids, ['r1', 'r2', 'r3']);
  assert.deepEqual(selectBindings({ ...input, baselineMode: 'adaptive', meshProfile: { managedBy: 'opencode-hi' } }).ids, ['base-a', 'base-b', 'r1']);
  assert.deepEqual(selectBindings({ ...input, baselineMode: 'adaptive', meshProfile: { bindingOwner: 'external' } }).ids, ['base-a', 'base-b', 'r1']);
  assert.deepEqual(selectBindings({ ...input, baselineMode: 'adaptive', meshProfile: { bindingOwner: 'nope' } }).ids, ['r1', 'r2', 'r3']);
});

test('pinned skills win over baseline', () => {
  const r = selectBindings({ ...input, baselineMode: 'always', requiredSkills: ['r3'] });
  assert.deepEqual(r.ids, ['r3']);
  assert.equal(r.source, 'task');
  const e = selectBindings({ ...input, baselineMode: 'always', promptText: 'skill:r2' });
  assert.deepEqual(e.ids, ['r2']);
});

function makeHost(root, options, native) {
  const hooks = new Map();
  const ctx = {
    options: { roots: [root], refreshMs: 0, hints: 'off', ...options },
    location: { directory: root, project: { canonical: root } },
    skill: { list: async () => ({ data: native }), transform: async (fn) => { fn({ list: () => native, update: () => {} }); return { dispose: async () => {} }; } },
    tool: { transform: async (fn) => { fn({ namespace: () => {}, add: () => {} }); return { dispose: async () => {} }; } },
    session: { get: async () => ({ data: { agent: 'hi-coder', parentID: 'p' } }), hook: async (n, f) => { hooks.set(n, f); return { dispose: async () => {} }; } },
  };
  return { ctx, hooks };
}

async function runHook(t, profile, prompt, options = {}) {
  resetMeshStateForTests();
  const root = await mkdtemp(join(tmpdir(), 'lse-baseline-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(registerMeshPeer({ id: 'opencode-hi', directory: root, capabilities: ['orchestration.task'] }));
  t.after(registerRoleProfileResolver({ owner: 'opencode-hi', directory: root, resolve: (id) => (id === 's1' ? profile : undefined) }));
  const native = ['base-a', 'r1'].map((id) => ({ id, name: id, description: 'Security audit review code' }));
  const host = makeHost(root, { autoBind: 'adaptive', minAutoScore: 1, ...options }, native);
  t.after(await createPlugin().setup(host.ctx));
  const ev = { sessionID: 's1', messageID: 'm1', prompt: { text: prompt, skills: [] } };
  await host.hooks.get('prompt')(ev);
  return ev.prompt.skills.map((s) => s.id);
}

const baseProfile = {
  sessionID: 's1', agentName: 'hi-coder', capability: 'write-allowed', access: 'read-write', taskID: 't1',
  allowedSkills: ['base-a', 'r1'], defaultSkills: [], maxActiveSkills: 2, autoBind: 'workers', managedBy: 'opencode-hi',
};

test('owner: absent keeps legacy automatic binding', async (t) => {
  const ids = await runHook(t, baseProfile, 'Security audit review code');
  assert.ok(ids.length > 0);
});

test('owner: external permits automatic binding; self suppresses it; unknown is absent', async (t) => {
  const ext = await runHook(t, { ...baseProfile, bindingOwner: 'external' }, 'Security audit review code');
  assert.ok(ext.length > 0);
  const self = await runHook(t, { ...baseProfile, bindingOwner: 'self' }, 'Security audit review code');
  assert.deepEqual(self, []);
  const unk = await runHook(t, { ...baseProfile, bindingOwner: 'bogus' }, 'Security audit review code');
  assert.ok(unk.length > 0);
});

test('owner self: explicit skill:<id> still attaches; self wins over autoBind all', async (t) => {
  const ids = await runHook(t, { ...baseProfile, bindingOwner: 'self' }, 'please use skill:r1', { autoBind: 'all' });
  assert.deepEqual(ids, ['r1']);
  const auto = await runHook(t, { ...baseProfile, bindingOwner: 'self' }, 'Security audit review code', { autoBind: 'all' });
  assert.deepEqual(auto, []);
});

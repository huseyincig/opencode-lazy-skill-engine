import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPlugin } from '../dist/plugin.js';
import { Catalog } from '../dist/core/catalog.js';
import { configure } from '../dist/core/config.js';
import { LAZY_SKILL_STATS_RPC } from '../dist/stats-rpc.js';
import { setup as setupTui } from '../dist/tui.js';
import { setup as setupStandaloneTui } from '../dist/tui-standalone.js';
import { resetMeshStateForTests } from '../dist/bridge.js';

test('TUI Finding 1 & 2 & 5 & Runtime: LazySidebar survives unmount/remount, passes location, deduplicates inflight RPC, and cleans up', async () => {
  assert.equal(await setupTui(null), undefined);
  assert.equal(await setupTui({}), undefined);

  const src = await readFile(new URL('../src/tui.tsx', import.meta.url), 'utf8');
  const runtimeOut = await readFile(new URL('../dist/tui-runtime.js', import.meta.url), 'utf8');
  const adaptiveOut = await readFile(new URL('../dist/tui.js', import.meta.url), 'utf8');

  // No-op createEffect should be removed
  assert.doesNotMatch(src, /createEffect\s*\(/, 'redundant no-op createEffect should be removed');

  // Adaptive dist/tui.js must guard standalone import with try/catch
  assert.match(adaptiveOut, /try\s*\{[\s\S]*tui-standalone\.js[\s\S]*\}\s*catch/, 'dist/tui.js must guard tui-standalone.js import with try/catch');

  // Runtime TUI bundle must use shared opentui:runtime-module:* imports
  assert.match(runtimeOut, /opentui:runtime-module:%40opentui%2Fsolid/);
  assert.match(runtimeOut, /opentui:runtime-module:solid-js/);

  // Real runtime test against dist/tui-standalone.js
  let rpcCalls = 0;
  let lastCallOpts = null;
  let resolvePendingRpc = null;
  let unsubscribed = 0;
  let slotCleared = 0;
  const listeners = new Map();
  let slotConfig = null;

  const mockContext = {
    location: { directory: '/tmp/lse-tui-rt' },
    ui: {
      slot: (cfg) => {
        slotConfig = cfg;
        return () => { slotCleared++; };
      },
    },
    data: {
      session: { active: () => ({ location: { directory: '/tmp/lse-tui-active' } }) },
      on: (type, cb) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(cb);
        return () => {
          listeners.get(type)?.delete(cb);
          unsubscribed++;
        };
      },
    },
    client: {
      rpc: () => ({
        snapshot: (_input, opts) => {
          rpcCalls++;
          lastCallOpts = opts;
          return new Promise((resolve) => {
            resolvePendingRpc = () => resolve({
              version: '1.5.0',
              catalogVersion: 1,
              ready: 'ready',
              skills: 3,
              local: 1,
              global: 2,
              conflicts: 0,
            });
          });
        },
      }),
    },
  };

  const cleanup = await setupStandaloneTui(mockContext);
  assert.equal(typeof cleanup, 'function');
  assert.ok(slotConfig && typeof slotConfig.render === 'function');

  // Trigger concurrent events while initial RPC is inflight -> must deduplicate to 1 call
  for (const cb of listeners.get('plugin.updated') ?? []) cb();
  for (const cb of listeners.get('skill.updated') ?? []) cb();
  assert.equal(rpcCalls, 1);
  assert.deepEqual(lastCallOpts, { location: { directory: '/tmp/lse-tui-active' } });

  resolvePendingRpc();
  await new Promise((r) => setTimeout(r, 10));

  // Trigger another skill.updated after first RPC settled -> must perform a 2nd RPC call
  for (const cb of listeners.get('skill.updated') ?? []) cb();
  assert.equal(rpcCalls, 2);
  resolvePendingRpc();
  await new Promise((r) => setTimeout(r, 10));

  // Source must reset snapshot to null when directory changes and RPC fails
  assert.match(src, /dirChanged[\s\S]*setSnapshot\(null\)/, 'TUI should reset stale snapshot when directory changes and RPC fails');

  // Cleanup must clear slot and unsubscribe events, and stop future refreshes
  cleanup();
  assert.equal(slotCleared, 1);
  assert.equal(unsubscribed, 2);
  for (const cb of listeners.get('skill.updated') ?? []) cb();
  assert.equal(rpcCalls, 2);
});

test('Finding 3: Catalog and scanVaults detect native-vs-vault, native-vs-native, and maxSkills-capped multi-vault conflicts', async t => {
  const root = await mkdtemp(join(tmpdir(), 'lse-tui-f3-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const vaultA = join(root, '.opencode', 'skill-vault');
  const vaultB = join(root, 'extra-vault');
  await mkdir(join(vaultA, 'shared-vault'), { recursive: true });
  await mkdir(join(vaultB, 'shared-vault'), { recursive: true });
  await mkdir(join(vaultA, 'native-shadow'), { recursive: true });
  await writeFile(join(vaultA, 'shared-vault', 'SKILL.md'), '---\ndescription: Vault A\n---\nBody A');
  await writeFile(join(vaultB, 'shared-vault', 'SKILL.md'), '---\ndescription: Vault B\n---\nBody B');
  await writeFile(join(vaultA, 'native-shadow', 'SKILL.md'), '---\ndescription: Vault shadow\n---\nBody S');

  // Set maxSkills: 2 so vaultA fills found.size === 2 before vaultB is walked; shared-vault conflict must still be detected!
  const opts = configure({ roots: [vaultB], maxSkills: 2 }, { directory: root, project: { canonical: root } });
  const catalog = new Catalog({
    skill: {
      list: async () => ({
        data: [
          { id: 'native-shadow', name: 'Native Shadow', description: 'Native in same project', path: join(root, '.opencode', 'skills', 'native-shadow', 'SKILL.md') },
          { id: 'dup-native', name: 'Dup Native 1', description: 'First native' },
          { id: 'dup-native', name: 'Dup Native 2', description: 'Second native with same id' },
        ],
      }),
    },
  }, opts);

  const st = await catalog.status();
  assert.ok(st.conflictIds.includes('shared-vault'), `expected maxSkills-capped multi-vault conflict shared-vault, got: ${st.conflictIds}`);
  assert.ok(st.conflictIds.includes('native-shadow'), `expected native-vs-vault conflict native-shadow, got: ${st.conflictIds}`);
  assert.ok(st.conflictIds.includes('dup-native'), `expected native-vs-native conflict dup-native, got: ${st.conflictIds}`);
});

test('Finding 4: LAZY_SKILL_STATS_RPC snapshot preserves both string version and numeric catalogVersion', async t => {
  resetMeshStateForTests();
  const root = await mkdtemp(join(tmpdir(), 'lse-tui-f4-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  let statsHandler = null;
  const host = {
    options: { roots: [root], refreshMs: 0, hints: 'off' },
    location: { directory: root, project: { canonical: root } },
    skill: { list: async () => ({ data: [{ id: 's1', name: 'S1', description: 'Skill 1' }] }), transform: async () => ({ dispose: async () => {} }) },
    tool: { transform: async () => ({ dispose: async () => {} }) },
    session: { get: async () => ({ data: {} }), hook: async () => ({ dispose: async () => {} }) },
    rpc: {
      register: async (def, handlers) => {
        if (def.id === LAZY_SKILL_STATS_RPC.id) statsHandler = handlers;
        return { dispose: async () => {} };
      },
    },
  };
  const cleanup = await createPlugin().setup(host);
  t.after(cleanup);

  const snap = await statsHandler.snapshot();
  assert.equal(typeof snap.version, 'string');
  assert.equal(typeof snap.catalogVersion, 'number');
  assert.ok(snap.catalogVersion >= 1);
});

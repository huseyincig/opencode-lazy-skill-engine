import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPlugin } from '../dist/plugin.js';
import { parseFrontmatter } from '../dist/core/scanner.js';
import { createSearchIndex, search } from '../dist/core/rank.js';
import { variants } from '../dist/core/text.js';
import {
  claimPromptSkillBinding,
  getMeshPeers,
  isMeshProtectedPart,
  queryMeshSkills,
  resetMeshStateForTests,
  stampMeshMetadata,
} from '../dist/bridge.js';

function makeHost(root, options = {}, native = [], extra = {}) {
  const tools = new Map();
  const hooks = new Map();
  const sessions = new Map();
  const subscribers = [];

  const ctx = {
    options: { roots: [root], refreshMs: 0, hints: 'off', ...options },
    location: { directory: root, project: { canonical: root } },
    skill: {
      list: async () => ({ data: native }),
      transform: async fn => {
        fn({ list: () => native, update: () => {} });
        return { dispose: async () => {} };
      },
    },
    tool: {
      transform: async fn => {
        fn({ namespace: () => {}, add: def => tools.set(`lazy_skill_${def.name}`, def) });
        return { dispose: async () => {} };
      },
    },
    session: {
      get: async ({ sessionID }) => ({ data: sessions.get(sessionID) ?? { agent: 'primary' } }),
      hook: async (name, fn) => {
        hooks.set(name, fn);
        return { dispose: async () => {} };
      },
    },
    event: {
      subscribe: ({ types, signal } = {}) => {
        const queue = [];
        let waiting = null;
        let closed = false;
        const close = () => {
          closed = true;
          if (waiting) {
            const w = waiting;
            waiting = null;
            w({ value: undefined, done: true });
          }
        };
        signal?.addEventListener?.('abort', close, { once: true });
        subscribers.push({
          push: ev => {
            if (closed || (types && !types.includes(ev.type))) return;
            if (waiting) {
              const w = waiting;
              waiting = null;
              w({ value: ev, done: false });
            } else {
              queue.push(ev);
            }
          },
        });
        return {
          [Symbol.asyncIterator]() {
            return {
              next() {
                if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
                if (closed) return Promise.resolve({ value: undefined, done: true });
                return new Promise(resolve => { waiting = resolve; });
              },
              return() {
                close();
                return Promise.resolve({ value: undefined, done: true });
              },
            };
          },
        };
      },
    },
    ...extra,
  };

  return {
    ctx,
    tools,
    hooks,
    sessions,
    emit(ev) {
      for (const sub of subscribers) sub.push(ev);
    },
  };
}

test('Debug Finding 1: isSyntheticMetadata passes sessionID to verify trusted mesh task-contract/skill-injection metadata', async t => {
  resetMeshStateForTests();
  const root = await mkdtemp(join(tmpdir(), 'lse-dbg-f1-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const host = makeHost(root, { autoBind: 'all' }, [
    { id: 'audit-skill', name: 'Audit', description: 'Security audit review code' },
  ]);
  const cleanup = await createPlugin().setup(host.ctx);
  t.after(cleanup);

  // task-contract does NOT set out.synthetic = true; it relies on provenance token + sessionID
  const meta = stampMeshMetadata('ses-1', { owner: 'peer-orchestrator', kind: 'task-contract' });
  assert.equal(meta.synthetic, undefined);

  const event = {
    sessionID: 'ses-1',
    prompt: { text: 'Security audit review code', skills: [] },
    metadata: meta,
  };
  await host.hooks.get('prompt')(event);
  assert.deepEqual(event.prompt.skills, []);
});

test('Debug Finding 2: setup(ctx) rolls back registerMeshPeer if a subsequent setup step throws', async t => {
  resetMeshStateForTests();
  const root = await mkdtemp(join(tmpdir(), 'lse-dbg-f2-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const host = makeHost(root, {}, [], {
    tool: {
      transform: async () => {
        throw new Error('Tool transform failed');
      },
    },
  });

  await assert.rejects(() => createPlugin().setup(host.ctx), /Tool transform failed/);
  assert.equal(getMeshPeers({ directory: root }).length, 0);
});

test('Debug Finding 3: queryMeshSkills works when allowedIds is an Array or query is an Array', async t => {
  resetMeshStateForTests();
  const root = await mkdtemp(join(tmpdir(), 'lse-dbg-f3-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const host = makeHost(root, {}, [
    { id: 'sec-a', name: 'Security A', description: 'Security audit check' },
    { id: 'sec-b', name: 'Security B', description: 'Security audit check' },
  ]);
  const cleanup = await createPlugin().setup(host.ctx);
  t.after(cleanup);

  const hitsByArrayAllowed = await queryMeshSkills('security audit', {
    directory: root,
    allowedIds: ['sec-b'],
  });
  assert.ok(Array.isArray(hitsByArrayAllowed));
  assert.deepEqual(hitsByArrayAllowed.map(h => h.id), ['sec-b']);

  const hitsByArrayQuery = await queryMeshSkills(['security', 'audit'], { directory: root });
  assert.ok(Array.isArray(hitsByArrayQuery));
  assert.equal(hitsByArrayQuery.length, 2);
});

test('Debug Finding 4: claimPromptSkillBinding skips duplicate semantic.select when another plugin already claimed turn', async t => {
  resetMeshStateForTests();
  const root = await mkdtemp(join(tmpdir(), 'lse-dbg-f4-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  let semanticCalls = 0;
  const host = makeHost(root, {
    autoBind: 'all',
    singleAgent: { minScore: 1 },
    semantic: { enabled: true, model: 'p/m' },
  }, [
    { id: 's1', name: 'S1', description: 'Alpha workflow' },
  ], {
    experimental: {
      generate: {
        text: async () => {
          semanticCalls++;
          return { text: '{"skills":["s1"]}' };
        },
      },
    },
  });
  const cleanup = await createPlugin().setup(host.ctx);
  t.after(cleanup);

  // Another plugin already claimed the turn
  claimPromptSkillBinding('ses-claim', 'msg-1', 'peer-orchestrator', ['s1']);
  const event = {
    sessionID: 'ses-claim',
    messageID: 'msg-1',
    prompt: { text: 'Alpha workflow', skills: [] },
  };
  await host.hooks.get('prompt')(event);
  assert.equal(semanticCalls, 0);
  assert.deepEqual(event.prompt.skills, [], 'should not auto-attach router/default skills when another plugin claimed the turn');

  // Explicit skill request (skill:s1) on a claimed turn should still be honored if not already bound
  const explicitEvent = {
    sessionID: 'ses-claim',
    messageID: 'msg-1',
    prompt: { text: 'Use skill:s1 explicitly', skills: [] },
  };
  await host.hooks.get('prompt')(explicitEvent);
  assert.deepEqual(explicitEvent.prompt.skills, [{ id: 's1' }]);
});

test('Debug Finding 5: parseFrontmatter handles empty frontmatter (---\\n---), multiline indented scalars, and ignores indented comments', () => {
  const emptyFm = '---\n---\nFirst paragraph\n\n---\n\nSecond paragraph';
  const parsedEmpty = parseFrontmatter(emptyFm);
  assert.equal(parsedEmpty.body.trim(), 'First paragraph\n\n---\n\nSecond paragraph');

  const multilineScalar = '---\ndescription:\n  First line\n  # indented comment should not add trailing space\n  second line\n  # trailing indented comment\n---\nBody content';
  const parsedMulti = parseFrontmatter(multilineScalar);
  assert.equal(parsedMulti.meta.description, 'First line second line');
  assert.equal(parsedMulti.body.trim(), 'Body content');
});

test('Debug Finding 6: session.deleted event cleans up mesh state and SessionLedger', async t => {
  resetMeshStateForTests();
  const root = await mkdtemp(join(tmpdir(), 'lse-dbg-f6-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const host = makeHost(root, { autoBind: 'all' }, [
    { id: 'audit-skill', name: 'Audit', description: 'Security audit' },
  ]);
  const cleanup = await createPlugin().setup(host.ctx);
  t.after(cleanup);

  await host.hooks.get('prompt')({
    sessionID: 'ses-del',
    prompt: { text: 'Run audit', skills: [] },
    metadata: { lazySkill: { requiredSkills: ['audit-skill'] } },
  });
  const statusBefore = JSON.parse((await host.tools.get('lazy_skill_status').execute({}, { sessionID: 'ses-del' })).content);
  assert.ok(statusBefore.receipt);

  host.emit({ type: 'session.deleted', properties: { info: { id: 'ses-del' } } });
  await new Promise(r => setTimeout(r, 10));

  const statusAfter = JSON.parse((await host.tools.get('lazy_skill_status').execute({}, { sessionID: 'ses-del' })).content);
  assert.equal(statusAfter.receipt, null);
});

test('Debug Finding 7: vault skill injection stamps metadata as skill-injection protected for peer context pruners', async t => {
  resetMeshStateForTests();
  const root = await mkdtemp(join(tmpdir(), 'lse-dbg-f7-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(join(root, 'vault-audit'), { recursive: true });
  await writeFile(join(root, 'vault-audit', 'SKILL.md'), '---\ndescription: Vault audit skill\n---\nCareful audit body.');

  const host = makeHost(root, { vaultAutoBind: true, projectAutoBind: true, autoBind: 'all', singleAgent: { minScore: 1 } }, []);
  const cleanup = await createPlugin().setup(host.ctx);
  t.after(cleanup);

  const event = {
    sessionID: 'ses-vault',
    prompt: { text: 'Run vault-audit skill', skills: [] },
    metadata: {},
  };
  await host.hooks.get('prompt')(event);
  assert.ok(event.prompt.text.includes('<lazy_bound_skill id="vault-audit"'));
  assert.equal(isMeshProtectedPart(event), true);
  assert.equal(event.metadata?.synthetic, undefined);
});

test('Debug Finding 8: duplicate concept mentions in query mask all occurrences so cross-lingual coverage stays 1.0', () => {
  const idx = createSearchIndex([
    { id: 'tr-sec', name: 'Güvenlik', description: 'Sistem güvenlik denetimi', keywords: [], aliases: [], tags: [], scope: 'vault' },
  ]);
  const hits = search(idx, 'security and cybersecurity', { topK: 1 });
  assert.equal(hits[0]?.skill.id, 'tr-sec');
  assert.equal(hits[0]?.coverage, 1);
});

test('Debug Finding 9: variants() reduces doubled consonants (running->run) and negative terms stem properly', () => {
  assert.ok(variants('running').includes('run'));
  assert.ok(variants('debugging').includes('debug'));

  const idx = createSearchIndex([
    { id: 'vuln-scan', name: 'Vulnerability', description: 'Find vulnerability in code', keywords: [], aliases: [], tags: [], scope: 'vault' },
  ]);
  const hits = search(idx, 'code -vulnerabilities', { topK: 5 });
  assert.equal(hits.length, 0);
});

test('Stats RPC snapshot returns string pkgVersion matching LAZY_SKILL_STATS_RPC output schema', async t => {
  resetMeshStateForTests();
  const root = await mkdtemp(join(tmpdir(), 'lse-dbg-rpc-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const { LAZY_SKILL_STATS_RPC } = await import('../dist/stats-rpc.js');
  let statsHandler = null;
  const host = makeHost(root, {}, [{ id: 's1', name: 'S1', description: 'Skill one' }], {
    rpc: {
      register: async (def, handlers) => {
        if (def.id === LAZY_SKILL_STATS_RPC.id) statsHandler = handlers;
        return { dispose: async () => {} };
      },
    },
  });
  const cleanup = await createPlugin().setup(host.ctx);
  t.after(cleanup);

  assert.ok(statsHandler, 'expected LAZY_SKILL_STATS_RPC handler to be registered');
  const snap = await statsHandler.snapshot();
  assert.equal(typeof snap.version, 'string');
  assert.match(snap.version, /^\d+\.\d+\.\d+/);
  for (const key of LAZY_SKILL_STATS_RPC.methods.snapshot.output.required) {
    assert.notEqual(snap[key], undefined, `missing required field ${key}`);
  }
});

test('Out-of-the-box defaults balance activation on relevant prompts without over-triggering', async () => {
  const { configure } = await import('../dist/core/config.js');
  const opts = configure({}, {});
  assert.equal(opts.maxAutoSkills, 4);
  assert.equal(opts.vaultAutoBind, true);
  assert.equal(opts.projectAutoBind, false);
  assert.equal(opts.bindExplicit, true);
  assert.equal(opts.hints, 'hint');
  assert.equal(opts.singleAgent.minScore, 2.5);
  assert.equal(opts.singleAgent.minCoverage, 0.3);
  assert.equal(opts.singleAgent.maxActive, 2);
});

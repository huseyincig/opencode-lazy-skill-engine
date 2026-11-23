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
  registerMeshPeer,
  registerRoleProfileResolver,
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

test('Mesh Interop 1: extractLazyTaskMeta and task delegation vs synthetic control nudge classification', async t => {
  resetMeshStateForTests();
  const root = await mkdtemp(join(tmpdir(), 'lse-mesh-interop-1-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const host = makeHost(root, { autoBind: 'all', hints: 'hint', singleAgent: { minScore: 1 } }, [
    { id: 'audit-skill', name: 'Audit', description: 'Security audit review code' },
    { id: 'req-skill', name: 'Required', description: 'Required task skill' },
  ]);
  host.sessions.set('worker-1', { agent: 'hi-coder', parentID: 'root-1' });
  const cleanup = await createPlugin().setup(host.ctx);
  t.after(cleanup);

  // 1a. Task delegation dispatch (hi-internal === "dispatch" + kind === "delegation") allows role-scoped auto selection
  const dispatchMeta = stampMeshMetadata(
    'worker-1',
    { owner: 'opencode-hi', kind: 'delegation', taskID: 'task-101' },
    { 'opencode-hi': true, 'opencode-smart-questions': true, 'hi-internal': 'dispatch' }
  );
  const dispatchEvent = {
    sessionID: 'worker-1',
    synthetic: true,
    prompt: { text: 'Security audit review code', skills: [], metadata: dispatchMeta },
  };
  await host.hooks.get('prompt')(dispatchEvent);
  assert.deepEqual(dispatchEvent.prompt.skills, [{ id: 'audit-skill' }]);

  // 1b. Task delegation dispatch also reads requiredSkills from prompt.metadata["opencode-mesh"]
  const meshReqEvent = {
    sessionID: 'worker-1',
    prompt: {
      text: 'Run task',
      skills: [],
      metadata: {
        'opencode-mesh': { v: 2, owner: 'opencode-hi', kind: 'delegation', token: 'tok', taskID: 'task-102', requiredSkills: ['req-skill'] },
      },
    },
  };
  await host.hooks.get('prompt')(meshReqEvent);
  assert.deepEqual(meshReqEvent.prompt.skills, [{ id: 'req-skill' }]);

  // 1c. Synthetic control nudges (silent-reprompt, continuation, guardian, smart-questions) skip automatic routing & hints
  const silentRepromptMeta = stampMeshMetadata(
    'worker-1',
    { owner: 'opencode-hi', kind: 'delegation', taskID: 'task-101', requiredSkills: ['req-skill'] },
    { 'opencode-hi': true, 'hi-internal': 'silent-reprompt' }
  );
  const silentRepromptEvent = {
    sessionID: 'worker-1',
    metadata: silentRepromptMeta,
    // req-skill is already bound; automatic routing for 'audit-skill' and hints must be skipped on silent-reprompt!
    prompt: { text: 'Security audit review code', skills: [{ id: 'req-skill' }] },
  };
  await host.hooks.get('prompt')(silentRepromptEvent);
  assert.deepEqual(silentRepromptEvent.prompt.skills, [{ id: 'req-skill' }]);
  assert.ok(!silentRepromptEvent.prompt.text.includes('<lazy_skill_suggestions'));

  for (const nudgeMeta of [
    { 'opencode-guardian': true },
    { 'opencode-smart-questions': true },
    { 'opencode-hi': true, 'hi-internal': 'continuation' },
    { 'opencode-hi': true, 'hi-internal': 'attention' },
    { 'opencode-hi': true, 'hi-internal': 'supervisor' },
    { 'opencode-hi': true, 'hi-internal': 'peer' },
  ]) {
    const ev = {
      sessionID: 'worker-1',
      metadata: nudgeMeta,
      prompt: { text: 'Security audit review code', skills: [] },
    };
    await host.hooks.get('prompt')(ev);
    assert.deepEqual(ev.prompt.skills, []);
    assert.ok(!ev.prompt.text.includes('<lazy_skill_suggestions'));
  }
});

test('Mesh Interop 2: opencode-hi role profile cooperation, empty claim avoidance, and hint suppression on claimed turns', async t => {
  resetMeshStateForTests();
  const root = await mkdtemp(join(tmpdir(), 'lse-mesh-interop-2-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const disposePeer = registerMeshPeer({
    id: 'opencode-hi',
    directory: root,
    capabilities: ['orchestration.task'],
  });
  t.after(disposePeer);

  const profiles = new Map();
  const disposeResolver = registerRoleProfileResolver({
    owner: 'opencode-hi',
    directory: root,
    resolve: (sessionID) => profiles.get(sessionID),
  });
  t.after(disposeResolver);

  let semanticResult = [];
  const host = makeHost(
    root,
    {
      autoBind: 'adaptive',
      mode: 'auto',
      hints: 'hint',
      minAutoScore: 1,
      semantic: { enabled: true, model: 'p/m' },
    },
    [
      { id: 'allowed-one', name: 'Allowed One', description: 'Security audit review code' },
      { id: 'allowed-two', name: 'Allowed Two', description: 'Security audit review code quality' },
      { id: 'forbidden-three', name: 'Forbidden Three', description: 'Security audit review code vulnerabilities' },
    ],
    {
      experimental: {
        generate: {
          text: async () => ({ text: JSON.stringify({ skills: semanticResult }) }),
        },
      },
    }
  );
  const cleanup = await createPlugin().setup(host.ctx);
  t.after(cleanup);

  // 2a. Primary manager session with autoBind: "workers" does not auto-bind in adaptive mode
  profiles.set('ses-manager', {
    sessionID: 'ses-manager',
    agentName: 'hi-manager',
    capability: 'write-allowed',
    access: 'primary',
    allowedSkills: ['allowed-one', 'allowed-two'],
    maxActiveSkills: 1,
    autoBind: 'workers',
    managedBy: 'opencode-hi',
  });
  const mgrEvent = {
    sessionID: 'ses-manager',
    prompt: { text: 'Security audit review code', skills: [] },
  };
  await host.hooks.get('prompt')(mgrEvent);
  assert.deepEqual(mgrEvent.prompt.skills, []);

  // 2b. Worker session respects opencode-hi allowedSkills and maxActiveSkills (1)
  profiles.set('ses-worker', {
    sessionID: 'ses-worker',
    agentName: 'hi-coder',
    capability: 'write-allowed',
    access: 'read-write',
    taskID: 'task-201',
    allowedSkills: ['allowed-one', 'allowed-two'],
    defaultSkills: ['allowed-two'],
    maxActiveSkills: 1,
    autoBind: 'workers',
    managedBy: 'opencode-hi',
  });
  const workerEvent = {
    sessionID: 'ses-worker',
    messageID: 'turn-w1',
    prompt: { text: 'Security audit review code vulnerabilities', skills: [] },
  };
  await host.hooks.get('prompt')(workerEvent);
  assert.equal(workerEvent.prompt.skills.length, 1);
  assert.ok(['allowed-one', 'allowed-two'].includes(workerEvent.prompt.skills[0].id));

  // 2c. When semantic.select returns [], LSE does NOT claim the turn with empty plan.ids
  semanticResult = [];
  const emptyEvent = {
    sessionID: 'ses-worker',
    messageID: 'turn-empty',
    prompt: { text: 'Completely unrelated prompt text xyzzy', skills: [] },
  };
  // Temporarily remove defaultSkills so lexical and default are empty and semantic runs
  profiles.set('ses-worker', {
    ...profiles.get('ses-worker'),
    defaultSkills: [],
  });
  await host.hooks.get('prompt')(emptyEvent);
  assert.deepEqual(emptyEvent.prompt.skills, []);
  const peerClaimAfterEmpty = claimPromptSkillBinding('ses-worker', 'turn-empty', 'opencode-hi', ['allowed-one']);
  assert.equal(peerClaimAfterEmpty.claimed, true, 'LSE must not claim turn when 0 skills were selected');

  // 2d. When another plugin already claimed the turn, LSE skips <lazy_skill_suggestions> hint injection
  claimPromptSkillBinding('ses-worker', 'turn-peer-claimed', 'opencode-hi', ['allowed-one']);
  const hintCheckEvent = {
    sessionID: 'ses-worker',
    messageID: 'turn-peer-claimed',
    prompt: { text: 'Security audit review code quality', skills: [] },
  };
  await host.hooks.get('prompt')(hintCheckEvent);
  assert.ok(!hintCheckEvent.prompt.text.includes('<lazy_skill_suggestions'));
});

test('Mesh Interop 3 & 4: registerSkillCatalogProvider scope sanitization & origin preservation, and session.deleted event shapes', async t => {
  resetMeshStateForTests();
  const root = await mkdtemp(join(tmpdir(), 'lse-mesh-interop-3-'));
  const extVault = await mkdtemp(join(tmpdir(), 'lse-mesh-ext-3-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(extVault, { recursive: true, force: true }));

  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(join(extVault, 'ext-sec'), { recursive: true });
  await writeFile(join(extVault, 'ext-sec', 'SKILL.md'), '---\ndescription: External security audit\n---\nExternal body');

  const projSkillDir = join(root, '.opencode', 'skill-vault', 'proj-sec');
  await mkdir(projSkillDir, { recursive: true });
  await writeFile(join(projSkillDir, 'SKILL.md'), '---\ndescription: Project security audit\n---\nProject body');

  const host = makeHost(root, { roots: [extVault], autoBind: 'all' }, [
    { id: 'host-sec', name: 'Host Sec', description: 'Host security audit' },
  ]);
  const cleanup = await createPlugin().setup(host.ctx);
  t.after(cleanup);

  // Invalid scope like "all" is sanitized instead of filtering out everything
  const hitsAllScope = await queryMeshSkills('security audit', {
    directory: root,
    scope: 'all',
  });
  assert.ok(Array.isArray(hitsAllScope));
  assert.equal(hitsAllScope.length, 3);
  const extHit = hitsAllScope.find((h) => h.id === 'ext-sec');
  const projHit = hitsAllScope.find((h) => h.id === 'proj-sec');
  const hostHit = hitsAllScope.find((h) => h.id === 'host-sec');
  assert.equal(extHit?.origin, 'host');
  assert.equal(projHit?.origin, 'project');
  assert.equal(hostHit?.origin, 'host');

  // Valid scope "vault" filters to vault only
  const hitsVault = await queryMeshSkills('security audit', {
    directory: root,
    scope: 'vault',
  });
  assert.equal(hitsVault.length, 2);
  assert.ok(hitsVault.every((h) => h.scope === 'vault'));

  // session.deleted supports ev.data.info.id, ev.data.sessionID, ev.data.id, ev.properties.id
  for (const [sid, payload] of [
    ['ses-d1', { type: 'session.deleted', properties: { id: 'ses-d1' } }],
    ['ses-d2', { type: 'session.deleted', data: { info: { id: 'ses-d2' } } }],
    ['ses-d3', { type: 'session.deleted', data: { sessionID: 'ses-d3' } }],
    ['ses-d4', { type: 'session.deleted', data: { id: 'ses-d4' } }],
  ]) {
    await host.hooks.get('prompt')({
      sessionID: sid,
      prompt: { text: 'Run audit', skills: [] },
      metadata: { lazySkill: { requiredSkills: ['host-sec'] } },
    });
    const before = JSON.parse((await host.tools.get('lazy_skill_status').execute({}, { sessionID: sid })).content);
    assert.ok(before.receipt);
    host.emit(payload);
    await new Promise((r) => setTimeout(r, 10));
    const after = JSON.parse((await host.tools.get('lazy_skill_status').execute({}, { sessionID: sid })).content);
    assert.equal(after.receipt, null, `expected session.deleted cleanup for ${sid}`);
  }
});

test('Deep Audit 1-5 & 7: lazy_skill_plan mesh parity, mesh/host permission enforcement on explicit & load/resource, mixed-meta nudge guard, hint permission filtering, and catalog fast retry', async t => {
  resetMeshStateForTests();
  const root = await mkdtemp(join(tmpdir(), 'lse-deep-audit-'));
  const extVault = await mkdtemp(join(tmpdir(), 'lse-deep-vault-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(extVault, { recursive: true, force: true }));

  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(join(extVault, 'vault-secret'), { recursive: true });
  await writeFile(
    join(extVault, 'vault-secret', 'SKILL.md'),
    '---\ndescription: Secret vault audit workflow\nnegativeTriggers: [do not audit]\n---\nSecret vault body'
  );

  const profiles = new Map();
  const disposeResolver = registerRoleProfileResolver({
    owner: 'opencode-hi',
    directory: root,
    resolve: (sessionID) => profiles.get(sessionID),
  });
  t.after(disposeResolver);

  let failNativeOnce = true;
  const nativeSkills = [
    { id: 'allowed-skill', name: 'Allowed', description: 'Allowed security workflow' },
    { id: 'forbidden-skill', name: 'Forbidden', description: 'Forbidden security workflow', autoinvoke: false },
  ];
  const host = makeHost(
    root,
    {
      roots: [extVault],
      refreshMs: 30000,
      hints: 'hint',
      minHintCoverage: 0.3,
      respectHostPermissions: true,
    },
    nativeSkills,
    {
      agent: {
        list: async () => ({
          data: [
            {
              id: 'restricted-worker',
              mode: 'subagent',
              permissions: [
                { action: 'skill', resource: '*', effect: 'deny' },
                { action: 'skill', resource: 'allowed-skill', effect: 'allow' },
              ],
            },
          ],
        }),
      },
    }
  );
  const origList = host.ctx.skill.list;
  host.ctx.skill.list = async () => {
    if (failNativeOnce) {
      failNativeOnce = false;
      throw new Error('transient native list error');
    }
    return origList();
  };

  const cleanup = await createPlugin().setup(host.ctx);
  t.after(cleanup);

  // Finding 7: Catalog recovers from transient native failure without waiting 30s
  const stAfterTransient = await host.tools.get('lazy_skill_status').execute({}, { sessionID: 'ses-1' });
  const parsedSt = JSON.parse(stAfterTransient.content);
  assert.equal(parsedSt.ready, ' partial'.trim() === 'partial' ? 'ready' : 'ready');

  // Set up mesh profile restricting ses-mesh-worker to allowed-skill only
  profiles.set('ses-mesh-worker', {
    sessionID: 'ses-mesh-worker',
    agentName: 'restricted-worker',
    capability: 'write-allowed',
    access: 'read-write',
    taskID: 'task-900',
    allowedSkills: ['allowed-skill'],
    maxActiveSkills: 1,
    autoBind: 'workers',
    managedBy: 'opencode-hi',
  });

  // Finding 1: lazy_skill_plan consults meshProfile when sessionID is provided
  const planRes = JSON.parse(
    (await host.tools.get('lazy_skill_plan').execute({ query: 'Allowed security workflow' }, { sessionID: 'ses-mesh-worker' })).content
  );
  assert.equal(planRes.agent, 'restricted-worker');
  assert.equal(planRes.mode, 'orchestrator');
  assert.deepEqual(planRes.ids, ['allowed-skill']);

  // Finding 2a: Explicit skill:forbidden-skill in prompt cannot bypass meshProfile.allowedSkills
  const explicitBypassEv = {
    sessionID: 'ses-mesh-worker',
    prompt: { text: 'Try using skill:forbidden-skill now', skills: [] },
  };
  await host.hooks.get('prompt')(explicitBypassEv);
  assert.deepEqual(explicitBypassEv.prompt.skills, []);

  // Finding 2b: lazy_skill_load enforces host agent permissions & meshProfile.allowedSkills on vault skills
  await assert.rejects(
    host.tools.get('lazy_skill_load').execute({ id: 'vault-secret' }, { sessionID: 'ses-mesh-worker', agent: 'restricted-worker' }),
    /denied by (host agent permissions|active role profile)/i
  );

  // Finding 3: Mixed metadata (prompt.metadata has delegation/dispatch, event.metadata has guardian/silent-reprompt) is treated as synthetic control nudge
  const mixedNudgeEv = {
    sessionID: 'ses-mesh-worker',
    metadata: { 'opencode-guardian': true, 'hi-internal': 'silent-reprompt' },
    prompt: {
      text: 'Allowed security workflow',
      skills: [],
      metadata: { 'hi-internal': 'dispatch', 'opencode-mesh': { kind: 'delegation' } },
    },
  };
  await host.hooks.get('prompt')(mixedNudgeEv);
  assert.deepEqual(mixedNudgeEv.prompt.skills, []);

  // Finding 5: Hints respect negativeTriggers and host agent permissions (neither forbidden-skill nor negative-triggered vault-secret is hinted)
  host.sessions.set('ses-hint-restricted', { agent: 'restricted-worker', parentID: 'root-1' });
  const hintEv = {
    sessionID: 'ses-hint-restricted',
    prompt: { text: 'Forbidden security workflow and secret vault audit workflow do not audit', skills: [] },
  };
  await host.hooks.get('prompt')(hintEv);
  assert.ok(!hintEv.prompt.text.includes('forbidden-skill'), 'denied skill must not be hinted');
  assert.ok(!hintEv.prompt.text.includes('vault-secret'), 'negative-triggered or denied vault skill must not be hinted');
});

test('Evaluation Report Fixes: lazy_skill_plan cross-role preview from primary session, bindReason/outsideRoleAllowed, selectBindings hostAllowed defense-in-depth, search summary matched, and status roleProfiles', async t => {
  resetMeshStateForTests();
  const root = await mkdtemp(join(tmpdir(), 'lse-eval-report-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const { selectBindings } = await import('../dist/core/selection.js');

  // 1. selectBindings enforces hostAllowed directly in required and explicit branches
  const sampleSkills = [
    { id: 'allowed-s', name: 'Allowed', description: 'Allowed skill', scope: 'native', origin: 'host', keywords: [], aliases: [], tags: [], triggers: [], negativeTriggers: [], roles: [] },
    { id: 'denied-s', name: 'Denied', description: 'Denied skill', scope: 'native', origin: 'host', keywords: [], aliases: [], tags: [], triggers: [], negativeTriggers: [], roles: [] },
  ];
  const hostAllowedSet = new Set(['allowed-s']);
  const reqDeniedPlan = selectBindings({
    available: sampleSkills,
    promptText: 'run task',
    requiredSkills: ['denied-s'],
    hostAllowed: hostAllowedSet,
  });
  assert.deepEqual(reqDeniedPlan.ids, []);
  assert.deepEqual(reqDeniedPlan.deniedRequired, ['denied-s']);

  const expDeniedPlan = selectBindings({
    available: sampleSkills,
    promptText: 'use skill:denied-s and skill:allowed-s',
    bindExplicit: true,
    hostAllowed: hostAllowedSet,
  });
  assert.deepEqual(expDeniedPlan.ids, ['allowed-s']);

  // 2. Live setup with configured roles + primary manager meshProfile calling lazy_skill_plan for worker roles
  const profiles = new Map();
  const disposeResolver = registerRoleProfileResolver({
    owner: 'opencode-hi',
    directory: root,
    resolve: (sessionID) => profiles.get(sessionID),
  });
  t.after(disposeResolver);

  profiles.set('ses-primary-mgr', {
    sessionID: 'ses-primary-mgr',
    agentName: 'hi-manager',
    capability: 'write-allowed',
    access: 'primary',
    allowedSkills: ['hi-task-orchestration'],
    maxActiveSkills: 2,
    autoBind: 'workers',
    managedBy: 'opencode-hi',
  });

  const host = makeHost(
    root,
    {
      mode: 'auto',
      autoBind: 'adaptive',
      minAutoScore: 1,
      roles: {
        'hi-manager': {
          default: ['hi-task-orchestration'],
          allowed: ['hi-task-orchestration', 'hi-deepwork'],
        },
        'hi-coder': {
          default: ['hi-implementation-verification'],
          allowed: ['hi-implementation-verification', 'opencode-plugin-quality'],
        },
        'hi-explorer': {
          default: ['hi-codebase-investigation'],
          allowed: ['hi-codebase-investigation'],
        },
      },
    },
    [
      { id: 'hi-task-orchestration', name: 'Task Orchestration', description: 'Orchestrate multi-agent tasks' },
      { id: 'hi-deepwork', name: 'Deepwork', description: 'Deep execution workflow' },
      { id: 'hi-implementation-verification', name: 'Implementation Verification', description: 'Verify code implementation and tests' },
      { id: 'opencode-plugin-quality', name: 'Plugin Quality', description: 'Release grade plugin verification and quality audit' },
      { id: 'hi-codebase-investigation', name: 'Codebase Investigation', description: 'Explore and analyze repository structure' },
    ]
  );
  const cleanup = await createPlugin().setup(host.ctx);
  t.after(cleanup);

  // Calling plan for hi-manager from ses-primary-mgr -> bindMode: "off", bindReason: "primary_session_off"
  const mgrPlan = JSON.parse(
    (await host.tools.get('lazy_skill_plan').execute({ query: 'Orchestrate multi-agent tasks', agent: 'hi-manager' }, { sessionID: 'ses-primary-mgr' })).content
  );
  assert.equal(mgrPlan.agent, 'hi-manager');
  assert.equal(mgrPlan.bindMode, 'off');
  assert.equal(mgrPlan.bindReason, 'primary_session_off');

  // Calling plan for hi-coder from ses-primary-mgr (without passing worker:true) -> decouples from caller's primary meshProfile!
  const coderPlan = JSON.parse(
    (await host.tools.get('lazy_skill_plan').execute({ query: 'Release grade plugin verification and quality audit', agent: 'hi-coder' }, { sessionID: 'ses-primary-mgr' })).content
  );
  assert.equal(coderPlan.agent, 'hi-coder');
  assert.equal(coderPlan.bindMode, 'workers');
  assert.equal(coderPlan.bindReason, 'bound');
  assert.ok(coderPlan.ids.includes('opencode-plugin-quality'));
  assert.deepEqual(coderPlan.outsideRoleAllowed, []);

  // Calling plan for hi-explorer with requiredSkills outside hi-explorer's role.allowed -> reports outsideRoleAllowed
  const explorerReqPlan = JSON.parse(
    (
      await host.tools.get('lazy_skill_plan').execute(
        { query: 'Explore repository', agent: 'hi-explorer', requiredSkills: ['opencode-plugin-quality'] },
        { sessionID: 'ses-primary-mgr' }
      )
    ).content
  );
  assert.deepEqual(explorerReqPlan.ids, ['opencode-plugin-quality']);
  assert.deepEqual(explorerReqPlan.outsideRoleAllowed, ['opencode-plugin-quality']);

  // 3. lazy_skill_search summary mode includes matched terms
  const searchSummary = JSON.parse(
    (await host.tools.get('lazy_skill_search').execute({ query: 'plugin quality audit' }, { sessionID: 'ses-primary-mgr' })).content
  );
  assert.equal(searchSummary.detail, 'summary');
  assert.ok(Array.isArray(searchSummary.results[0]?.matched));
  assert.ok(searchSummary.results[0].matched.length > 0);

  // 4. lazy_skill_status includes roleProfiles and vaultNote
  const statusOut = JSON.parse(
    (await host.tools.get('lazy_skill_status').execute({}, { sessionID: 'ses-primary-mgr' })).content
  );
  assert.equal(statusOut.roles, 3);
  assert.ok(statusOut.roleProfiles?.['hi-coder']);
  assert.equal(statusOut.roleProfiles['hi-coder'].allowedCount, 2);
  assert.equal(typeof statusOut.vaultNote, 'string');
});

test('OpenCode v2.4.0 alignment: plugin.updated cache invalidation, session.compaction.ended resets vault loads/hints, and structured Tool.Result output', async t => {
  resetMeshStateForTests();
  const root = await mkdtemp(join(tmpdir(), 'lse-v240-'));
  const vaultDir = join(root, 'v240-vault');
  t.after(() => rm(root, { recursive: true, force: true }));

  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(join(vaultDir, 'vault-guide'), { recursive: true });
  await writeFile(join(vaultDir, 'vault-guide', 'SKILL.md'), '---\ndescription: Guide for v2.4.0 compaction test\n---\nVault guide body');

  let nativeSkills = [{ id: 'init-skill', name: 'Init', description: 'Initial skill' }];
  const host = makeHost(
    root,
    { roots: [vaultDir], refreshMs: 30000, autoBind: 'all', projectAutoBind: true, singleAgent: { minScore: 1 } },
    nativeSkills
  );
  host.ctx.skill.list = async () => ({ data: nativeSkills });

  const cleanup = await createPlugin().setup(host.ctx);
  t.after(cleanup);

  // 1. Tool result includes structured `output` object alongside JSON `content`
  const searchRes = await host.tools.get('lazy_skill_search').execute({ query: 'Initial' }, { sessionID: 'ses-v240' });
  assert.equal(typeof searchRes.content, 'string');
  assert.ok(searchRes.output && typeof searchRes.output === 'object', 'Tool.Result must include structured output');
  assert.equal(searchRes.output.results[0]?.id, 'init-skill');

  // 2. plugin.updated invalidates catalog cache for hot-reloaded plugins
  nativeSkills = [
    { id: 'init-skill', name: 'Init', description: 'Initial skill' },
    { id: 'hot-reloaded-skill', name: 'Hot', description: 'Hot reloaded skill in v2.4.0' },
  ];
  host.emit({ type: 'plugin.updated' });
  await new Promise((r) => setTimeout(r, 15));
  const afterPluginUpdate = await host.tools.get('lazy_skill_search').execute({ query: 'Hot reloaded' }, { sessionID: 'ses-v240' });
  assert.equal(afterPluginUpdate.output.results[0]?.id, 'hot-reloaded-skill');

  // 3. session.compaction.ended resets vault loads/hints so vault skills can re-bind after compaction
  const ev1 = { sessionID: 'ses-compact', prompt: { text: 'Guide for v2.4.0 compaction test', skills: [] } };
  await host.hooks.get('prompt')(ev1);
  assert.ok(ev1.prompt.text.includes('<lazy_bound_skill id="vault-guide"'));

  // Before compaction, second turn skips re-injecting already-loaded vault skill
  const ev2 = { sessionID: 'ses-compact', prompt: { text: 'Guide for v2.4.0 compaction test', skills: [] } };
  await host.hooks.get('prompt')(ev2);
  assert.ok(!ev2.prompt.text.includes('<lazy_bound_skill id="vault-guide"'));

  // Emit session.compaction.ended (v2.4.0 durable event shape with data.sessionID)
  host.emit({ type: 'session.compaction.ended', data: { sessionID: 'ses-compact', reason: 'auto' } });
  await new Promise((r) => setTimeout(r, 15));

  const ev3 = { sessionID: 'ses-compact', prompt: { text: 'Guide for v2.4.0 compaction test', skills: [] } };
  await host.hooks.get('prompt')(ev3);
  assert.ok(ev3.prompt.text.includes('<lazy_bound_skill id="vault-guide"'), 'vault skill should re-bind after session.compaction.ended');
});

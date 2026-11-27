import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPlugin } from '../dist/plugin.js';
import { configure } from '../dist/core/config.js';
import { resetMeshStateForTests } from '../dist/bridge.js';

function makePreparedSkill(id, body = 'Follow strict security audit guidelines carefully.') {
  return `<skill_content name="${id}">\n# Skill: ${id}\n\n${body}\n</skill_content>`;
}

function makeReuseHost(root, { options = {}, native = [], contextMessages = () => [] } = {}) {
  const hooks = new Map();
  const tools = new Map();
  const eventQueue = [];
  const waiters = [];
  const emitEvent = (ev) => {
    if (waiters.length) waiters.shift()(ev);
    else eventQueue.push(ev);
  };
  const ctx = {
    options: { roots: [root], refreshMs: 0, hints: 'off', mode: 'single', autoBind: 'all', singleAgent: { minScore: 1, minCoverage: 0.2, maxActive: 3 }, ...options },
    location: { directory: root, project: { canonical: root } },
    event: {
      subscribe: ({ signal } = {}) => ({
        async *[Symbol.asyncIterator]() {
          while (!signal?.aborted) {
            if (eventQueue.length) {
              yield eventQueue.shift();
              continue;
            }
            const ev = await new Promise((resolve) => {
              const onAbort = () => resolve(null);
              signal?.addEventListener('abort', onAbort, { once: true });
              waiters.push((item) => {
                signal?.removeEventListener('abort', onAbort);
                resolve(item);
              });
            });
            if (ev === null) break;
            yield ev;
          }
        },
      }),
    },
    skill: {
      list: async () => ({ data: native }),
      transform: async (fn) => {
        fn({ list: () => native, update: () => {} });
        return { dispose: async () => {} };
      },
    },
    tool: {
      transform: async (fn) => {
        fn({
          namespace: () => {},
          add: (def) => tools.set(def.name, def),
        });
        return { dispose: async () => {} };
      },
    },
    session: {
      get: async () => ({ data: { agent: 'build' } }),
      context: async ({ sessionID }) => ({ messages: contextMessages(sessionID) }),
      hook: async (name, fn) => {
        hooks.set(name, fn);
        return { dispose: async () => {} };
      },
    },
  };
  return { ctx, hooks, tools, emitEvent };
}

test('Config: sessionReuse defaults to true and honors explicit false', () => {
  assert.equal(configure({}, { directory: '/tmp' }).sessionReuse, true);
  assert.equal(configure({ sessionReuse: false }, { directory: '/tmp' }).sessionReuse, false);
});

test('Reuse: skips re-attaching native skill when live session.context proves body is present, handles clock skew & >200 messages, and reports status stats', async (t) => {
  resetMeshStateForTests();
  const root = await mkdtemp(join(tmpdir(), 'lse-reuse-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const native = [
    {
      id: 'security-audit',
      name: 'Security Audit',
      description: 'Audit security boundaries and permissions',
      content: '---\nname: Security Audit\ndescription: Audit security boundaries and permissions\n---\nDetailed security checklist body.',
    },
  ];

  let liveMsgs = [];
  let contextCalls = 0;
  const host = makeReuseHost(root, {
    native,
    contextMessages: () => {
      contextCalls++;
      return liveMsgs;
    },
  });
  t.after(await createPlugin().setup(host.ctx));
  const promptHook = host.hooks.get('prompt');
  const statusTool = host.tools.get('status');

  // Turn 1: fresh attach (no prior ledger record -> should NOT even need to call session.context)
  const ev1 = { sessionID: 'ses-r1', messageID: 'msg_001', prompt: { text: 'Run security audit on permissions', skills: [] } };
  await promptHook(ev1);
  assert.deepEqual(ev1.prompt.skills.map((s) => s.id), ['security-audit']);
  assert.equal(contextCalls, 0, 'first turn with no prior record must skip session.context lookup');

  // Simulate host persisting msg_001 with createdAt 50ms BEFORE promptStartedAt (clock-order resilience!)
  // PLUS 240 extra conversation messages (> 200 messages must NOT break reuse!)
  const preparedText = makePreparedSkill('security-audit', 'Detailed security checklist body.');
  liveMsgs = [
    {
      id: 'msg_001',
      type: 'user',
      time: { created: Date.now() - 50 },
      skills: [{ id: 'security-audit', name: 'Security Audit', text: preparedText }],
    },
    ...Array.from({ length: 240 }, (_, i) => ({ id: `msg_${String(i + 2).padStart(3, '0')}`, type: 'assistant', text: 'ok' })),
  ];

  // Turn 2: live context proves security-audit is present -> must NOT re-attach!
  const ev2 = { sessionID: 'ses-r1', messageID: 'msg_300', prompt: { text: 'Another security audit on permissions', skills: [] } };
  await promptHook(ev2);
  assert.deepEqual(ev2.prompt.skills, [], 'proven live-context skill must not be re-attached on follow-up turn');
  assert.equal(contextCalls, 1);

  // Turn 3: now in "reusable" state with contentHash -> still reused!
  const ev3 = { sessionID: 'ses-r1', messageID: 'msg_301', prompt: { text: 'Third security audit on permissions', skills: [] } };
  await promptHook(ev3);
  assert.deepEqual(ev3.prompt.skills, [], 'reusable state must keep skipping re-attachment');

  // Check lazy_skill_status exposes sessionReuse and reuse stats (and schema declares them)
  const st = await statusTool.execute({}, { sessionID: 'ses-r1' });
  assert.equal(st.output.sessionReuse, true);
  assert.equal(st.output.reuse.events, 2);
  assert.ok(st.output.reuse.bytes >= Buffer.byteLength(preparedText, 'utf8') * 2);
  assert.ok(statusTool.output.properties.sessionReuse, 'STATUS_OUTPUT_SCHEMA must declare sessionReuse');
  assert.ok(statusTool.output.properties.reuse, 'STATUS_OUTPUT_SCHEMA must declare reuse');
});

test('Reuse fail-closed: re-attaches fresh after compaction, source edit, plugin.updated, missing context, or sessionReuse:false', async (t) => {
  resetMeshStateForTests();
  const root = await mkdtemp(join(tmpdir(), 'lse-reuse-fc-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const native = [
    {
      id: 'security-audit',
      name: 'Security Audit',
      description: 'Audit security boundaries and permissions',
      content: '---\ndescription: Audit security boundaries and permissions\n---\nVersion 1 body.',
    },
  ];
  const preparedV1 = makePreparedSkill('security-audit', 'Version 1 body.');
  let liveMsgs = [
    {
      id: 'msg_001',
      type: 'user',
      time: { created: Date.now() },
      skills: [{ id: 'security-audit', name: 'Security Audit', text: preparedV1 }],
    },
  ];

  const host = makeReuseHost(root, { native, contextMessages: () => liveMsgs });
  t.after(await createPlugin().setup(host.ctx));
  const promptHook = host.hooks.get('prompt');

  // Turn 1: attach
  const ev1 = { sessionID: 'ses-fc', messageID: 'msg_001', prompt: { text: 'Run security audit permissions', skills: [] } };
  await promptHook(ev1);
  assert.deepEqual(ev1.prompt.skills.map((s) => s.id), ['security-audit']);

  // Case A: Skill source content edited -> sourceHash mismatch -> MUST re-attach fresh!
  native[0].content = '---\ndescription: Audit security boundaries and permissions\n---\nVersion 2 updated body!';
  const ev2 = { sessionID: 'ses-fc', messageID: 'msg_002', prompt: { text: 'Run security audit permissions', skills: [] } };
  await promptHook(ev2);
  assert.deepEqual(ev2.prompt.skills.map((s) => s.id), ['security-audit'], 'edited skill sourceHash must force fresh attach');

  // Now simulate host context updated for v2 and verify reuse works
  liveMsgs = [
    {
      id: 'msg_002',
      type: 'user',
      time: { created: Date.now() },
      skills: [{ id: 'security-audit', name: 'Security Audit', text: makePreparedSkill('security-audit', 'Version 2 updated body!') }],
    },
  ];
  const ev3 = { sessionID: 'ses-fc', messageID: 'msg_003', prompt: { text: 'Run security audit permissions', skills: [] } };
  await promptHook(ev3);
  assert.deepEqual(ev3.prompt.skills, [], 'v2 should reuse when sourceHash and live context match');

  // Case B: session.compaction.started invalidates reuse -> next turn MUST re-attach fresh!
  host.emitEvent({ type: 'session.compaction.started', data: { sessionID: 'ses-fc' } });
  await new Promise((r) => setTimeout(r, 15));
  const ev4 = { sessionID: 'ses-fc', messageID: 'msg_004', prompt: { text: 'Run security audit permissions', skills: [] } };
  await promptHook(ev4);
  assert.deepEqual(ev4.prompt.skills.map((s) => s.id), ['security-audit'], 'compaction must invalidate reuse state');

  // Case C: plugin.updated invalidates reuse -> next turn MUST re-attach fresh!
  liveMsgs = [
    {
      id: 'msg_004',
      type: 'user',
      time: { created: Date.now() },
      skills: [{ id: 'security-audit', name: 'Security Audit', text: makePreparedSkill('security-audit', 'Version 2 updated body!') }],
    },
  ];
  host.emitEvent({ type: 'plugin.updated' });
  await new Promise((r) => setTimeout(r, 15));
  const ev5 = { sessionID: 'ses-fc', messageID: 'msg_005', prompt: { text: 'Run security audit permissions', skills: [] } };
  await promptHook(ev5);
  assert.deepEqual(ev5.prompt.skills.map((s) => s.id), ['security-audit'], 'plugin.updated must invalidate reuse state');

  // Case D: ctx.session.context throws -> fail-closed re-attaches fresh without throwing
  const hostErr = makeReuseHost(root, {
    native,
    contextMessages: () => {
      throw new Error('context unavailable');
    },
  });
  t.after(await createPlugin().setup(hostErr.ctx));
  const hookErr = hostErr.hooks.get('prompt');
  const err1 = { sessionID: 'ses-err', messageID: 'msg_e1', prompt: { text: 'Run security audit permissions', skills: [] } };
  await hookErr(err1);
  const err2 = { sessionID: 'ses-err', messageID: 'msg_e2', prompt: { text: 'Run security audit permissions', skills: [] } };
  await hookErr(err2);
  assert.deepEqual(err2.prompt.skills.map((s) => s.id), ['security-audit'], 'context lookup failure must fail-closed and attach fresh');

  // Case E: skill.updated invalidates reuse
  host.emitEvent({ type: 'skill.updated' });
  await new Promise((r) => setTimeout(r, 15));
  const ev6 = { sessionID: 'ses-fc', messageID: 'msg_006', prompt: { text: 'Run security audit permissions', skills: [] } };
  await promptHook(ev6);
  assert.deepEqual(ev6.prompt.skills.map((s) => s.id), ['security-audit'], 'skill.updated must invalidate reuse state');

  // Case F: sessionReuse:false disables reuse completely
  const hostOff = makeReuseHost(root, { options: { sessionReuse: false }, native, contextMessages: () => liveMsgs });
  t.after(await createPlugin().setup(hostOff.ctx));
  const hookOff = hostOff.hooks.get('prompt');
  const off1 = { sessionID: 'ses-off', messageID: 'msg_004', prompt: { text: 'Run security audit permissions', skills: [] } };
  await hookOff(off1);
  const off2 = { sessionID: 'ses-off', messageID: 'msg_006', prompt: { text: 'Run security audit permissions', skills: [] } };
  await hookOff(off2);
  assert.deepEqual(off2.prompt.skills.map((s) => s.id), ['security-audit'], 'sessionReuse:false must always re-attach');
});

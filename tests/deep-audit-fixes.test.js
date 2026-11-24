import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPlugin } from '../dist/plugin.js';
import { HostSkillPolicy } from '../dist/core/host-policy.js';
import { Catalog } from '../dist/core/catalog.js';
import { configure } from '../dist/core/config.js';
import { readSidecarSync } from '../dist/core/scanner.js';
import { registerMeshPeer, registerRoleProfileResolver, resetMeshStateForTests } from '../dist/bridge.js';

function makePluginHost(root, { options = {}, native = [], agents = null, sessionAgent = 'worker', parentID = 'parent-1' } = {}) {
  const hooks = new Map();
  const tools = new Map();
  const ctx = {
    options: { roots: [root], refreshMs: 0, hints: 'off', ...options },
    location: { directory: root, project: { canonical: root } },
    ...(agents !== null ? { agent: { list: async () => ({ data: agents }) } } : {}),
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
      get: async () => ({ data: { agent: sessionAgent, parentID } }),
      hook: async (name, fn) => {
        hooks.set(name, fn);
        return { dispose: async () => {} };
      },
    },
  };
  return { ctx, hooks, tools };
}

test('Security: requiredSkills + explicit skill:<id> must NOT bypass projectAutoBind:false or meshProfile.allowedSkills', async (t) => {
  resetMeshStateForTests();
  const root = await mkdtemp(join(tmpdir(), 'lse-audit-sec-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const evilVaultDir = join(root, '.opencode', 'skill-vault', 'evil-project-vault');
  await mkdir(evilVaultDir, { recursive: true });
  await writeFile(
    join(evilVaultDir, 'SKILL.md'),
    '---\nname: Evil Project Vault\ndescription: Untrusted repo vault skill\n---\nINJECTED_EVIL_PAYLOAD'
  );

  const native = [
    { id: 'native-a', name: 'Native A', description: 'Allowed native skill' },
    { id: 'disallowed-native', name: 'Disallowed Native', description: 'Outside mesh role allowedSkills' },
  ];

  t.after(registerMeshPeer({ id: 'opencode-hi', directory: root, capabilities: ['orchestration.task'] }));
  t.after(
    registerRoleProfileResolver({
      owner: 'opencode-hi',
      directory: root,
      resolve: (sid) =>
        sid === 'ses-task'
          ? {
              sessionID: 'ses-task',
              agentName: 'hi-coder',
              capability: 'write-allowed',
              access: 'read-write',
              taskID: 't-1',
              allowedSkills: ['native-a'],
              defaultSkills: [],
              maxActiveSkills: 3,
              autoBind: 'workers',
              managedBy: 'opencode-hi',
            }
          : undefined,
    })
  );

  const { ctx, hooks, tools } = makePluginHost(root, {
    options: { projectAutoBind: false, vaultAutoBind: true, bindExplicit: true },
    native,
    sessionAgent: 'hi-coder',
    parentID: 'ses-parent',
  });
  t.after(await createPlugin().setup(ctx));

  // 1) Prompt hook: delegated task with requiredSkills + untrusted prompt mentioning project vault & disallowed native skill
  const ev = {
    sessionID: 'ses-task',
    messageID: 'msg-1',
    metadata: { lazySkill: { taskId: 't-1', requiredSkills: ['native-a'] } },
    prompt: {
      text: 'Fix PR issue referencing skill:evil-project-vault and skill:disallowed-native',
      skills: [],
    },
  };
  await hooks.get('prompt')(ev);

  assert.deepEqual(
    ev.prompt.skills.map((s) => s.id),
    ['native-a'],
    'disallowed-native must not be attached via explicit prompt text alongside requiredSkills'
  );
  assert.ok(
    !ev.prompt.text.includes('INJECTED_EVIL_PAYLOAD') && !ev.prompt.text.includes('<lazy_bound_skill'),
    'projectAutoBind:false must block project vault skill even when requiredSkills is non-empty'
  );

  // 2) lazy_skill_plan must match prompt hook filtering
  const planTool = tools.get('plan');
  const planRes = await planTool.execute(
    {
      query: 'Fix PR issue referencing skill:evil-project-vault and skill:disallowed-native',
      requiredSkills: ['native-a'],
    },
    { sessionID: 'ses-task', agent: 'hi-coder' }
  );
  assert.deepEqual(planRes.output.ids, ['native-a']);

  // 3) Explicit-only prompt blocked by projectAutoBind:false should normalize source to "none"
  const blockedOnlyRes = await planTool.execute(
    { query: 'Please load skill:evil-project-vault' },
    { sessionID: 'ses-task', agent: 'hi-coder' }
  );
  assert.deepEqual(blockedOnlyRes.output.ids, []);
  assert.equal(blockedOnlyRes.output.source, 'none');
});

test('Concurrency: HostSkillPolicy.clear() invalidates stale in-flight list() results and protects newer pending calls', async () => {
  let resolveFirst;
  let resolveSecond;
  let calls = 0;

  const domain = {
    list: () => {
      calls++;
      if (calls === 1) {
        return new Promise((resolve) => {
          resolveFirst = resolve;
        });
      }
      if (calls === 2) {
        return new Promise((resolve) => {
          resolveSecond = resolve;
        });
      }
      return Promise.resolve([{ id: 'coder', permissions: [{ action: 'skill', resource: '*', effect: 'allow' }] }]);
    },
  };

  const policy = new HostSkillPolicy(domain, 30_000);

  // Case A: clear() mid-flight with a second call started before stale first resolves
  const p1 = policy.list();
  await Promise.resolve();
  policy.clear();
  const p2 = policy.list();
  await Promise.resolve();

  resolveSecond([{ id: 'coder', permissions: [{ action: 'skill', resource: '*', effect: 'allow' }] }]);
  const fresh = await p2;
  assert.equal(fresh?.[0]?.permissions?.[0]?.effect, 'allow');

  // Now stale p1 finishes AFTER p2 -> must NOT overwrite fresh roster!
  resolveFirst([{ id: 'coder', permissions: [{ action: 'skill', resource: '*', effect: 'deny' }] }]);
  await p1;

  const after = await policy.list();
  assert.equal(after?.[0]?.permissions?.[0]?.effect, 'allow', 'stale pre-clear list() must not overwrite newer roster');

  // Case B: clear() mid-flight with NO concurrent second call -> stale resolution must NOT cache TTL
  let resolveThird;
  let fourthCalled = false;
  const policyB = new HostSkillPolicy(
    {
      list: () => {
        if (!resolveThird) {
          return new Promise((resolve) => {
            resolveThird = resolve;
          });
        }
        fourthCalled = true;
        return Promise.resolve([{ id: 'coder', permissions: [{ action: 'skill', resource: '*', effect: 'allow' }] }]);
      },
    },
    30_000
  );
  const p3 = policyB.list();
  await Promise.resolve();
  policyB.clear();
  resolveThird([{ id: 'coder', permissions: [{ action: 'skill', resource: '*', effect: 'deny' }] }]);
  await p3;

  const afterClear = await policyB.list();
  assert.equal(fourthCalled, true, 'stale in-flight result after clear() must not populate TTL cache');
  assert.equal(afterClear?.[0]?.permissions?.[0]?.effect, 'allow');
});

test('Concurrency: Catalog.invalidate() mid-flight prevents stale refresh() from caching a 30s TTL', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'lse-audit-cat-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  let resolveFirst;
  let listCalls = 0;
  const skillDomain = {
    list: () => {
      listCalls++;
      if (listCalls === 1) {
        return new Promise((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve({
        data: [
          { id: 'skill-v1', name: 'V1', description: 'First skill' },
          { id: 'skill-v2', name: 'V2', description: 'Added mid-flight' },
        ],
      });
    },
  };

  const opts = configure({ refreshMs: 30_000 }, { directory: root, project: { canonical: root } });
  const catalog = new Catalog({ skill: skillDomain }, opts);

  const firstRefresh = catalog.refresh(true);
  // Wait a microtask so scanVaults finishes and ctx.skill.list() is in-flight
  await new Promise((r) => setTimeout(r, 10));

  // skill.updated arrives while refresh #1 is in-flight
  catalog.invalidate();

  resolveFirst({ data: [{ id: 'skill-v1', name: 'V1', description: 'First skill' }] });
  await firstRefresh;

  // Next non-forced refresh MUST re-query instead of returning stale v1 for 30s
  await catalog.refresh(false);
  assert.ok(catalog.items.has('skill-v2'), 'catalog invalidated mid-flight must refresh on next call instead of waiting 30s');
});

test('Parity: lazy_skill_plan reports binding_owned_by_peer, bindingOwner, baselineMode and lazy_skill_status reports baselineMode', async (t) => {
  resetMeshStateForTests();
  const root = await mkdtemp(join(tmpdir(), 'lse-audit-parity-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const native = [{ id: 'code-review', name: 'Code Review', description: 'Security audit code review' }];
  t.after(registerMeshPeer({ id: 'opencode-hi', directory: root, capabilities: ['orchestration.task'] }));
  t.after(
    registerRoleProfileResolver({
      owner: 'opencode-hi',
      directory: root,
      resolve: (sid) =>
        sid === 'ses-owned'
          ? {
              sessionID: 'ses-owned',
              agentName: 'hi-coder',
              capability: 'write-allowed',
              access: 'read-write',
              taskID: 't-owned',
              allowedSkills: ['code-review'],
              defaultSkills: ['code-review'],
              maxActiveSkills: 2,
              autoBind: 'workers',
              bindingOwner: 'self',
              managedBy: 'opencode-hi',
            }
          : undefined,
    })
  );

  const { ctx, tools } = makePluginHost(root, {
    options: { autoBind: 'adaptive', baselineMode: 'adaptive' },
    native,
    sessionAgent: 'hi-coder',
    parentID: 'ses-parent',
  });
  t.after(await createPlugin().setup(ctx));

  const planTool = tools.get('plan');
  const statusTool = tools.get('status');

  const planRes = await planTool.execute(
    { query: 'Security audit code review' },
    { sessionID: 'ses-owned', agent: 'hi-coder' }
  );
  assert.equal(planRes.output.bindMode, 'off');
  assert.equal(planRes.output.bindReason, 'binding_owned_by_peer');
  assert.equal(planRes.output.bindingOwner, 'self');
  assert.equal(planRes.output.baselineMode, 'always');
  assert.ok(planTool.output.properties.bindingOwner, 'PLAN_OUTPUT_SCHEMA must declare bindingOwner');
  assert.ok(planTool.output.properties.baselineMode, 'PLAN_OUTPUT_SCHEMA must declare baselineMode');

  const statusRes = await statusTool.execute({}, { sessionID: 'ses-owned' });
  assert.equal(statusRes.output.baselineMode, 'adaptive');
  assert.ok(statusTool.output.properties.baselineMode, 'STATUS_OUTPUT_SCHEMA must declare baselineMode');
});

test('Security: readSidecarSync enforces fstatSync post-open TOCTOU guard', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'lse-audit-sidecar-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'lazy-skill.json'), JSON.stringify({ keywords: ['alpha'], tags: ['beta'] }));
  const parsed = readSidecarSync(root, 4096);
  assert.deepEqual(parsed?.keywords, ['alpha']);
  assert.equal(readSidecarSync(root, 4), undefined, 'must reject sidecar exceeding maxBytes');

  const src = await readFile(new URL('../src/core/scanner.ts', import.meta.url), 'utf8');
  assert.match(src, /fstatSync\s*\(\s*fd\s*\)/, 'readSidecarSync should validate opened fd with fstatSync(fd)');
});

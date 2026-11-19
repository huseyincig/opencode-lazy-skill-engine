import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPlugin } from '../src/plugin.js';
import { normalizeNative } from '../src/core/catalog.js';
import { scanVaults } from '../src/core/scanner.js';
import { configure } from '../src/core/config.js';

function makeHost(root, options = {}, native = [], agents = null) {
  const tools = new Map();
  const hooks = new Map();
  const sessions = new Map();
  const skillTransforms = [];
  const subscribers = [];

  const ctx = {
    options: { roots: [root], refreshMs: 30000, hints: 'off', ...options },
    location: { directory: root, project: { canonical: root } },
    skill: {
      list: async () => ({ data: native }),
      transform: async fn => {
        skillTransforms.push(fn);
        fn({
          list: () => native,
          update: (id, cb) => {
            const item = native.find(s => s.id === id);
            if (item) cb(item);
          },
        });
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
          types: types ? new Set(types) : null,
          push: ev => {
            if (closed) return;
            if (types && !types.includes(ev.type)) return;
            if (waiting) {
              const w = waiting;
              waiting = null;
              w({ value: ev, done: false });
            } else {
              queue.push(ev);
            }
          },
          close,
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
    ...(agents ? { agent: { list: async () => ({ data: agents }) } } : {}),
  };

  return {
    ctx,
    tools,
    hooks,
    sessions,
    emit(ev) {
      for (const sub of subscribers) sub.push(ev);
    },
    replaySkillTransforms() {
      for (const fn of skillTransforms) {
        fn({
          list: () => native,
          update: (id, cb) => {
            const item = native.find(s => s.id === id);
            if (item) cb(item);
          },
        });
      }
    },
  };
}

test('Finding 1: late-loaded plugin skills & agents invalidate 30s catalog/policy cache via event/transform', async t => {
  const root = await mkdtemp(join(tmpdir(), 'lse-v232-f1-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const native = [{ id: 'initial-skill', name: 'Initial', description: 'Initial native skill' }];
  const agents = [{ id: 'manager', mode: 'primary', permissions: [] }];
  const host = makeHost(root, { nativeCatalog: 'hide', refreshMs: 30000 }, native, agents);

  const cleanup = await createPlugin().setup(host.ctx);
  t.after(cleanup);

  // Another plugin loads later and registers a skill + restricted worker agent
  native.push({ id: 'late-plugin-skill', name: 'Late', description: 'Security audit workflow' });
  agents.push({
    id: 'worker',
    mode: 'subagent',
    permissions: [{ action: 'skill', resource: 'late-plugin-skill', effect: 'allow' }],
  });
  host.replaySkillTransforms();
  host.emit({ type: 'skill.updated' });
  host.emit({ type: 'agent.updated' });
  await new Promise(r => setTimeout(r, 10));

  const searchRes = JSON.parse((await host.tools.get('lazy_skill_search').execute({ query: 'late-plugin-skill' }, {})).content);
  assert.equal(searchRes.results[0]?.id, 'late-plugin-skill');
  assert.equal(native.find(s => s.id === 'late-plugin-skill')?.autoinvoke, false);

  // Verify hostPolicy also invalidated so plan sees new worker permission
  const planRes = JSON.parse((await host.tools.get('lazy_skill_plan').execute({
    query: 'security audit',
    agent: 'worker',
    worker: true,
    requiredSkills: ['late-plugin-skill'],
  }, {})).content);
  assert.deepEqual(planRes.ids, ['late-plugin-skill']);
});

test('Finding 2: normalizeNative accepts Skill.Info with optional/omitted description via frontmatter or name fallback', () => {
  const opts = configure({ roots: ['/tmp'] });
  const normalized = normalizeNative([
    {
      id: 'fm-only',
      name: 'FM Only',
      content: '---\ndescription: Description from frontmatter\nkeywords: [audit]\n---\nBody here',
    },
    {
      id: 'name-only',
      name: 'Name Only Skill',
      content: 'Plain body without frontmatter',
    },
  ], opts);

  assert.equal(normalized.length, 2);
  assert.equal(normalized[0].id, 'fm-only');
  assert.equal(normalized[0].description, 'Description from frontmatter');
  assert.equal(normalized[1].id, 'name-only');
  assert.equal(normalized[1].description, 'Name Only Skill');
});

test('Finding 3: bindExplicit:false prevents skill:<id> in prompt text from bypassing role/singleAgent allowlist', async t => {
  const root = await mkdtemp(join(tmpdir(), 'lse-v232-f3-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const native = [
    { id: 'allowed-skill', name: 'Allowed', description: 'Allowed skill' },
    { id: 'secret-skill', name: 'Secret', description: 'Restricted secret skill' },
  ];
  const host = makeHost(root, { bindExplicit: false, autoBind: 'all', singleAgent: { allowed: ['allowed-skill'] } }, native);
  const cleanup = await createPlugin().setup(host.ctx);
  t.after(cleanup);

  const event = {
    sessionID: 's1',
    prompt: { text: 'Please check skill:secret-skill in this unrelated prompt', skills: [] },
  };
  await host.hooks.get('prompt')(event);
  assert.deepEqual(event.prompt.skills, []);
});

test('Finding 4: scanVaults does not starve project root when global root hits maxSkills', async t => {
  const root = await mkdtemp(join(tmpdir(), 'lse-v232-f4-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const globalVault = join(root, 'global');
  const projectVault = join(root, 'project');
  await mkdir(join(globalVault, 'g1'), { recursive: true });
  await mkdir(join(globalVault, 'g2'), { recursive: true });
  await mkdir(join(projectVault, 'p1'), { recursive: true });

  await writeFile(join(globalVault, 'g1', 'SKILL.md'), '---\ndescription: Global one\n---\nBody');
  await writeFile(join(globalVault, 'g2', 'SKILL.md'), '---\ndescription: Global two\n---\nBody');
  await writeFile(join(projectVault, 'p1', 'SKILL.md'), '---\ndescription: Project one\n---\nBody');

  const opts = configure({ roots: [globalVault, projectVault], maxSkills: 2 });
  // Ensure roots order has globalVault before projectVault for the test
  const customOpts = { ...opts, roots: [globalVault, projectVault] };
  const scanned = await scanVaults(customOpts);
  const ids = scanned.skills.map(s => s.id);
  assert.ok(ids.includes('p1'), `expected project skill p1 not to be starved, got: ${ids.join(',')}`);
});

test('Finding 5: lazy_skill_info rejects missing id/ids and empty ids array clearly', async t => {
  const root = await mkdtemp(join(tmpdir(), 'lse-v232-f5-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const host = makeHost(root, {}, []);
  const cleanup = await createPlugin().setup(host.ctx);
  t.after(cleanup);

  await assert.rejects(() => host.tools.get('lazy_skill_info').execute({}, {}), /Provide id or a non-empty ids array/);
  await assert.rejects(() => host.tools.get('lazy_skill_info').execute({ ids: [] }, {}), /Provide id or a non-empty ids array/);
});

test('Finding 6: lazy_skill_search rejects empty or whitespace-only array queries instead of listing all skills', async t => {
  const root = await mkdtemp(join(tmpdir(), 'lse-v232-f6-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const host = makeHost(root, {}, [{ id: 's1', name: 'S1', description: 'Skill one' }]);
  const cleanup = await createPlugin().setup(host.ctx);
  t.after(cleanup);

  await assert.rejects(() => host.tools.get('lazy_skill_search').execute({ query: [] }, {}), /Query array must contain/);
  await assert.rejects(() => host.tools.get('lazy_skill_search').execute({ query: ['   '] }, {}), /Query array must contain/);
});

test('Finding 7: cooperative abort signal checked after async steps in search/info/plan/status', async t => {
  const root = await mkdtemp(join(tmpdir(), 'lse-v232-f7-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const ac = new AbortController();
  const host = makeHost(root, { refreshMs: 0 }, [{ id: 's1', name: 'S1', description: 'Skill one' }]);
  const cleanup = await createPlugin().setup(host.ctx);
  t.after(cleanup);

  const origList = host.ctx.skill.list;
  host.ctx.skill.list = async () => {
    ac.abort();
    return origList();
  };

  await assert.rejects(
    () => host.tools.get('lazy_skill_search').execute({ query: 'Skill' }, { signal: ac.signal }),
    /aborted/
  );
});

test('Finding 8: lazy_skill_plan reports semanticSkipped when semantic routing is enabled', async t => {
  const root = await mkdtemp(join(tmpdir(), 'lse-v232-f8-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const host = makeHost(root, { semantic: { enabled: true } }, [{ id: 's1', name: 'S1', description: 'Skill one' }]);
  const cleanup = await createPlugin().setup(host.ctx);
  t.after(cleanup);

  const planRes = JSON.parse((await host.tools.get('lazy_skill_plan').execute({ query: 'do something' }, {})).content);
  assert.equal(planRes.semanticSkipped, true);
});

test('Finding 9: prompt hook detects nested plugin synthetic/autoContinue metadata', async t => {
  const root = await mkdtemp(join(tmpdir(), 'lse-v232-f9-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const host = makeHost(root, { autoBind: 'all' }, [
    { id: 'audit-skill', name: 'Audit', description: 'Security audit review code' },
  ]);
  const cleanup = await createPlugin().setup(host.ctx);
  t.after(cleanup);

  const event = {
    sessionID: 's1',
    prompt: { text: 'Security audit review code', skills: [] },
    metadata: { 'opencode-smart-questions': { autoContinue: true } },
  };
  await host.hooks.get('prompt')(event);
  assert.deepEqual(event.prompt.skills, []);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPlugin } from '../dist/plugin.js';
import { tokenize, variants } from '../dist/core/text.js';
import { createSearchIndex, search } from '../dist/core/rank.js';
import { isOrchestratedRoster } from '../dist/core/host-policy.js';
import { parseSemanticIDs } from '../dist/core/semantic.js';
import { normalizeNative } from '../dist/core/catalog.js';
import { parseFrontmatter } from '../dist/core/scanner.js';
import { configure } from '../dist/core/config.js';

function makeHost(root, options = {}, native = [], agents = null) {
  const tools = new Map(), hooks = new Map(), sessions = new Map();
  const ctx = {
    options: { roots: [root], refreshMs: 0, hints: 'off', ...options },
    location: { directory: root, project: { canonical: root } },
    skill: {
      list: async () => ({ data: native }),
      transform: async fn => {
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
    ...(agents ? { agent: { list: async () => ({ data: agents }) } } : {}),
  };
  return { ctx, tools, hooks, sessions };
}

test('Lesson 1: camelCase splitting and Turkish/English stemming improve recall', () => {
  assert.ok(tokenize('openCodePlugin').includes('open'));
  assert.ok(tokenize('openCodePlugin').includes('code'));
  assert.ok(tokenize('openCodePlugin').includes('plugin'));
  assert.ok(variants('yapilandirmasini').includes('yapilandirma'));
  assert.ok(variants('running').includes('runn') || variants('running').includes('run'));
  assert.ok(variants('vulnerabilities').includes('vulnerability'));

  const idx = createSearchIndex([
    { id: 'cfg', name: 'Yapılandırma', description: 'Sistem yapılandırma ayarları', keywords: [], aliases: [], tags: [], scope: 'vault' },
    { id: 'vuln', name: 'Vulnerability', description: 'Find vulnerability in code', keywords: [], aliases: [], tags: [], scope: 'vault' },
  ]);
  assert.equal(search(idx, 'yapılandırmasını', { topK: 1 })[0]?.skill.id, 'cfg');
  assert.equal(search(idx, 'vulnerabilities', { topK: 1 })[0]?.skill.id, 'vuln');
});

test('Lesson 2: isOrchestratedRoster detects subagents with non-skill restrictions (edit/shell/subagent/*)', () => {
  const roster = [
    { id: 'manager', mode: 'primary', permissions: [{ action: 'skill', resource: '*', effect: 'allow' }] },
    {
      id: 'explorer',
      mode: 'subagent',
      permissions: [
        { action: '*', resource: '*', effect: 'deny' },
        { action: 'skill', resource: '*', effect: 'allow' },
        { action: 'edit', resource: '*', effect: 'deny' },
      ],
    },
  ];
  assert.equal(isOrchestratedRoster(roster), true);
});

test('Lesson 3: parseSemanticIDs strips markdown code fences while remaining strict on prose', () => {
  const allowed = new Set(['api-review', 'code-audit']);
  assert.deepEqual(
    parseSemanticIDs('```json\n{"skills":["api-review"]}\n```', allowed, 2),
    ['api-review']
  );
  assert.deepEqual(parseSemanticIDs('Sure: {"skills":["api-review"]}', allowed, 2), []);
});

test('Lesson 4: normalizeNative detects project origin from .opencode/skills when path is omitted', async t => {
  const root = await mkdtemp(join(tmpdir(), 'lazy-lesson-4-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.opencode', 'skills', 'local-proj'), { recursive: true });
  await writeFile(join(root, '.opencode', 'skills', 'local-proj', 'SKILL.md'), '---\ndescription: Local\n---\nBody');
  const opts = configure({ roots: [] }, { directory: root, project: { canonical: root } });
  const normalized = normalizeNative([{ id: 'local-proj', description: 'Local' }], opts);
  assert.equal(normalized[0]?.origin, 'project');
});

test('Lesson 5: synthetic/internal prompts skip automatic binding and hints', async t => {
  const root = await mkdtemp(join(tmpdir(), 'lazy-lesson-5-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const native = [{ id: 'api-review', name: 'API Review', description: 'Review API authentication security' }];
  const m = makeHost(root, { hints: 'hint', autoBind: 'all' }, native);
  const cleanup = await createPlugin().setup(m.ctx);
  t.after(cleanup);
  const ev = {
    sessionID: 's1',
    metadata: { synthetic: true },
    prompt: { text: 'Review API authentication security' },
  };
  await m.hooks.get('prompt')(ev);
  assert.equal(ev.prompt.skills, undefined);
  assert.equal(ev.prompt.text, 'Review API authentication security');
});

test('Lesson 6: parseFrontmatter strips inline comments and rejects YAML anchors/tags', () => {
  const parsed = parseFrontmatter('---\nname: "Safe #1" # trailing comment\nkeywords: [review, security] # inline\ntags: &anchor\naliases: !unsafe\n---\nBody');
  assert.equal(parsed.meta.name, 'Safe #1');
  assert.deepEqual(parsed.meta.keywords, ['review', 'security']);
  assert.equal(parsed.meta.tags, undefined);
  assert.equal(parsed.meta.aliases, undefined);
});

test('Lesson 7: lazy_skill_info supports batch ids and lazy_skill_search supports array queries', async t => {
  const root = await mkdtemp(join(tmpdir(), 'lazy-lesson-7-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const native = [
    { id: 'api-review', name: 'API Review', description: 'Review API authentication' },
    { id: 'code-audit', name: 'Code Audit', description: 'Audit code quality' },
  ];
  const m = makeHost(root, {}, native);
  const cleanup = await createPlugin().setup(m.ctx);
  t.after(cleanup);

  const searchRes = JSON.parse((await m.tools.get('lazy_skill_search').execute({ query: ['api', 'authentication'] }, { sessionID: 's1' })).content);
  assert.equal(searchRes.results[0]?.id, 'api-review');

  const infoRes = JSON.parse((await m.tools.get('lazy_skill_info').execute({ ids: ['api-review', 'code-audit'] }, { sessionID: 's1' })).content);
  assert.equal(infoRes.results.length, 2);
  assert.deepEqual(infoRes.results.map(r => r.id), ['api-review', 'code-audit']);
});

test('Lesson 8: nativeCatalog=hide injects on-demand discovery guidance into context hook once', async t => {
  const root = await mkdtemp(join(tmpdir(), 'lazy-lesson-8-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const native = [{ id: 'api-review', name: 'API Review', description: 'Review API authentication', autoinvoke: true }];
  const m = makeHost(root, { nativeCatalog: 'hide' }, native);
  const cleanup = await createPlugin().setup(m.ctx);
  t.after(cleanup);

  const ctxHook = m.hooks.get('context');
  assert.ok(ctxHook);
  const ev = { sessionID: 's1', system: [] };
  await ctxHook(ev);
  assert.equal(ev.system.length, 1);
  assert.match(ev.system[0].text, /lazy_skill_search/);
  await ctxHook(ev);
  assert.equal(ev.system.length, 1);
});

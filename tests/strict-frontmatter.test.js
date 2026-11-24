import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSearchIndex, search } from '../dist/core/rank.js';
import { scanVaults, parseFrontmatter, extractDerivedSignals, parseSidecarJson } from '../dist/core/scanner.js';
import { normalizeNative } from '../dist/core/catalog.js';
import { configure } from '../dist/core/config.js';
import { matchConcepts } from '../dist/core/concepts.js';
import { detectLanguage } from '../dist/core/text.js';
import { createPlugin } from '../dist/plugin.js';

const strictSkill = (id, description, extra = {}) => ({
  id,
  name: id,
  description,
  keywords: [],
  aliases: [],
  tags: [],
  triggers: [],
  negativeTriggers: [],
  languages: [],
  roles: [],
  origin: 'host',
  path: null,
  base: null,
  scope: 'native',
  source: 'native',
  trust: 'native',
  autoinvoke: true,
  ...extra,
});

function makeHost(root, options = {}, native = []) {
  const tools = new Map();
  const hooks = new Map();
  const ctx = {
    options: { roots: [root], refreshMs: 0, hints: 'off', ...options },
    location: { directory: root, project: { canonical: root } },
    skill: {
      list: async () => ({ data: native }),
      transform: async (fn) => {
        fn({ list: () => native, update: () => {} });
        return { dispose: async () => {} };
      },
    },
    tool: {
      transform: async (fn) => {
        fn({ namespace: () => {}, add: (def) => tools.set(`lazy_skill_${def.name}`, def) });
        return { dispose: async () => {} };
      },
    },
    session: {
      get: async () => ({ data: { agent: 'build' } }),
      hook: async (name, fn) => {
        hooks.set(name, fn);
        return { dispose: async () => {} };
      },
    },
  };
  return { ctx, tools, hooks };
}

// ---------------------------------------------------------------------------
// 1. Strict-frontmatter compatible BM25F scoring (rank.ts)
// ---------------------------------------------------------------------------

test('BM25F avg[f] ignores empty fields so sparse metadata does not distort length normalization', () => {
  const skills = [
    ...Array.from({ length: 20 }, (_, i) =>
      strictSkill(`std-skill-${i}`, `Standard skill number ${i} for workflow tasks`)
    ),
    strictSkill('rich-a', 'Rich skill alpha', {
      keywords: ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa'],
    }),
    strictSkill('rich-b', 'Rich skill beta', {
      keywords: ['lambda', 'mu', 'nu', 'xi', 'omicron', 'pi', 'rho', 'sigma', 'tau', 'upsilon'],
    }),
  ];
  const idx = createSearchIndex(skills);
  // Only 2 docs have non-empty keywords (~10+ tokens each).
  // Previously avg.keywords would be diluted by 20 empty docs to ~1.8.
  assert.ok(
    idx.avg.keywords >= 8,
    `Expected avg.keywords >= 8 computed over non-empty docs only, got ${idx.avg.keywords}`
  );
  assert.equal(idx.avg.tags, 1, 'Fully empty field safely falls back to 1');
});

test('Strict name+description skill competes fairly with rich-frontmatter skills and clears minAutoScore/singleAgent.minScore', () => {
  const skills = [
    strictSkill(
      'opencode-v2-advanced-plugin',
      'Use when implementing OpenCode V2 Code Mode (execute, @opencode/codemode, structured tool output, pinned catalog), experimental Automations (client.experimental.automation), RPC, Effect 4 plugins, HTTP/MCP/Solid clients, embedded SDK hosts or Cloudflare Workerd.'
    ),
    strictSkill(
      'opencode-v2-server-plugin',
      'Use when developing or auditing OpenCode V2 Promise server plugins: Plugin.define, hooks, domain transforms (model.transform, provider.transform, tool.transform), permissions, policies, Code Mode tool options, background shell/compaction, sessions and disposal.'
    ),
    strictSkill(
      'opencode-v2-cli-plugin',
      'Use when building, migrating or debugging OpenCode V2 terminal TUI plugins with @opencode/plugin/tui, Solid/OpenTUI, sidebar slots, session panels, dialogs, keymaps, SyntaxStyle cleanup and remote clients.'
    ),
    strictSkill(
      'opencode-v2-gui-plugin',
      'Use when developing, packaging or verifying experimental OpenCode V2 Desktop GUI plugins, Electron window/main boundaries, Solid UI, Vite single-file CJS, IPC, side panels, themes, Browser contract, BridgeLayout and Settings plugin updates.'
    ),
    strictSkill(
      'opencode-agent-security-audit',
      'Use when auditing security boundaries in any OpenCode V2 plugin: prompt injection, permission/policy escalation, child-agent privileges, Code Mode execute fallback, Automation FORBIDDEN_TOOLS, timed-out background shell, Desktop browser tools, skill supply-chain provenance and evidence integrity.'
    ),
    // Competing rich-frontmatter skills with heavily populated keywords/triggers/tags/aliases
    strictSkill('rich-general-helper', 'General helper for building developer tools and plugins', {
      keywords: ['plugin', 'opencode', 'tools', 'developer', 'automation'],
      triggers: ['build plugin', 'developer tool', 'automation helper'],
      tags: ['plugin', 'dev', 'automation', 'tools'],
      aliases: ['plugin helper', 'general automation'],
    }),
    strictSkill('rich-basic-security', 'Basic checklist for general web security', {
      keywords: ['security', 'audit', 'plugin', 'check'],
      triggers: ['security check', 'audit web'],
      tags: ['security', 'audit'],
      aliases: ['web security audit'],
    }),
  ];

  const idx = createSearchIndex(skills);

  const advHits = search(idx, 'implementing OpenCode V2 Code Mode experimental Automations', { topK: 5 });
  assert.equal(advHits[0]?.skill.id, 'opencode-v2-advanced-plugin', JSON.stringify(advHits.map((h) => [h.skill.id, h.score])));
  assert.ok(advHits[0].score >= 2.5, `Expected strict skill score >= 2.5, got ${advHits[0].score}`);

  const srvHits = search(idx, 'Plugin.define model.transform background compaction hooks', { topK: 5 });
  assert.equal(srvHits[0]?.skill.id, 'opencode-v2-server-plugin', JSON.stringify(srvHits.map((h) => [h.skill.id, h.score])));
  assert.ok(srvHits[0].score >= 2.5, `Expected score >= 2.5, got ${srvHits[0].score}`);

  const secHits = search(idx, 'permission policy escalation FORBIDDEN_TOOLS prompt injection security audit', { topK: 5 });
  assert.equal(secHits[0]?.skill.id, 'opencode-agent-security-audit', JSON.stringify(secHits.map((h) => [h.skill.id, h.score])));
  assert.ok(secHits[0].score >= 2.5, `Expected score >= 2.5, got ${secHits[0].score}`);

  // Unrelated prompt must still stay empty or well below threshold
  const unrelated = search(idx, 'bake sourdough bread recipe oven temperature', { topK: 5 });
  assert.equal(unrelated.length, 0);
});

test('Explicit frontmatter keywords retain slightly higher authority than synthetic derived signals on tie', () => {
  const explicit = strictSkill('alpha-explicit', 'Workflow guide for widgets', {
    keywords: ['codemode'],
  });
  const derived = strictSkill('alpha-derived', 'Workflow guide for widgets', {
    derivedKeywords: ['codemode'],
  });
  const idx = createSearchIndex([explicit, derived]);
  const hits = search(idx, 'codemode', { topK: 2 });
  assert.equal(hits[0]?.skill.id, 'alpha-explicit');
  assert.ok(hits[0].score > hits[1].score, `Expected explicit (${hits[0].score}) > derived (${hits[1].score})`);
});

// ---------------------------------------------------------------------------
// 2. Safe auto-extraction from description and bounded body prefix (scanner.ts)
// ---------------------------------------------------------------------------

test('Scanner auto-extracts technical identifiers, Use when phrases, and bounded headings for standard skills without polluting explicit keywords', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'lazy-strict-extract-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const dir = join(root, 'opencode-v2-cli-plugin');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'SKILL.md'),
    [
      '---',
      'name: opencode-v2-cli-plugin',
      'description: "Use when building, migrating or debugging OpenCode V2 terminal TUI plugins with `@opencode/plugin/tui`, Solid/OpenTUI, sidebar slots, `SyntaxStyle` cleanup, `context.data.job.list`, and read-only dialogs."',
      '---',
      '',
      '# OpenCode V2 Terminal TUI Plugins',
      '',
      '## Overview',
      'Boilerplate overview heading should be skipped.',
      '',
      '## Sidebar Slots and Keymap Lifecycle',
      '```bash',
      '# shell comment inside code fence must never be extracted',
      'echo ok',
      '```',
      '',
      '## Remote Client Diagnostics',
      'Details here.',
    ].join('\n')
  );

  const opts = configure({ roots: [root] }, { directory: root });
  const res = await scanVaults({ ...opts, roots: [root] });
  assert.equal(res.skills.length, 1);
  const s = res.skills[0];

  // Explicit keywords/triggers remain untouched (empty)
  assert.deepEqual(s.keywords, []);
  assert.deepEqual(s.triggers, []);

  // Derived technical identifiers extracted
  assert.ok(Array.isArray(s.derivedKeywords) && s.derivedKeywords.length > 0, 'expected derivedKeywords');
  assert.ok(s.derivedKeywords.includes('@opencode/plugin/tui'), JSON.stringify(s.derivedKeywords));
  assert.ok(s.derivedKeywords.includes('SyntaxStyle'), JSON.stringify(s.derivedKeywords));
  assert.ok(s.derivedKeywords.includes('context.data.job.list'), JSON.stringify(s.derivedKeywords));
  assert.ok(s.derivedKeywords.includes('read-only'), JSON.stringify(s.derivedKeywords));

  // Derived aliases include Use when phrase + meaningful headings, excluding code comments & boilerplate
  assert.ok(Array.isArray(s.derivedAliases) && s.derivedAliases.length > 0, 'expected derivedAliases');
  assert.ok(
    s.derivedAliases.some((a) => /Sidebar Slots and Keymap Lifecycle/i.test(a)),
    JSON.stringify(s.derivedAliases)
  );
  assert.ok(
    s.derivedAliases.every((a) => !/shell comment/i.test(a)),
    'must not extract comments inside fenced code blocks'
  );
  assert.ok(
    s.derivedAliases.every((a) => a.toLowerCase() !== 'overview'),
    'must skip generic boilerplate headings'
  );
});

test('Scanner bounded-prefix security prevents reading headings beyond maxFrontmatterBytes in large bodies', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'lazy-strict-bounded-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const dir = join(root, 'huge-body-skill');
  await mkdir(dir, { recursive: true });
  const padding = 'Plain prose line with nothing special.\n'.repeat(400); // ~15KB
  await writeFile(
    join(dir, 'SKILL.md'),
    `---\nname: huge-body-skill\ndescription: Small standard description.\n---\n\n# Early Heading\n\n${padding}\n## Deep Secret Heading Far Beyond Prefix\n`
  );

  const opts = configure({ roots: [root], maxFrontmatterBytes: 1024, maxSkillBytes: 100000 }, { directory: root });
  const res = await scanVaults({ ...opts, roots: [root] });
  assert.equal(res.skills.length, 1);
  const s = res.skills[0];
  assert.ok(s.derivedAliases?.some((a) => /Early Heading/i.test(a)), JSON.stringify(s.derivedAliases));
  assert.ok(
    (s.derivedAliases ?? []).every((a) => !/Deep Secret Heading/i.test(a)),
    'must never index headings beyond bounded prefix'
  );
});

test('normalizeNative also derives technical identifiers and headings for standard native skills', () => {
  const opts = configure({}, { directory: '/tmp/repo' });
  const native = normalizeNative(
    [
      {
        id: 'opencode-v2-server-plugin',
        name: 'opencode-v2-server-plugin',
        description: 'Use when developing OpenCode V2 Promise server plugins: Plugin.define, model.transform, background compaction.',
        content: '---\nname: opencode-v2-server-plugin\ndescription: Use when developing OpenCode V2 Promise server plugins\n---\n\n# Promise Server Plugin Lifecycle\n',
      },
    ],
    opts
  );
  assert.equal(native.length, 1);
  assert.deepEqual(native[0].keywords, []);
  assert.ok(native[0].derivedKeywords?.includes('Plugin.define'), JSON.stringify(native[0].derivedKeywords));
  assert.ok(native[0].derivedKeywords?.includes('model.transform'), JSON.stringify(native[0].derivedKeywords));
  assert.ok(native[0].derivedAliases?.some((a) => /Promise Server Plugin Lifecycle/i.test(a)), JSON.stringify(native[0].derivedAliases));
});

// ---------------------------------------------------------------------------
// 3. Optional sidecar metadata (skill.meta.json / lazy-skill.json)
// ---------------------------------------------------------------------------

test('Sidecar skill.meta.json and lazy-skill.json enrich pure SKILL.md skills, merge with options.rules, and invalidate cache on edit', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'lazy-sidecar-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const dirA = join(root, 'pure-standard-skill');
  await mkdir(dirA, { recursive: true });
  await writeFile(
    join(dirA, 'SKILL.md'),
    '---\nname: pure-standard-skill\ndescription: Pure Agent Skills compliant skill with no custom frontmatter.\n---\n# Body\n'
  );
  await writeFile(
    join(dirA, 'skill.meta.json'),
    JSON.stringify({
      keywords: ['sidecar-kw', 'compaction'],
      triggers: ['context compaction'],
      tags: ['sidecar-tag'],
      negativeTriggers: ['do not compact'],
      languages: ['en', 'tr', 'invalid-lang'],
      roles: ['hi-coder', 'BAD ROLE'],
    })
  );

  const dirB = join(root, 'lazy-json-skill');
  await mkdir(dirB, { recursive: true });
  await writeFile(
    join(dirB, 'SKILL.md'),
    '---\nname: lazy-json-skill\ndescription: Uses lazy-skill.json sidecar.\n---\n# Body\n'
  );
  await writeFile(
    join(dirB, 'lazy-skill.json'),
    JSON.stringify({ keywords: ['from-lazy-json'], tags: ['preferred'] })
  );
  await writeFile(
    join(dirB, 'skill.meta.json'),
    JSON.stringify({ keywords: ['from-skill-meta'], tags: ['fallback'] })
  );

  const cache = new Map();
  const opts = configure(
    { roots: [root], rules: { 'pure-standard-skill': ['rule-kw'] } },
    { directory: root }
  );
  const r1 = await scanVaults({ ...opts, roots: [root] }, cache);
  const a = r1.skills.find((x) => x.id === 'pure-standard-skill');
  assert.ok(a);
  assert.ok(a.keywords.includes('sidecar-kw'));
  assert.ok(a.keywords.includes('rule-kw'));
  assert.deepEqual(a.triggers, ['context compaction']);
  assert.deepEqual(a.tags, ['sidecar-tag']);
  assert.deepEqual(a.negativeTriggers, ['do not compact']);
  assert.deepEqual(a.languages, ['en', 'tr']);
  assert.deepEqual(a.roles, ['hi-coder']);

  const b = r1.skills.find((x) => x.id === 'lazy-json-skill');
  assert.ok(b);
  assert.ok(b.keywords.includes('from-lazy-json'));

  // Second scan with unchanged files reuses cache
  const r2 = await scanVaults({ ...opts, roots: [root] }, cache);
  assert.equal(r2.metadataReads, 0);
  assert.equal(r2.metadataReuses, 2);

  // Editing sidecar invalidates cache even when SKILL.md is untouched
  await writeFile(
    join(dirA, 'skill.meta.json'),
    JSON.stringify({ keywords: ['updated-sidecar-kw'], tags: ['v2'] })
  );
  const r3 = await scanVaults({ ...opts, roots: [root] }, cache);
  assert.equal(r3.metadataReads, 1);
  const aUpdated = r3.skills.find((x) => x.id === 'pure-standard-skill');
  assert.ok(aUpdated.keywords.includes('updated-sidecar-kw'));
  assert.deepEqual(aUpdated.tags, ['v2']);
});

test('Sidecar security: symlink escape, malformed JSON, and oversized sidecar are safely rejected without crashing scan', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'lazy-sidecar-sec-'));
  const outside = await mkdtemp(join(tmpdir(), 'lazy-sidecar-out-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(outside, { recursive: true, force: true }));

  await writeFile(join(outside, 'secret.json'), JSON.stringify({ keywords: ['exfiltrated-secret'] }));

  const symDir = join(root, 'symlink-sidecar');
  await mkdir(symDir, { recursive: true });
  await writeFile(join(symDir, 'SKILL.md'), '---\nname: symlink-sidecar\ndescription: Symlink sidecar test\n---\nBody');
  await symlink(join(outside, 'secret.json'), join(symDir, 'skill.meta.json'));

  const badDir = join(root, 'bad-json-sidecar');
  await mkdir(badDir, { recursive: true });
  await writeFile(join(badDir, 'SKILL.md'), '---\nname: bad-json-sidecar\ndescription: Malformed sidecar test\n---\nBody');
  await writeFile(join(badDir, 'skill.meta.json'), '{not valid json');

  const bigDir = join(root, 'oversize-sidecar');
  await mkdir(bigDir, { recursive: true });
  await writeFile(join(bigDir, 'SKILL.md'), '---\nname: oversize-sidecar\ndescription: Oversize sidecar test\n---\nBody');
  await writeFile(join(bigDir, 'skill.meta.json'), JSON.stringify({ keywords: ['x'.repeat(20000)] }));

  const opts = configure({ roots: [root], maxFrontmatterBytes: 1024 }, { directory: root });
  const res = await scanVaults({ ...opts, roots: [root] });
  assert.equal(res.skills.length, 3);

  const symSkill = res.skills.find((x) => x.id === 'symlink-sidecar');
  assert.equal(symSkill.keywords.includes('exfiltrated-secret'), false, 'symlinked sidecar must never be read');

  const badSkill = res.skills.find((x) => x.id === 'bad-json-sidecar');
  assert.deepEqual(badSkill.keywords, []);

  const bigSkill = res.skills.find((x) => x.id === 'oversize-sidecar');
  assert.deepEqual(bigSkill.keywords, []);
});

test('Native skills also load optional sidecar metadata when path points to skill directory', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'lazy-native-sidecar-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const skillDir = join(root, 'native-std');
  await mkdir(skillDir, { recursive: true });
  const skillFile = join(skillDir, 'SKILL.md');
  await writeFile(skillFile, '---\nname: native-std\ndescription: Pure native skill\n---\n# Body');
  await writeFile(join(skillDir, 'skill.meta.json'), JSON.stringify({ keywords: ['native-sidecar-kw'], tags: ['native-tag'] }));

  const opts = configure({ rules: { 'native-std': ['from-rules'] } }, { directory: root });
  const res = normalizeNative([{ id: 'native-std', name: 'native-std', description: 'Pure native skill', path: skillFile }], opts);
  assert.equal(res.length, 1);
  assert.ok(res[0].keywords.includes('native-sidecar-kw'));
  assert.ok(res[0].keywords.includes('from-rules'));
  assert.deepEqual(res[0].tags, ['native-tag']);
});

// ---------------------------------------------------------------------------
// 4. Multilingual concept bridge & Turkish -> English standard skill discovery
// ---------------------------------------------------------------------------

test('Multilingual concept bridge maps Turkish plugin, automation, permission, security, cache, compaction, and UI terms cleanly', () => {
  assert.equal(matchConcepts('eklenti geliştirme').has('plugin'), true);
  assert.equal(matchConcepts('plugin development').has('plugin'), true);

  assert.equal(matchConcepts('izin ve yetki kontrolü').has('permission'), true);
  assert.equal(matchConcepts('permission and policy escalation').has('permission'), true);

  assert.equal(matchConcepts('otomasyon akışı').has('automation'), true);
  assert.equal(matchConcepts('experimental automations').has('automation'), true);

  assert.equal(matchConcepts('önbelleği ve önbellekleme').has('caching'), true);
  assert.equal(matchConcepts('prompt-cache cached tokens').has('caching'), true);

  assert.equal(matchConcepts('bağlam sıkıştırma işlemi').has('compaction'), true);
  assert.equal(matchConcepts('background compaction cost').has('compaction'), true);

  assert.equal(matchConcepts('masaüstü grafik arayüzü').has('ui'), true);
  assert.equal(matchConcepts('terminal TUI sidebar panel').has('ui'), true);

  // Word-boundary safety: no false substring hits
  assert.equal(matchConcepts('guide intuition suite').has('ui'), false);

  // Language detection recognizes Turkish technical prompts
  assert.equal(detectLanguage('eklenti izin ve sıkıştırma kontrolü'), 'tr');
});

test('Turkish & English prompts accurately discover and auto-bind opencode-writing-plugins-skills-v2 standard skills alongside rich skills', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'lazy-v2-tr-en-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const standardNativeSkills = [
    {
      id: 'opencode-v2-server-plugin',
      name: 'opencode-v2-server-plugin',
      description:
        'Use when developing or auditing OpenCode V2 Promise server plugins: Plugin.define, hooks, domain transforms (model.transform, provider.transform, tool.transform), permissions, policies, Code Mode tool options, background shell/compaction, sessions and disposal.',
      autoinvoke: true,
    },
    {
      id: 'opencode-v2-cli-plugin',
      name: 'opencode-v2-cli-plugin',
      description:
        'Use when building, migrating or debugging OpenCode V2 terminal TUI plugins with @opencode/plugin/tui, Solid/OpenTUI, sidebar slots, session panels, dialogs, keymaps, SyntaxStyle cleanup and remote clients.',
      autoinvoke: true,
    },
    {
      id: 'opencode-v2-gui-plugin',
      name: 'opencode-v2-gui-plugin',
      description:
        'Use when developing, packaging or verifying experimental OpenCode V2 Desktop GUI plugins, Electron window/main boundaries, Solid UI, Vite single-file CJS, IPC, side panels, themes, Browser contract, BridgeLayout and Settings plugin updates.',
      autoinvoke: true,
    },
    {
      id: 'opencode-v2-advanced-plugin',
      name: 'opencode-v2-advanced-plugin',
      description:
        'Use when implementing OpenCode V2 Code Mode (execute, @opencode/codemode, structured tool output, pinned catalog), experimental Automations (client.experimental.automation), RPC, Effect 4 plugins, HTTP/MCP/Solid clients, embedded SDK hosts or Cloudflare Workerd.',
      autoinvoke: true,
    },
    {
      id: 'opencode-agent-security-audit',
      name: 'opencode-agent-security-audit',
      description:
        'Use when auditing security boundaries in any OpenCode V2 plugin: prompt injection, permission/policy escalation, child-agent privileges, Code Mode execute fallback, Automation FORBIDDEN_TOOLS, timed-out background shell, Desktop browser tools, skill supply-chain provenance and evidence integrity.',
      autoinvoke: true,
    },
    {
      id: 'opencode-agent-evaluation',
      name: 'opencode-agent-evaluation',
      description:
        'Use when evaluating multi-agent orchestration and tool efficiency in any OpenCode V2 plugin: delegation accuracy, Direct Tools vs Code Mode benchmarks, measured prompt-cache hit rates (cached vs uncached tokens), background compaction cost, latency and recovery.',
      autoinvoke: true,
    },
    // Competing rich-frontmatter distractor skill
    {
      id: 'generic-rich-helper',
      name: 'Generic Rich Helper',
      description: 'General notes about repositories and scripts',
      keywords: ['plugin', 'security', 'cache', 'automation', 'ui'],
      triggers: ['help plugin', 'general check'],
      tags: ['general', 'helper', 'tools'],
      autoinvoke: true,
    },
  ];

  const host = makeHost(root, {}, standardNativeSkills);
  const cleanup = await createPlugin().setup(host.ctx);
  t.after(cleanup);

  const searchTool = host.tools.get('lazy_skill_search');
  const queryCases = [
    ['TR security+permission', 'eklenti güvenlik denetimi ve izin yetki yükseltme', 'opencode-agent-security-audit'],
    ['TR cache+compaction', 'çoklu ajan önbellek isabet oranı ve sıkıştırma maliyeti', 'opencode-agent-evaluation'],
    ['TR automation+codemode', 'OpenCode eklenti otomasyon ve Code Mode geliştirme', 'opencode-v2-advanced-plugin'],
    ['TR TUI plugin', 'terminal TUI arayüz eklentisi sidebar panel geliştirme', 'opencode-v2-cli-plugin'],
    ['TR GUI plugin', 'masaüstü GUI arayüz eklentisi Electron pencere geliştirme', 'opencode-v2-gui-plugin'],
    ['EN server plugin', 'OpenCode V2 server plugin Plugin.define permissions and compaction', 'opencode-v2-server-plugin'],
  ];

  for (const [label, q, expectedId] of queryCases) {
    const res = JSON.parse((await searchTool.execute({ query: q, topK: 5 }, { sessionID: 's1' })).content);
    const top2 = res.results.slice(0, 2).map((r) => r.id);
    assert.ok(
      top2.includes(expectedId),
      `${label}: expected ${expectedId} in top 2, got ${JSON.stringify(res.results.map((r) => [r.id, r.score]))}`
    );
    const hit = res.results.find((r) => r.id === expectedId);
    assert.ok(hit.score >= 2.5, `${label}: expected score >= 2.5 for ${expectedId}, got ${hit.score}`);
  }

  // End-to-end single-agent auto-binding with default thresholds (minScore: 2.5, minCoverage: 0.3)
  const trPrompt = {
    sessionID: 's-tr-auto',
    prompt: { text: 'eklenti güvenlik denetimi ve izin yetki yükseltme kontrolü yap' },
  };
  await host.hooks.get('prompt')(trPrompt);
  assert.ok(
    trPrompt.prompt.skills?.some((s) => s.id === 'opencode-agent-security-audit'),
    `Expected auto-bind of opencode-agent-security-audit, got ${JSON.stringify(trPrompt.prompt.skills)}`
  );
});

test('Strict skill with higher relevance beats keyword-stuffed rich skill and preserves derived signals under nativeCatalog=compact', async (t) => {
  // 1. Head-to-head: strict skill matches both query terms in description; rich skill stuffs only one term across 4 fields
  const skills = [
    strictSkill('strict-compaction', 'Manage background context compaction and prompt cache hit rate recovery'),
    strictSkill('stuffed-cache', 'General caching notes', {
      keywords: ['cache', 'caching', 'cache', 'memory'],
      triggers: ['cache hit', 'cache tuning'],
      tags: ['cache', 'perf'],
      aliases: ['cache helper', 'caching utility'],
    }),
    ...Array.from({ length: 8 }, (_, i) => strictSkill(`filler-${i}`, `Unrelated workflow helper ${i}`)),
  ];
  const idx = createSearchIndex(skills);
  const hits = search(idx, 'background compaction cache', { topK: 3 });
  assert.equal(hits[0]?.skill.id, 'strict-compaction', JSON.stringify(hits.map((h) => [h.skill.id, h.score])));
  assert.ok(hits[0].score >= 2.5, `Expected strict-compaction score >= 2.5, got ${hits[0].score}`);

  // 2. Security: prototype pollution in sidecar JSON & YAML injection in frontmatter stay inert
  const parsedSidecar = parseSidecarJson('{"__proto__":{"polluted":true},"keywords":["safe-kw"],"roles":["ok-role","../bad"]}');
  assert.equal(({}).polluted, undefined);
  assert.deepEqual(parsedSidecar?.keywords, ['safe-kw']);
  assert.deepEqual(parsedSidecar?.roles, ['ok-role']);

  const yamlInjected = parseFrontmatter('---\nname: safe-skill\ndescription: Use when testing `Plugin.define` hooks.\nkeywords: !js/function "alert(1)"\ntags: &anchor\n---\n# Safe Heading\n');
  assert.equal(yamlInjected.meta.keywords, undefined);
  assert.equal(yamlInjected.meta.tags, undefined);
  const derived = extractDerivedSignals(String(yamlInjected.meta.description), yamlInjected.body);
  assert.ok(derived.derivedKeywords.includes('Plugin.define'));
  assert.ok(derived.derivedAliases.includes('Safe Heading'));

  // 3. nativeCatalog=compact preserves full description + derivedKeywords across subsequent catalog refreshes
  const root = await mkdtemp(join(tmpdir(), 'lazy-compact-derived-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const native = [
    {
      id: 'opencode-v2-advanced-plugin',
      name: 'opencode-v2-advanced-plugin',
      description:
        'Use when implementing OpenCode V2 Code Mode (execute, @opencode/codemode, structured tool output, pinned catalog), experimental Automations (client.experimental.automation), RPC and Cloudflare Workerd.',
      autoinvoke: true,
    },
  ];
  const tools = new Map();
  const ctx = {
    options: { roots: [root], refreshMs: 0, hints: 'off', nativeCatalog: 'compact', compactDescriptionChars: 40 },
    location: { directory: root, project: { canonical: root } },
    skill: {
      list: async () => ({ data: native }),
      transform: async (fn) => {
        fn({
          list: () => native,
          update: (id, cb) => {
            const x = native.find((s) => s.id === id);
            if (x) cb(x);
          },
        });
        return { dispose: async () => {} };
      },
    },
    tool: {
      transform: async (fn) => {
        fn({ namespace: () => {}, add: (def) => tools.set(`lazy_skill_${def.name}`, def) });
        return { dispose: async () => {} };
      },
    },
    session: {
      get: async () => ({ data: { agent: 'build' } }),
      hook: async () => ({ dispose: async () => {} }),
    },
  };
  const cleanup = await createPlugin().setup(ctx);
  t.after(cleanup);

  // Force a second refresh after transform compacted native[0].description to 40 chars
  await tools.get('lazy_skill_status').execute({ refresh: true }, { sessionID: 's1' });
  const res = JSON.parse(
    (await tools.get('lazy_skill_search').execute({ query: 'client.experimental.automation @opencode/codemode' }, { sessionID: 's1' })).content
  );
  assert.equal(res.results[0]?.id, 'opencode-v2-advanced-plugin');
  assert.ok(res.results[0].score >= 2.5, `Expected score >= 2.5 after compact refresh, got ${res.results[0].score}`);
});

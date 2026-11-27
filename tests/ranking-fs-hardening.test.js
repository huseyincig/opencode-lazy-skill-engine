import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSearchIndex, search } from '../dist/core/rank.js';
import { extractExplicit, negativeTriggerMatch } from '../dist/core/selection.js';
import { parseQuery, tokenize } from '../dist/core/text.js';
import { parseFrontmatter, scanVaults } from '../dist/core/scanner.js';
import { configure } from '../dist/core/config.js';
import { listResources } from '../dist/core/resources.js';

const mkSkill = (id, description, extra = {}) => ({
  id,
  name: extra.name ?? id,
  description,
  keywords: extra.keywords ?? [],
  aliases: extra.aliases ?? [],
  tags: extra.tags ?? [],
  triggers: extra.triggers ?? [],
  negativeTriggers: extra.negativeTriggers ?? [],
  languages: [],
  roles: [],
  origin: 'host',
  path: null,
  base: null,
  scope: 'native',
  source: 'native',
  trust: 'native',
  ...extra,
});

test('Ranking: exactId bonus (@id / skill:id) survives when other query terms do not match', () => {
  const idx = createSearchIndex([
    mkSkill('zebra-alpha', 'Handles quantum telemetry pipelines'),
    mkSkill('other-tool', 'General formatting utility'),
  ]);
  const hits = search(idx, 'completely unrelated words @zebra-alpha');
  assert.equal(hits[0]?.skill.id, 'zebra-alpha');
  assert.ok(hits[0].score >= 40, `expected exactId score >= 40 even with 0 other hits, got ${hits[0]?.score}`);
});

test('Ranking: long multi-sentence prompts prioritize rare corpus terms and do not crush domain match scores', () => {
  const idx = createSearchIndex([
    mkSkill('sqlite-migrations', 'Design safe SQLite schema migrations, WAL checkpoint tuning, and index rollbacks'),
    mkSkill('frontend-css', 'Responsive CSS grid layouts and animation keyframes'),
    mkSkill('docker-compose', 'Container networking and multi-stage Dockerfile builds'),
    mkSkill('release-notes', 'Write customer-facing release changelogs and upgrade notices'),
  ]);
  // 35+ filler/prose words before the domain terms at the end (past the old 24-term slice!)
  const longPrompt = [
    'Yesterday afternoon our engineering department met during quarterly planning across regional teams',
    'and discussed several operational roadmap priorities spanning onboarding documentation meetings schedules',
    'budget approvals vendor invoices travel calendars quarterly objectives stakeholders presentations',
    'before finally asking us to fix sqlite schema migrations and wal checkpoint index rollbacks.',
  ].join(' ');

  const hits = search(idx, longPrompt, { topK: 5 });
  assert.equal(hits[0]?.skill.id, 'sqlite-migrations', 'rare corpus terms past word 24 must still be prioritized');
  assert.ok(hits[0].score >= 2.5, `long prompt domain match must not be crushed below singleAgent.minScore (2.5), got ${hits[0]?.score}`);
});

test('Ranking: sharedIdentityPrefix dampens ubiquitous catalog prefixes (opencode-*, v2)', () => {
  const idx = createSearchIndex([
    mkSkill('opencode-v2-server', 'Build server hooks and tool transforms for OpenCode V2'),
    mkSkill('opencode-v2-tui', 'Build OpenTUI sidebar widgets, keymaps, and terminal dialogs'),
    mkSkill('opencode-v2-gui', 'Build Electron desktop panels and IPC bridges'),
    mkSkill('opencode-v2-rpc', 'Define typed RPC contracts and live event streams'),
    mkSkill('opencode-v2-sdk', 'Embed in-memory SDK hosts and Cloudflare Workerd targets'),
  ]);
  // Query contains "opencode v2" (shared across all 5) + specific "sidebar keymaps"
  const hits = search(idx, 'opencode v2 sidebar keymaps');
  assert.equal(hits[0]?.skill.id, 'opencode-v2-tui');
  // Score gap between TUI (matched specific terms) and unrelated siblings (only matched shared prefix) should be large
  assert.ok(hits[0].score > (hits[1]?.score ?? 0) * 2.5, `expected strong separation over shared-prefix siblings: ${hits[0].score} vs ${hits[1]?.score}`);
});

test('Selection & Text: negativeTriggerMatch catches single-word vetoes past token 150', () => {
  const filler = Array.from({ length: 180 }, (_, i) => `word${i}`).join(' ');
  const prompt = `${filler} please deploy to kubernetes`;
  assert.equal(
    negativeTriggerMatch(prompt, { negativeTriggers: ['kubernetes'] }),
    true,
    'single-word negative trigger past token 150 must still veto'
  );
});

test('Selection & Text: extractExplicit and parseQuery ignore negated (-skill:id) and quoted ("skill:id") prose', () => {
  assert.deepEqual(extractExplicit('Do not use -skill:blocked-one or "skill:quoted-one" or \'skill:single-quoted\''), []);
  assert.deepEqual(extractExplicit('Please apply skill:real-one and not -skill:fake-one'), ['real-one']);
  assert.equal(parseQuery('avoid -skill:blocked-one and "skill:quoted-one"').explicit, null);
  assert.equal(parseQuery('use skill:real-one').explicit, 'real-one');
});

test('Text: expanded EN/TR stopwords filter common noise words', () => {
  const tokens = tokenize('should could would not degil sadece ancak gibi sqlite migration');
  assert.deepEqual(tokens, ['sqlite', 'migration']);
});

test('Scanner: parseFrontmatter applies first-key-wins on duplicate keys and reports duplicateKeys', () => {
  const parsed = parseFrontmatter([
    '---',
    'name: First Name',
    'description: First safe description',
    'description: Overridden evil description',
    '  continued evil line',
    'keywords: [alpha]',
    'keywords:',
    '  - injected',
    '---',
    'Body text',
  ].join('\n'));
  assert.equal(parsed.meta.description, 'First safe description');
  assert.deepEqual(parsed.meta.keywords, ['alpha']);
  assert.deepEqual(parsed.duplicateKeys, ['description', 'keywords']);
});

test('Scanner: scanVaults streams with opendir, pins SKILL.md under tight budget, and reports duplicate frontmatter key diagnostic', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'lse-hard-scan-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const skillDir = join(root, 'budget-skill');
  await mkdir(skillDir, { recursive: true });
  // Create 20 alphabetically earlier sibling files ("00.txt".."19.txt") before "SKILL.md"
  for (let i = 0; i < 20; i++) {
    await writeFile(join(skillDir, `${String(i).padStart(2, '0')}.txt`), 'sibling');
  }
  await writeFile(
    join(skillDir, 'SKILL.md'),
    '---\nname: Budget Skill\ndescription: First desc\ndescription: Duplicate desc\n---\nBody'
  );

  // maxSkills: 1 => visit budget is 8; without SKILL.md pinning, "00.txt".."08.txt" would starve SKILL.md!
  const opts = { ...configure({ maxSkills: 1 }, { directory: root }), roots: [root] };
  const res = await scanVaults(opts);
  assert.equal(res.skills.length, 1, 'SKILL.md must be pinned ahead of alphabetically earlier sibling files');
  assert.equal(res.skills[0].id, 'budget-skill');
  assert.equal(res.skills[0].description, 'First desc');
  assert.ok(
    res.diagnostics.some((d) => d.error.includes('DUPLICATE_FRONTMATTER_KEY:description')),
    `expected duplicate frontmatter diagnostic, got ${JSON.stringify(res.diagnostics)}`
  );
});

test('Security & Resources: boundedOpen uses O_NONBLOCK + dev/ino + deadline, and listResources bounds visited entries', async (t) => {
  const secSrc = await readFile(new URL('../src/core/security.ts', import.meta.url), 'utf8');
  assert.match(secSrc, /O_NONBLOCK/, 'boundedOpen should use O_NONBLOCK to avoid FIFO hangs');
  assert.match(secSrc, /st\.dev\s*!==\s*gate\.dev|st\.ino\s*!==\s*gate\.ino/, 'boundedOpen should verify dev/ino match');
  assert.match(secSrc, /\/proc\/self\/fd\//, 'boundedOpen should verify descriptor path containment on Linux');
  assert.match(secSrc, /timer\.unref\?\.\(\)/, 'boundedOpen deadline timer should call unref');

  const scanSrc = await readFile(new URL('../src/core/scanner.ts', import.meta.url), 'utf8');
  assert.match(scanSrc, /O_NONBLOCK/, 'readSidecarSync should use O_NONBLOCK');
  assert.match(scanSrc, /fst\.dev\s*!==\s*st\.dev/, 'readSidecarSync should verify dev/ino match');

  const root = await mkdtemp(join(tmpdir(), 'lse-hard-res-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'SKILL.md'), '---\ndescription: Demo\n---\nBody');
  for (let i = 0; i < 15; i++) {
    await writeFile(join(root, `ref-${String(i).padStart(2, '0')}.md`), 'ref');
  }
  const mod = await import('../dist/core/resources.js');
  assert.equal(typeof mod.listResourcesWithDiagnostics, 'function', 'listResourcesWithDiagnostics must be exported');
  const capped = await mod.listResourcesWithDiagnostics({ scope: 'vault', base: root, root }, { max: 5, maxVisited: 6 });
  assert.ok(capped.resources.length <= 5);
  assert.ok(capped.diagnostic, 'truncated resource walk must report diagnostic');
  // Backward-compatible listResources still works
  const plain = await listResources({ scope: 'vault', base: root, root }, 5);
  assert.equal(plain.length, 5);
});

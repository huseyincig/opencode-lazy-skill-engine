import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPlugin } from '../dist/plugin.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const pkgName = 'opencode-lazy-se';
const pluginId = 'opencode-lazy-skill-engine';
const allowedDomains = new Set([
  'opencode.ai',
  'img.shields.io',
  'www.npmjs.com',
  'github.com',
  'www.w3.org',
]);
async function files(directory) {
  const collected = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) collected.push(...await files(path));
    else if (entry.isFile()) collected.push(path);
  }
  return collected;
}

test('package and runtime plugin identity remain project-owned', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.name, pkgName);
  assert.equal(createPlugin().id, pluginId);
  assert.deepEqual(Object.keys(manifest.dependencies ?? {}), []);
  assert.deepEqual(Object.keys(manifest.peerDependencies ?? {}), [
    '@opencode/plugin',
    '@opentui/core',
    '@opentui/solid',
    'solid-js',
  ]);
});

test('published text contains no references to non-OpenCode web domains', async () => {
  for (const dir of ['src', 'tests', 'scripts', 'docs', 'examples']) {
    for (const path of await files(join(root, dir))) {
      const contents = await readFile(path, 'utf8');
      for (const match of contents.matchAll(/\bhttps?:\/\/([a-z\d.-]+)/gi)) {
        assert.ok(allowedDomains.has(match[1].toLowerCase()), `Unexpected external URL (${match[1]}) in ${path}`);
      }
    }
  }
  for (const name of ['README.md', 'CHANGELOG.md', 'LICENSE', 'package.json', 'tsconfig.json', 'index.js', 'tui.js']) {
    const contents = await readFile(join(root, name), 'utf8');
    for (const match of contents.matchAll(/\bhttps?:\/\/([a-z\d.-]+)/gi)) {
      assert.ok(allowedDomains.has(match[1].toLowerCase()), `Unexpected external URL (${match[1]}) in ${name}`);
    }
  }
});

test('installation examples do not pin a plugin build directory or a host patch version', async () => {
  const example = await readFile(join(root, 'examples', 'opencode.jsonc'), 'utf8');
  const readme = await readFile(join(root, 'README.md'), 'utf8');
  assert.doesNotMatch(example, /lazy-skills?-v\d|opencode-lazy-skill-engine-v\d/i);
  assert.doesNotMatch(readme, /"package":\s*"[^"]*-v\d+/i);
});

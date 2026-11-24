import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPlugin } from '../dist/plugin.js';

/**
 * Mirrors OpenCode v2.4.x host Tool.Result outputSchema enforcement:
 * - If execute() returns `output !== undefined`, the tool definition MUST declare `output` schema.
 * - Returned `output` MUST conform to the declared JSON Schema (types, enums, required, properties, items).
 */
function validateJsonSchema(schema, value, path = '$') {
  assert.ok(schema && typeof schema === 'object', `${path}: schema must be an object`);
  if (schema.type !== undefined) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    const ok = allowed.some((t) => {
      if (t === 'null') return value === null;
      if (t === 'array') return Array.isArray(value);
      if (t === 'integer') return typeof value === 'number' && Number.isInteger(value);
      if (t === 'number') return typeof value === 'number' && Number.isFinite(value);
      if (t === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
      return typeof value === t;
    });
    assert.ok(ok, `${path}: expected type ${JSON.stringify(schema.type)}, got ${value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value} (${JSON.stringify(value)})`);
  }
  if (Array.isArray(schema.enum)) {
    assert.ok(schema.enum.includes(value), `${path}: value ${JSON.stringify(value)} not in enum ${JSON.stringify(schema.enum)}`);
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    if (Array.isArray(schema.required)) {
      for (const req of schema.required) {
        assert.ok(Object.hasOwn(value, req) && value[req] !== undefined, `${path}: missing required key "${req}"`);
      }
    }
    if (schema.properties && typeof schema.properties === 'object') {
      for (const [k, propSchema] of Object.entries(schema.properties)) {
        if (Object.hasOwn(value, k) && value[k] !== undefined) {
          validateJsonSchema(propSchema, value[k], `${path}.${k}`);
        }
      }
    }
    if (schema.additionalProperties === false && schema.properties) {
      for (const k of Object.keys(value)) {
        assert.ok(Object.hasOwn(schema.properties, k), `${path}: unexpected additional property "${k}"`);
      }
    } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      for (const [k, v] of Object.entries(value)) {
        if (schema.properties && Object.hasOwn(schema.properties, k)) continue;
        validateJsonSchema(schema.additionalProperties, v, `${path}.${k}`);
      }
    }
  }
  if (Array.isArray(value) && schema.items && typeof schema.items === 'object') {
    for (let i = 0; i < value.length; i++) {
      validateJsonSchema(schema.items, value[i], `${path}[${i}]`);
    }
  }
}

function assertToolResultMatchesHostContract(def, res, label) {
  assert.ok(res && typeof res === 'object', `${label}: tool result must be an object`);
  assert.equal(typeof res.content, 'string', `${label}: content must be a string`);
  assert.ok(res.content.length > 0, `${label}: content must be non-empty`);
  if (res.output !== undefined) {
    assert.ok(
      def.output && typeof def.output === 'object',
      `${label}: tool "${def.name}" returned output without declaring an output schema (rejected by OpenCode v2.4.x host)`
    );
    validateJsonSchema(def.output, res.output, `${def.name}.output`);
  }
}

test('OpenCode v2.4.1 host contract: all 6 lazy_skill_* tools declare output schemas and conform across every execution branch', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'lazy-output-schema-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const vaultDir = join(root, '.opencode', 'skill-vault', 'vault-audit');
  await mkdir(join(vaultDir, 'references'), { recursive: true });
  await writeFile(
    join(vaultDir, 'SKILL.md'),
    '---\nname: Vault Audit\ndescription: Audit vault security and compliance\n---\n# Vault Audit\nFollow the checklist.'
  );
  await writeFile(join(vaultDir, 'references', 'guide.md'), 'Step 1: Verify boundaries.');

  const tools = new Map();
  const hooks = new Map();
  const native = [
    { id: 'native-sec', name: 'Native Security', description: 'Security audit and permission checks', autoinvoke: true },
    { id: 'denied-sec', name: 'Denied Security', description: 'Restricted security tool', autoinvoke: true },
  ];

  const ctx = {
    options: {
      roots: [root],
      refreshMs: 0,
      hints: 'off',
      vaultAutoBind: true,
      projectAutoBind: true,
      roles: {
        'worker-a': { allowed: ['native-sec', 'vault-audit'], default: ['native-sec'], maxActive: 2 },
      },
    },
    location: { directory: root, project: { canonical: root } },
    agent: {
      list: async () => ({
        data: [
          {
            id: 'worker-a',
            mode: 'subagent',
            permissions: [
              { action: 'skill', resource: '*', effect: 'deny' },
              { action: 'skill', resource: 'native-sec', effect: 'allow' },
              { action: 'skill', resource: 'vault-audit', effect: 'allow' },
            ],
          },
        ],
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
        fn({ namespace: () => {}, add: (def) => tools.set(`lazy_skill_${def.name}`, def) });
        return { dispose: async () => {} };
      },
    },
    session: {
      get: async () => ({ data: { agent: 'worker-a', parentID: 'root' } }),
      hook: async (name, fn) => {
        hooks.set(name, fn);
        return { dispose: async () => {} };
      },
    },
  };

  const cleanup = await createPlugin().setup(ctx);
  t.after(cleanup);

  const expectedTools = [
    'lazy_skill_search',
    'lazy_skill_info',
    'lazy_skill_plan',
    'lazy_skill_status',
    'lazy_skill_load',
    'lazy_skill_resource',
  ];
  assert.deepEqual([...tools.keys()].sort(), [...expectedTools].sort());

  // Every registered tool must declare a JSON Schema output object
  for (const name of expectedTools) {
    const def = tools.get(name);
    assert.ok(def.output && def.output.type === 'object', `${name} must declare output: { type: "object", ... }`);
  }

  const callCtx = { sessionID: 'ses-1', agent: 'worker-a', signal: new AbortController().signal };

  // 1. lazy_skill_search: ids, summary, full, empty, wildcard
  const searchDef = tools.get('lazy_skill_search');
  for (const input of [
    { query: 'security audit', detail: 'ids' },
    { query: 'security audit', detail: 'summary' },
    { query: 'security audit', detail: 'full' },
    { query: 'nonexistentxyzzy' },
    { query: '*' },
  ]) {
    const res = await searchDef.execute(input, callCtx);
    assertToolResultMatchesHostContract(searchDef, res, `search(${JSON.stringify(input)})`);
    assert.deepEqual(JSON.parse(res.content), res.output);
  }

  // 2. lazy_skill_info: single native, single vault, not found, batch ids
  const infoDef = tools.get('lazy_skill_info');
  for (const input of [
    { id: 'native-sec' },
    { id: 'vault-audit' },
    { id: 'does-not-exist' },
    { ids: ['native-sec', 'vault-audit', 'does-not-exist'] },
  ]) {
    const res = await infoDef.execute(input, callCtx);
    assertToolResultMatchesHostContract(infoDef, res, `info(${JSON.stringify(input)})`);
    assert.deepEqual(JSON.parse(res.content), res.output);
  }

  // 3. lazy_skill_plan: matched worker, primary/no-agent, missing required, denied required, explicit
  const planDef = tools.get('lazy_skill_plan');
  for (const input of [
    { query: 'security audit', agent: 'worker-a', worker: true },
    { query: 'security audit' },
    { query: 'do task', agent: 'worker-a', requiredSkills: ['does-not-exist'] },
    { query: 'do task', agent: 'worker-a', requiredSkills: ['denied-sec'] },
    { query: 'use skill:native-sec', agent: 'worker-a' },
  ]) {
    const res = await planDef.execute(input, callCtx);
    assertToolResultMatchesHostContract(planDef, res, `plan(${JSON.stringify(input)})`);
    assert.deepEqual(JSON.parse(res.content), res.output);
  }

  // 4. lazy_skill_status: before receipt (receipt: null) and after receipt (receipt: object)
  const statusDef = tools.get('lazy_skill_status');
  const stBefore = await statusDef.execute({}, callCtx);
  assertToolResultMatchesHostContract(statusDef, stBefore, 'status(before receipt)');
  assert.equal(stBefore.output.receipt, null);
  assert.deepEqual(JSON.parse(stBefore.content), stBefore.output);

  await hooks.get('prompt')({
    sessionID: 'ses-1',
    prompt: { text: 'Run security audit and permission checks', skills: [] },
  });
  const stAfter = await statusDef.execute({ refresh: true }, callCtx);
  assertToolResultMatchesHostContract(statusDef, stAfter, 'status(after receipt)');
  assert.ok(stAfter.output.receipt && Array.isArray(stAfter.output.receipt.ids));
  assert.deepEqual(JSON.parse(stAfter.content), stAfter.output);

  // 5. lazy_skill_load: native refusal, first vault load, alreadyLoaded, reload:true
  const loadDef = tools.get('lazy_skill_load');
  const loadCtx = { sessionID: 'ses-load-fresh', agent: 'worker-a', signal: new AbortController().signal };
  const loadNative = await loadDef.execute({ id: 'native-sec' }, loadCtx);
  assertToolResultMatchesHostContract(loadDef, loadNative, 'load(native)');
  assert.equal(loadNative.output.native, true);

  const loadFirst = await loadDef.execute({ id: 'vault-audit' }, loadCtx);
  assertToolResultMatchesHostContract(loadDef, loadFirst, 'load(vault first)');
  assert.equal(loadFirst.output.loaded, true);
  assert.match(loadFirst.content, /<skill source="vault" id="vault-audit">/);

  const loadAgain = await loadDef.execute({ id: 'vault-audit' }, loadCtx);
  assertToolResultMatchesHostContract(loadDef, loadAgain, 'load(vault alreadyLoaded)');
  assert.equal(loadAgain.output.alreadyLoaded, true);

  const loadReload = await loadDef.execute({ id: 'vault-audit', reload: true }, loadCtx);
  assertToolResultMatchesHostContract(loadDef, loadReload, 'load(vault reload)');
  assert.equal(loadReload.output.loaded, true);

  // 6. lazy_skill_resource: valid vault reference
  const resDef = tools.get('lazy_skill_resource');
  const resRead = await resDef.execute({ id: 'vault-audit', path: 'references/guide.md' }, callCtx);
  assertToolResultMatchesHostContract(resDef, resRead, 'resource(guide.md)');
  assert.equal(resRead.output.id, 'vault-audit');
  assert.equal(resRead.output.path, 'references/guide.md');
  assert.ok(resRead.output.bytes > 0);
  assert.match(resRead.content, /Verify boundaries/);
});

/**
 * gate.js 的纯逻辑测试。不启动 DSH，只验证策略计算。
 * 跑法：node test/gate.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGate, isCoreSection } from '../gate.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-test-'));
let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

test('核心段识别', () => {
  assert.equal(isCoreSection('harness:identity'), true);
  assert.equal(isCoreSection('plan'), true);
  assert.equal(isCoreSection('tool:bash'), true);
  assert.equal(isCoreSection('deployment:persona-prefix'), true);
  assert.equal(isCoreSection('pack:base'), false);
  assert.equal(isCoreSection('mcp:foo'), true);
});

test('observe 只登记、默认 inherit', () => {
  const gate = createGate({ dir });
  gate.load();
  gate.observe([
    { name: 'deployment:persona-prefix', text: '你是某 agent' },
    { name: 'plan', text: 'plan mode' },
  ]);
  const snap = gate.snapshot();
  const persona = snap.sections.find((s) => s.name === 'deployment:persona-prefix');
  assert.equal(persona.policy, 'inherit');
  assert.equal(persona.core, true);
  assert.equal(gate.deniedFor('standard').size, 0, '默认不该遮蔽任何段');
});

test('核心段不许 gate', () => {
  const gate = createGate({ dir });
  gate.load();
  assert.throws(() => gate.update({ name: 'plan', policy: 'gate' }), /core/);
});

test('gate 之后按 preset 决定是否遮蔽', () => {
  const gate = createGate({ dir });
  gate.load();
  gate.observe([{ name: 'jspace:persona', text: 'J-Space 认知工作空间' }]);
  gate.update({ name: 'jspace:persona', policy: 'gate' });
  // 未勾选 = 遮蔽
  assert.deepEqual([...gate.deniedFor('standard')], ['jspace:persona']);
  // 显式启用 = 不遮蔽
  gate.update({ name: 'jspace:persona', presetId: 'standard', enabled: true });
  assert.equal(gate.deniedFor('standard').size, 0);
  assert.deepEqual([...gate.deniedFor('j-space')], ['jspace:persona'], '别的 preset 仍然遮蔽');
});

test('插件级 gate 连带它绑定的段', () => {
  const gate = createGate({ dir });
  gate.load();
  gate.observe([
    { name: 'acme:rules', text: 'A' },
    { name: 'acme:extra', text: 'B' },
    { name: 'other:x', text: 'C' },
  ]);
  gate.bind('@acme/dsh-thing', ['acme:rules', 'acme:extra']);
  gate.update({ kind: 'plugin', name: '@acme/dsh-thing', policy: 'gate' });
  const denied = gate.deniedFor('standard');
  assert.deepEqual([...denied].sort(), ['acme:extra', 'acme:rules']);
  gate.update({ kind: 'plugin', name: '@acme/dsh-thing', presetId: 'standard', enabled: true });
  assert.equal(gate.deniedFor('standard').size, 0);
});

test('策略落盘后能读回', () => {
  const gate = createGate({ dir: path.join(dir, 'p2') });
  gate.load();
  gate.observe([{ name: 'x:y', text: 'z' }]);
  gate.update({ name: 'x:y', policy: 'gate' });
  const again = createGate({ dir: path.join(dir, 'p2') });
  again.load();
  assert.deepEqual([...again.deniedFor('standard')], ['x:y']);
});

test('空段 marker：chars 为 0 时不许 gate', () => {
  const gate = createGate({ dir: path.join(dir, 'p3') });
  gate.load();
  gate.observe([{ name: 'empty:thing', text: '' }]);
  assert.throws(() => gate.update({ name: 'empty:thing', policy: 'gate' }), /empty/);
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} passed`);

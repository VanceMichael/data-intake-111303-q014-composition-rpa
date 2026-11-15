import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startSource } from '../src/source.mjs';

const { run } = await import('../src/workflow.mjs');
const scenarios = JSON.parse(await readFile(new URL('../fixtures/cases.json', import.meta.url)));

async function seedInterruptedDraft(stateDir, input, source) {
  // 模拟一次真实中断：页面打开了门户，地点与数量已录入，保存尚未发起。
  const { chromium } = await import('playwright');
  const { enterLocation, enterQuantity, canonicalQuantity } = await import('../src/portal-form.mjs');
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.goto(source + '/portal');
    await page.waitForSelector('#location');
    const location = await enterLocation(page, input.location, {});
    const quantity = await enterQuantity(page, input.quantity);
    const draft = {
      version: 1,
      input: { location: input.location, container: input.container, quantity: input.quantity },
      createdAt: new Date().toISOString(),
      fields: {
        location: { readback: location.readback, method: location.method, ok: location.ok, attempts: location.attempts },
        quantity: { readback: quantity.readback, canonical: canonicalQuantity(quantity.readback), method: quantity.method, ok: quantity.ok, attempts: quantity.attempts },
      },
      steps: [{ field: 'location', ...location }, { field: 'quantity', ...quantity }],
      calculation: null,
      save: { attempts: [], confirmed: false },
      resume: { interrupted: '保存前进程退出' },
      result: { state: 'interrupted', reason: '保存前中断，草稿已落盘' },
    };
    await writeFile(path.join(stateDir, 'draft.json'), JSON.stringify(draft, null, 2) + '\n');
    await writeFile(path.join(stateDir, 'result.json'), JSON.stringify(draft.result, null, 2) + '\n');
  } finally { await browser.close(); }
}

function includes(actual, expected, location = 'result') {
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), location + ' 应为数组');
    if (expected.every(value => typeof value !== 'object')) assert.deepEqual([...actual].sort(), [...expected].sort(), location);
    else for (const item of expected) {
      const found = actual.find(candidate => item.id !== undefined && candidate.id === item.id);
      assert.ok(found, location + ' 缺少实体 ' + item.id);
      includes(found, item, location);
    }
  } else if (expected !== null && typeof expected === 'object') {
    assert.ok(actual && typeof actual === 'object', location + ' 应为对象');
    for (const [key, value] of Object.entries(expected)) includes(actual[key], value, location + '.' + key);
  } else assert.equal(actual, expected, location);
}

for (const scenario of scenarios) {
  test('业务接收：' + scenario.name, { timeout: 15000 }, async () => {
    const source = await startSource(scenario);
    const stateDir = await mkdtemp(path.join(tmpdir(), 'material-state-'));
    try {
      const input = { ...scenario.input, deviceCommand: path.resolve('fixtures/device.mjs') };
      if (scenario.resume === 'interrupted') {
        // 第一次执行在保存前中断（数据库只保留中断时已落盘的草稿），再按草稿续录。
        const interruptedDir = await mkdtemp(path.join(tmpdir(), 'material-interrupted-'));
        try {
          await seedInterruptedDraft(interruptedDir, scenario.input, source.url);
          for (const name of await readdir(interruptedDir)) {
            await copyFile(path.join(interruptedDir, name), path.join(stateDir, name));
          }
        } finally { await rm(interruptedDir, { recursive: true, force: true }); }
      }
      const actual = await run({ source: source.url, stateDir, input });
      includes(actual, scenario.expected);
      if (scenario.resume === 'interrupted') {
        assert.ok(actual.evidence?.resume?.draftReused, '续录没有复用落盘草稿');
        assert.ok(source.portal.actions.filter(entry => entry.action === 'save').length <= 1, '续录重复触发了保存');
        assert.deepEqual(actual.evidence?.resume?.remainingFields, ['location', 'container', 'quantity'], '续录没有按页面现状识别仍需录入的字段');
        assert.deepEqual(actual.evidence?.resume?.skippedFields, [], '新页面没有任何字段可直接跳过');
        assert.deepEqual(
          (actual.evidence?.fields ?? [])
            .filter(step => ['location', 'container', 'quantity'].includes(step.field))
            .map(step => step.field),
          ['location', 'container', 'quantity'],
          '续录没有留下逐字段动作证据',
        );
        assert.ok((actual.evidence?.fields ?? []).some(step => step.method === 'invalidated-by-container'), '没有记录容器变化使旧总量作废');
      }
      for (const required of scenario.required) assert.ok(source.history.some(entry => entry.path === required || entry.path.split('?')[0] === required), '没有实际读取 ' + required);
      for (const forbidden of scenario.forbidden ?? []) assert.ok(!source.history.some(entry => entry.path === forbidden), '错误访问禁止来源 ' + forbidden);
      for (const [resource, maximum] of Object.entries(scenario.limits ?? {})) assert.ok(source.history.filter(entry => entry.path.split('?')[0] === resource).length <= maximum, '超出请求额度 ' + resource);
      if (scenario.kind === 'browser') {
        for (const action of scenario.actions) assert.ok(source.portal.actions.some(entry => entry.action === action), '没有通过页面完成动作 ' + action);
        assert.ok(source.history.some(entry => entry.path === '/portal'), '没有打开真实门户');
      }
      const saved = JSON.parse(await readFile(path.join(stateDir, 'result.json')));
      includes(saved, scenario.expected);
    } finally {
      await source.close();
      await rm(stateDir, { recursive: true, force: true });
    }
  });
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startSource } from '../src/source.mjs';
import { run } from '../src/workflow.mjs';

const cases = JSON.parse(await readFile(new URL('../fixtures/cases.json', import.meta.url)));

async function withSource(index, body) {
  const source = await startSource(cases[index]);
  const stateDir = await mkdtemp(path.join(tmpdir(), 'workflow-recovery-'));
  try { return await body({ source, stateDir }); }
  finally { await source.close(); await rm(stateDir, { recursive: true, force: true }); }
}

test('相同输入再次执行复用已落盘结果，不再触发保存', { timeout: 15000 }, async () => {
  await withSource(0, async ({ source, stateDir }) => {
    const first = await run({ source: source.url, stateDir, input: cases[0].input });
    assert.equal(first.state, 'saved');
    assert.equal(source.portal.actions.length, 1);
    const second = await run({ source: source.url, stateDir, input: cases[0].input });
    assert.equal(second.state, 'saved');
    assert.deepEqual(second.record, first.record);
    assert.equal(second.evidence.reusedStoredResult, true);
    assert.equal(source.portal.actions.length, 1, '复用结果时不应再打开门户或保存');
  });
});

test('保存请求已发出但未确认时，按服务端现状收尾而不是重复保存', { timeout: 15000 }, async () => {
  await withSource(0, async ({ source, stateDir }) => {
    await run({ source: source.url, stateDir, input: cases[0].input });
    // 模拟上次执行在拿到响应前中断：结果文件丢失，草稿里只留“已请求保存”的记录。
    await rm(path.join(stateDir, 'result.json'));
    const draft = JSON.parse(await readFile(path.join(stateDir, 'draft.json')));
    draft.save = {
      attempts: [{ at: new Date().toISOString(), status: 'requested', record: { location: '贝加尔湖', container: '瓶', quantity: '3', total: 6 } }],
      confirmed: false,
    };
    delete draft.result;
    await writeFile(path.join(stateDir, 'draft.json'), JSON.stringify(draft, null, 2) + '\n');
    const recovered = await run({ source: source.url, stateDir, input: cases[0].input });
    assert.equal(recovered.state, 'saved');
    assert.deepEqual(recovered.record, { location: '贝加尔湖', container: '瓶', quantity: '3', total: 6 });
    assert.equal(recovered.evidence.recovery?.serverRecheck?.status, 200);
    assert.equal(recovered.evidence.recovery?.serverRecheck?.record?.total, 6);
    assert.equal(source.portal.actions.length, 1, '恢复过程不得再次点击保存');
  });
});

test('服务端记录与输入不一致时不复用，按页面重新录入并保存', { timeout: 15000 }, async () => {
  await withSource(3, async ({ source, stateDir }) => {
    const draft = {
      version: 1,
      input: cases[3].input,
      createdAt: new Date().toISOString(),
      fields: { location: { readback: '洞庭湖', ok: true }, container: { readback: '瓶', ok: true }, quantity: { readback: '002', ok: true } },
      steps: [],
      calculation: null,
      // 上一次尝试保存的是另一个记录（例如地点被改过），服务端现有记录并不对应当前输入。
      save: { attempts: [{ at: new Date().toISOString(), status: 'requested', record: { location: '洞庭湖', container: '瓶', quantity: '2', total: 6 } }], confirmed: false },
    };
    await writeFile(path.join(stateDir, 'draft.json'), JSON.stringify(draft, null, 2) + '\n');
    const result = await run({ source: source.url, stateDir, input: cases[3].input });
    assert.equal(result.state, 'saved', '服务端现存记录与期望不符时不能复用，必须按页面重新录入');
    assert.deepEqual(result.record, { location: '洞庭湖', container: '箱', quantity: '2', total: 8 });
    assert.equal(result.evidence.resume.pendingSaveFromDraft, true);
    assert.equal(result.evidence.resume.serverRecheck.status, 200);
    assert.equal(source.portal.actions.filter(entry => entry.action === 'save').length, 1, '只应发生一次真实保存');
  });
});

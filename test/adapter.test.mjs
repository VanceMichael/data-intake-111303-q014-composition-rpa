import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { chromium } from 'playwright';
import {
  awaitLinkedCalculation,
  chooseContainer,
  commitQuantity,
  enterLocation,
  enterQuantity,
  installRecorder,
  readForm,
  readRecorder,
  snapshotIsReady,
} from '../src/portal-form.mjs';

// 一个刻意“不友好”的门户页：组合期间抢焦点、容器选项随地点异步变化、
// 数量失焦后先给旧代次结果再给本轮结果、失焦时规范化回写。
const PAGE = `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<div id="app">
<label>地点<input id="location"></label>
<label>容器<select id="container"><option value="">请选择</option></select></label>
<label>单件数量<input id="quantity"></label>
<output id="total"></output><p id="validation"></p><button id="save">保存记录</button>
<pre id="feedback"></pre>
</div>
<script type="module">
const app = document.querySelector('#app');
app.dataset.inputGeneration = '0';
app.dataset.calculatedGeneration = '-1';
let generation = 0, calculated = -1, composing = false, factors = new Map();
const location = document.querySelector('#location');
const container = document.querySelector('#container');
const quantity = document.querySelector('#quantity');
const total = document.querySelector('#total');
const validation = document.querySelector('#validation');
const mark = () => { generation += 1; app.dataset.inputGeneration = String(generation); };
location.addEventListener('compositionstart', () => {
  composing = true; location.dataset.composing = 'true';
  if (window.__stealOnComposition) setTimeout(() => container.focus(), 0);
});
location.addEventListener('compositionend', () => { composing = false; location.dataset.composing = 'false'; });
location.addEventListener('input', () => { if (!composing && window.__stealOnComposition) { location.dataset.composing = 'false'; } });
for (const field of [location, quantity, container]) field.addEventListener('input', mark);
const TABLES = { 贝加尔湖: [['瓶', 2], ['桶', 5]], 洞庭湖: [['箱', 4]] };
let request = 0;
async function loadOptions(name) {
  const current = request += 1;
  await new Promise(resolve => setTimeout(resolve, window.__optionsDelay ?? 25));
  if (current !== request) return;
  factors = new Map(TABLES[name] ?? []);
  container.replaceChildren(new Option('请选择', ''), ...[...factors.keys()].map(value => new Option(value, value)));
  if (window.__swapOptions) container.replaceChildren(new Option('请选择', ''), new Option('箱', '箱'));
}
location.addEventListener('change', () => loadOptions(location.value.trim()));
quantity.addEventListener('blur', () => {
  calculated = -1; app.dataset.calculatedGeneration = '-1';
  if (!/^\\d+$/.test(quantity.value) || Number(quantity.value) <= 0) { total.value = ''; validation.textContent = '数量必须为正整数'; return; }
  quantity.value = String(Number(quantity.value));
  const factor = factors.get(container.value);
  if (factor === undefined) { total.value = ''; validation.textContent = '请先选择可用容器'; return; }
  const current = generation;
  if (window.__lateResult) setTimeout(() => { total.value = '999'; calculated = current - 1; app.dataset.calculatedGeneration = String(calculated); }, 15);
  setTimeout(() => {
    total.value = String(Number(quantity.value) * factor);
    calculated = current;
    app.dataset.calculatedGeneration = String(current);
    validation.textContent = '校验通过';
  }, window.__calcDelay ?? 60);
});
document.querySelector('#save').onclick = () => { document.querySelector('#feedback').textContent = JSON.stringify({ location: location.value, container: container.value, quantity: quantity.value, total: total.value }); };
</script>`;

async function startPage() {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(PAGE);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { url: 'http://127.0.0.1:' + server.address().port, close: () => new Promise(resolve => server.close(resolve)) };
}

async function withPage(options, run) {
  const source = await startPage();
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext();
    await context.addInitScript(values => Object.assign(window, values), options);
    const page = await context.newPage();
    await page.goto(source.url);
    await page.waitForSelector('#save');
    await installRecorder(page);
    return await run({ page, context });
  } finally {
    await browser.close();
    await source.close();
  }
}

test('中文组合事件被焦点抢占时不会留下半截地点名', { timeout: 15000 }, async () => {
  await withPage({ __stealOnComposition: true }, async ({ page, context }) => {
    const outcome = await enterLocation(page, '贝加尔湖', context);
    assert.equal(outcome.ok, true);
    assert.equal(outcome.method, 'text-fallback', '抢焦点后应清理组合残留并改用文本提交');
    assert.match(outcome.attempts.at(-1).fallbackReason, /焦点|组合/);
    const snapshot = await readForm(page);
    assert.equal(snapshot.location.value, '贝加尔湖');
    assert.equal(snapshot.location.composing, false);
    assert.ok(!snapshot.location.value.startsWith('贝加尔贝加尔'), '不得把半截组合文本与完整文本叠加');
  });
});

test('真实组合事件完整提交后才认为地点就绪', { timeout: 15000 }, async () => {
  await withPage({}, async ({ page, context }) => {
    const outcome = await enterLocation(page, '洞庭湖', context);
    assert.equal(outcome.ok, true);
    assert.equal(outcome.method, 'composition');
    const recorder = await readRecorder(page);
    const types = recorder.events.filter(event => event.field === 'location').map(event => event.type);
    assert.ok(types.includes('compositionstart'));
    assert.ok(types.includes('compositionend'));
    const end = recorder.events.filter(event => event.field === 'location').at(-1);
    assert.equal(end.composing, 'false');
    const inputs = recorder.events.filter(event => event.field === 'location' && event.type === 'input');
    assert.ok(inputs.length >= 2, '至少应有组合阶段的 input 事件');
    assert.ok(inputs.every(event => event.inputType === 'insertCompositionText' || event.inputType === 'insertText'), '文本来自浏览器输入通道');
  });
});

test('地点变化后容器选项异步更新，按页面现状重新选择', { timeout: 15000 }, async () => {
  await withPage({}, async ({ page, context }) => {
    assert.equal((await enterLocation(page, '洞庭湖', context)).ok, true);
    await page.locator('#location').focus();
    await page.keyboard.press('Tab');
    await page.waitForFunction(() => document.querySelector('#container').options.length > 1);
    const outcome = await chooseContainer(page, '箱', context);
    assert.equal(outcome.ok, true);
    assert.equal(outcome.method, 'select');
    assert.equal(outcome.readback, '箱');
    const unsupported = await chooseContainer(page, '瓶', context);
    assert.equal(unsupported.ok, false);
    assert.match(unsupported.reason, /没有可用容器/);
    assert.equal((await readForm(page)).container.value, '箱', '失败时不得改写已确认的选择');
  });
});

test('快速切焦后数量规范化回写，仍以回读值判定', { timeout: 15000 }, async () => {
  await withPage({}, async ({ page, context }) => {
    await enterLocation(page, '贝加尔湖', context);
    await page.locator('#location').focus();
    await page.keyboard.press('Tab');
    await page.waitForFunction(() => document.querySelector('#container').options.length > 1);
    assert.equal((await chooseContainer(page, '瓶', context)).ok, true);
    const typed = await enterQuantity(page, '003');
    assert.equal(typed.ok, true);
    assert.equal(typed.readback, '003', '录入阶段回读的是未失焦的原始文本');
    await commitQuantity(page);
    await page.waitForFunction(() => document.querySelector('#total').value !== '');
    const snapshot = await readForm(page);
    assert.equal(snapshot.quantity.value, '3', '失焦后页面把文本规范化');
    assert.equal(snapshot.total, '6');
  });
});

test('旧代次计算晚到时不接收，等到本轮结果稳定', { timeout: 15000 }, async () => {
  await withPage({ __lateResult: true }, async ({ page, context }) => {
    await enterLocation(page, '贝加尔湖', context);
    await page.locator('#location').focus();
    await page.keyboard.press('Tab');
    await page.waitForFunction(() => document.querySelector('#container').options.length > 1);
    await chooseContainer(page, '桶', context);
    await enterQuantity(page, '004');
    await commitQuantity(page);
    const linked = await awaitLinkedCalculation(page, {
      expectedQuantity: '004',
      acceptTotal: value => value === 20,
      timeout: 2000,
      settle: 120,
    });
    assert.equal(linked.status, 'settled');
    assert.equal(linked.snapshot.total, '20');
    assert.equal(linked.snapshot.calculatedGeneration, linked.snapshot.inputGeneration);
    const recorder = await readRecorder(page);
    const totals = recorder.totalChanges.map(change => String(change.value));
    assert.ok(totals.includes('999'), '证据中应保留旧计算的晚到结果');
    assert.equal(totals.at(-1), '20');
  });
});

test('页面业务校验拒绝时立即停止，不保存也不覆盖输入', { timeout: 15000 }, async () => {
  await withPage({}, async ({ page, context }) => {
    await enterLocation(page, '贝加尔湖', context);
    await page.locator('#location').focus();
    await page.keyboard.press('Tab');
    await page.waitForFunction(() => document.querySelector('#container').options.length > 1);
    await chooseContainer(page, '瓶', context);
    await enterQuantity(page, '-1');
    await commitQuantity(page);
    const linked = await awaitLinkedCalculation(page, { expectedQuantity: '-1', acceptTotal: () => true, timeout: 1500 });
    assert.equal(linked.status, 'rejected');
    assert.equal(linked.reason, '数量必须为正整数');
    const snapshot = await readForm(page);
    assert.equal(snapshot.quantity.value, '-1', '保留原始输入');
    assert.equal(await page.locator('#save').evaluate(button => button.dataset.clicked ?? null), null, '没有发起保存');
  });
});

test('保存前检查逐项对照页面、请求与服务端记录', { timeout: 15000 }, async () => {
  await withPage({}, async ({ page, context }) => {
    await enterLocation(page, '贝加尔湖', context);
    await page.locator('#location').focus();
    await page.keyboard.press('Tab');
    await page.waitForFunction(() => document.querySelector('#container').options.length > 1);
    await chooseContainer(page, '瓶', context);
    await enterQuantity(page, '002');
    await commitQuantity(page);
    const linked = await awaitLinkedCalculation(page, {
      expectedQuantity: '002',
      acceptTotal: value => value === 4,
      timeout: 2000,
    });
    assert.equal(linked.status, 'settled');
    const ready = snapshotIsReady(linked.snapshot, { location: '贝加尔湖', container: '瓶', quantity: '002' }, 4);
    assert.equal(ready.ok, true);
    assert.deepEqual(ready.checks.map(check => check.item), [
      'location.committed',
      'location.composing',
      'container.selected',
      'quantity.normalized',
      'total.linked',
      'calculation.generation',
      'validation.accepted',
    ]);
    const wrongTotal = snapshotIsReady(linked.snapshot, { location: '贝加尔湖', container: '瓶', quantity: '002' }, 999);
    assert.equal(wrongTotal.ok, false, '总量与容器×数量不符时不得放行');
  });
});

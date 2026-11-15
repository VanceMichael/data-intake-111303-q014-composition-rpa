const app = document.querySelector('#app');
let state = await fetch('/portal/state', { cache: 'no-store' }).then(response => response.json());
const action = async value => {
  const response = await fetch('/portal/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  const result = await response.json();
  document.querySelector('#feedback').textContent = JSON.stringify(result, null, 2);
  return { ok: response.ok, value: result };
};
const feedback = '<pre id="feedback" aria-live="polite"></pre>';
app.innerHTML = '<label>地点<input id="location" autocomplete="off"></label>'
  + '<label>容器<select id="container"><option value="">请选择</option></select></label>'
  + '<label>单件数量<input id="quantity" inputmode="numeric" autocomplete="off"></label>'
  + '<output id="total" for="quantity"></output><p id="validation" aria-live="polite"></p>'
  + '<button id="save">保存记录</button>' + feedback;

let composing = false;
let generation = 0;
let calculatedGeneration = -1;
let containerFactors = new Map();
let optionsRequest = 0;
let lastLocation = '';
const location = document.querySelector('#location');
const container = document.querySelector('#container');
const quantity = document.querySelector('#quantity');
const total = document.querySelector('#total');
const validation = document.querySelector('#validation');
const markInput = () => { generation += 1; app.dataset.inputGeneration = String(generation); };
app.dataset.inputGeneration = '0';
app.dataset.calculatedGeneration = '-1';

location.addEventListener('compositionstart', () => { composing = true; location.dataset.composing = 'true'; });
location.addEventListener('compositionupdate', () => { location.dataset.composing = 'true'; });
location.addEventListener('compositionend', () => { composing = false; location.dataset.composing = 'false'; });
for (const field of [location, quantity, container]) field.addEventListener('input', markInput);
quantity.addEventListener('input', () => { calculatedGeneration = -1; app.dataset.calculatedGeneration = '-1'; total.value = ''; validation.textContent = ''; });
location.addEventListener('input', () => { calculatedGeneration = -1; app.dataset.calculatedGeneration = '-1'; total.value = ''; validation.textContent = ''; });

const factorOf = value => containerFactors.get(value) ?? null;
const clearTotal = () => { total.value = ''; calculatedGeneration = -1; app.dataset.calculatedGeneration = '-1'; };

async function loadContainers(name) {
  const request = optionsRequest += 1;
  const reply = await fetch('/portal/containers?location=' + encodeURIComponent(name), { cache: 'no-store' });
  const value = await reply.json();
  if (request !== optionsRequest) return;
  containerFactors = new Map((value.containers ?? []).map(item => [item.value, item.factor]));
  const previous = container.value;
  const placeholders = [new Option('请选择', '')];
  for (const item of value.containers ?? []) {
    const option = new Option(item.label ?? item.value, item.value);
    option.dataset.factor = String(item.factor);
    placeholders.push(option);
  }
  container.replaceChildren(...placeholders);
  container.dataset.options = String((value.containers ?? []).length);
  if (containerFactors.has(previous)) container.value = previous;
  else if (previous !== '') {
    // 地点改变使已选容器失效：清空容器并使总量作废，等待重新录入。
    container.value = '';
    clearTotal();
    markInput();
    validation.textContent = '地点变化后需重新选择容器';
  }
}

let optionsTimer = null;
const refreshContainers = () => {
  if (composing) return;
  const name = location.value.trim();
  if (name === lastLocation) return;
  lastLocation = name;
  clearTimeout(optionsTimer);
  optionsTimer = setTimeout(() => loadContainers(name), 12);
};
location.addEventListener('change', refreshContainers);
location.addEventListener('focusout', refreshContainers);
location.addEventListener('input', () => { if (!composing) setTimeout(refreshContainers, 25); });

quantity.addEventListener('blur', () => {
  calculatedGeneration = -1;
  app.dataset.calculatedGeneration = '-1';
  if (!/^\d+$/.test(quantity.value) || Number(quantity.value) <= 0) {
    total.value = '';
    validation.textContent = '数量必须为正整数';
    return;
  }
  const normalized = String(Number(quantity.value));
  if (quantity.value !== normalized) quantity.value = normalized; // 规范化回写
  const factor = factorOf(container.value);
  if (factor === null) {
    total.value = '';
    validation.textContent = '请先选择可用容器';
    return;
  }
  const current = generation;
  if (state.mode === 'late') setTimeout(() => {
    total.value = '999';
    calculatedGeneration = current - 1;
    app.dataset.calculatedGeneration = String(calculatedGeneration);
  }, 15);
  setTimeout(() => {
    total.value = String(Number(quantity.value) * factor);
    calculatedGeneration = current;
    app.dataset.calculatedGeneration = String(calculatedGeneration);
    validation.textContent = '校验通过';
  }, 70);
});

document.querySelector('#save').onclick = async () => {
  const outcome = await action({ action: 'save', composing, inputGeneration: generation, calculatedGeneration, record: { location: location.value, container: container.value, quantity: quantity.value, total: Number(total.value) } });
  const record = outcome.value && outcome.value.record;
  if (record && typeof record === 'object') {
    // 服务端可能规范化或回退刚录入的值；页面以服务端记录为准并回写控件。
    if (typeof record.location === 'string' && record.location !== location.value) location.value = record.location;
    if (typeof record.container === 'string' && record.container !== container.value && containerFactors.has(record.container)) container.value = record.container;
    if (record.quantity !== undefined && String(record.quantity) !== quantity.value) quantity.value = String(record.quantity);
    if (record.total !== undefined && String(record.total) !== total.value) {
      total.value = String(record.total);
      calculatedGeneration = generation;
      app.dataset.calculatedGeneration = String(calculatedGeneration);
    }
  }
  return outcome;
};

// 门户录入适配层：所有写入都走真实键盘 / 组合事件，不直接给 DOM 赋 value。
// 每次动作后都从页面回读字段值、组合状态和联动计算代次，由工作流决定下一步。

export const SELECTORS = {
  app: '#app',
  location: '#location',
  container: '#container',
  quantity: '#quantity',
  total: '#total',
  validation: '#validation',
  save: '#save',
};

const FIELD_IDS = ['location', 'container', 'quantity'];

export function normalizeText(value) {
  return String(value ?? '').normalize('NFC');
}

export function canonicalQuantity(value) {
  const text = String(value ?? '').trim();
  return /^\d+$/.test(text) ? String(Number(text)) : text;
}

export function quantityMatches(readback, raw) {
  const actual = canonicalQuantity(readback);
  const expected = canonicalQuantity(raw);
  return actual !== '' && actual === expected;
}

export function expectedTotal(quantity, factor) {
  const number = Number(canonicalQuantity(quantity));
  if (!Number.isFinite(number) || number <= 0) return null;
  if (factor === null || factor === undefined) return null;
  const scale = Number(factor);
  return Number.isFinite(scale) && scale > 0 ? number * scale : null;
}

async function sleep(milliseconds) {
  await new Promise(resolve => setTimeout(resolve, milliseconds));
}

export async function readForm(page) {
  return page.evaluate(selectors => {
    const app = document.querySelector(selectors.app);
    const location = document.querySelector(selectors.location);
    const container = document.querySelector(selectors.container);
    const quantity = document.querySelector(selectors.quantity);
    const total = document.querySelector(selectors.total);
    const validation = document.querySelector(selectors.validation);
    const save = document.querySelector(selectors.save);
    const describeOptions = element => element && 'options' in element
      ? [...element.options].map(option => ({
        value: option.value,
        label: option.textContent.trim(),
        disabled: option.disabled,
        factor: option.dataset && option.dataset.factor !== undefined && option.dataset.factor !== ''
          ? Number(option.dataset.factor)
          : null,
      }))
      : null;
    return {
      ready: Boolean(app && location && container && quantity && save),
      location: {
        tag: location?.tagName ?? null,
        value: location?.value ?? '',
        options: describeOptions(location),
        disabled: Boolean(location?.disabled),
        composing: location?.dataset.composing === 'true',
      },
      container: {
        tag: container?.tagName ?? null,
        value: container?.value ?? '',
        options: describeOptions(container),
        disabled: Boolean(container?.disabled),
      },
      quantity: {
        value: quantity?.value ?? '',
        disabled: Boolean(quantity?.disabled),
      },
      total: String(total?.value ?? total?.textContent ?? '').trim(),
      validation: String(validation?.textContent ?? '').trim(),
      inputGeneration: Number(app?.dataset.inputGeneration ?? -1),
      calculatedGeneration: Number(app?.dataset.calculatedGeneration ?? -1),
      active: document.activeElement?.id ?? null,
    };
  }, SELECTORS);
}

export async function installRecorder(page) {
  await page.evaluate(fieldIds => {
    const key = '__compositionRpaEvidence';
    if (window[key]) return;
    const record = { events: [], totalChanges: [], validationChanges: [], generationChanges: [] };
    window[key] = record;
    for (const type of ['compositionstart', 'compositionupdate', 'compositionend', 'input', 'change', 'focusin', 'blur', 'focusout']) {
      document.addEventListener(type, event => {
        const target = event.target;
        if (!target || !fieldIds.includes(target.id)) return;
        if (record.events.length >= 2000) return;
        record.events.push({
          type,
          field: target.id,
          at: Math.round(performance.now() * 1000) / 1000,
          data: typeof event.data === 'string' ? event.data : null,
          value: target.value,
          composing: target.dataset?.composing ?? null,
          isComposing: typeof event.isComposing === 'boolean' ? event.isComposing : null,
          inputType: event.inputType ?? null,
          trusted: event.isTrusted === true,
          generation: Number(document.querySelector('#app')?.dataset.inputGeneration ?? -1),
        });
      }, true);
    }
    const observeText = (element, sink) => {
      if (!element) return;
      new MutationObserver(() => {
        sink.push({
          at: Math.round(performance.now() * 1000) / 1000,
          text: element.textContent,
          value: 'value' in element ? element.value : null,
          inputGeneration: Number(document.querySelector('#app')?.dataset.inputGeneration ?? -1),
          calculatedGeneration: Number(document.querySelector('#app')?.dataset.calculatedGeneration ?? -1),
          validation: document.querySelector('#validation')?.textContent ?? '',
        });
      }).observe(element, { subtree: true, childList: true, characterData: true, attributes: true });
    };
    observeText(document.querySelector('#total'), record.totalChanges);
    observeText(document.querySelector('#validation'), record.validationChanges);
    const app = document.querySelector('#app');
    if (app) {
      new MutationObserver(mutations => {
        for (const mutation of mutations) {
          if (!mutation.attributeName?.startsWith('data-')) continue;
          record.generationChanges.push({
            at: Math.round(performance.now() * 1000) / 1000,
            attribute: mutation.attributeName,
            inputGeneration: Number(app.dataset.inputGeneration ?? -1),
            calculatedGeneration: Number(app.dataset.calculatedGeneration ?? -1),
          });
        }
      }).observe(app, { attributes: true });
    }
  }, FIELD_IDS);
}

export async function readRecorder(page) {
  return page.evaluate(() => {
    const record = window.__compositionRpaEvidence;
    if (!record) return null;
    return {
      events: record.events.slice(),
      totalChanges: record.totalChanges.slice(),
      validationChanges: record.validationChanges.slice(),
      generationChanges: record.generationChanges.slice(),
    };
  });
}

async function clearFocusedField(page, selector) {
  await page.locator(selector).click();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  const value = await page.locator(selector).inputValue().catch(() => '');
  return value;
}

async function waitForValue(page, selector, expected, timeout = 400) {
  try {
    await page.waitForFunction(({ selector, expected }) => {
      const element = document.querySelector(selector);
      return element && element.value === expected;
    }, { selector, expected }, { timeout });
    return true;
  } catch {
    return false;
  }
}

function describeOption(options, desired) {
  if (!options) return null;
  const wanted = normalizeText(desired).trim();
  return options.find(option => option.value === wanted)
    ?? options.find(option => option.label === wanted)
    ?? null;
}

async function selectOptionByKeyboard(page, selector, desired, options, readValue) {
  const select = page.locator(selector);
  await select.focus();
  await page.keyboard.press('Home');
  let value = await readValue();
  const wanted = describeOption(options, desired);
  if (!wanted) return { ok: false, value, options };
  const target = wanted.value;
  for (let step = 0; step < options.length + 2 && value !== target; step += 1) {
    await page.keyboard.press('ArrowDown');
    value = await readValue();
  }
  if (value !== target) return { ok: false, value, options };
  await page.keyboard.press('Tab');
  return { ok: true, value, options };
}

/**
 * 地点录入：先尝试真实 IME 组合事件；若页面在组合期间抢走焦点导致组合被提前结束，
 * 清理残留的半截文本，再用键盘文本插入完成同样提交语义的录入。
 */
export async function enterLocation(page, desired, context) {
  const expected = normalizeText(desired);
  const attempts = [];
  const selector = SELECTORS.location;
  let snapshot = await readForm(page);
  if (snapshot.location.tag === 'SELECT') {
    const selected = describeOption(snapshot.location.options, expected);
    if (selected && snapshot.location.value === selected.value) {
      attempts.push({ method: 'unchanged', readback: snapshot.location.value, committed: true });
      return { ok: true, method: 'already-present', attempts, readback: snapshot.location.value };
    }
    if (!selected) {
      return { ok: false, reason: '地点不可用：' + expected, attempts, readback: snapshot.location.value, options: snapshot.location.options };
    }
    const chosen = await selectOptionByKeyboard(page, selector, expected, snapshot.location.options, async () => (await readForm(page)).location.value);
    attempts.push({ method: 'select', ...chosen, target: selected.value });
    if (!chosen.ok || chosen.value !== selected.value) {
      return { ok: false, reason: '地点选择未生效', attempts, readback: chosen.value, options: snapshot.location.options };
    }
    await page.keyboard.press('Tab');
    return { ok: true, method: 'select', attempts, readback: chosen.value };
  }
  if (normalizeText(snapshot.location.value) === expected && !snapshot.location.composing) {
    attempts.push({ method: 'unchanged', readback: snapshot.location.value, committed: !snapshot.location.composing });
    return { ok: true, method: 'already-present', attempts, readback: snapshot.location.value };
  }

  const cdp = context.cdp ?? (context.cdp = await page.context().newCDPSession(page));
  let method = null;
  let failure = null;
  try {
    const cleared = await clearFocusedField(page, selector);
    if (cleared !== '') throw new Error('地点字段未能清空，当前为 ' + JSON.stringify(cleared));
    const characters = Array.from(expected);
    if (characters.length === 0) throw new Error('地点为空');
    const prefixes = [];
    const stride = characters.length > 8 ? Math.ceil(characters.length / 8) : 1;
    for (let index = 1; index <= characters.length; index += stride) prefixes.push(characters.slice(0, index).join(''));
    if (prefixes[prefixes.length - 1] !== expected) prefixes.push(expected);
    let composed = 0;
    for (const prefix of prefixes) {
      const live = await readForm(page);
      const expectedComposing = composed > 0;
      if (live.active !== 'location' || (live.location.composing !== expectedComposing)) {
        throw new Error('组合过程中焦点或组合状态被页面改变');
      }
      await cdp.send('Input.imeSetComposition', { text: prefix, selectionStart: prefix.length, selectionEnd: prefix.length });
      const after = await readForm(page);
      if (after.active !== 'location' || !after.location.composing) {
        throw new Error('组合过程中焦点或组合状态被页面改变');
      }
      composed += 1;
      await sleep(2);
    }
    const beforeCommit = await readForm(page);
    if (beforeCommit.active !== 'location' || !beforeCommit.location.composing) {
      throw new Error('组合结束前焦点或组合状态被页面改变');
    }
    attempts.push({ method: 'composition', composedPrefixes: prefixes, composingBeforeCommit: true });
    await cdp.send('Input.insertText', { text: expected });
    if (!await page.waitForFunction(({ selector, expected }) => {
      const element = document.querySelector(selector);
      return element?.value === expected && element.dataset.composing !== 'true';
    }, { selector, expected }, { timeout: 500 }).then(() => true).catch(() => false)) {
      throw new Error('组合提交后回读不一致');
    }
    method = 'composition';
  } catch (error) {
    failure = error.message;
    await clearFocusedField(page, selector);
    await page.keyboard.insertText(expected);
    const matched = await waitForValue(page, selector, expected, 500);
    if (!matched) {
      const readback = await page.locator(selector).inputValue().catch(() => '');
      attempts.push({ method: 'text-fallback', fallbackReason: failure, readback, committed: false });
      return { ok: false, reason: '地点文本提交后回读不一致', attempts, readback, fallbackReason: failure };
    }
    attempts.push({ method: 'text-fallback', fallbackReason: failure, readback: expected, committed: true, inputType: 'insertText' });
    method = 'text-fallback';
  }

  // 让地点字段失焦，确保 change / 提交语义已经发生，然后再核对一次。
  if ((await readForm(page)).active === 'location') await page.keyboard.press('Tab');
  await sleep(5);
  const readback = (await readForm(page)).location.value;
  const committed = !(await readForm(page)).location.composing && normalizeText(readback) === expected;
  return { ok: committed, method, attempts, readback, reason: committed ? null : '地点回读与录入不一致' };
}

export async function chooseContainer(page, desired, context) {
  const expected = normalizeText(desired).trim();
  const attempts = [];
  let snapshot = await readForm(page);
  if (!snapshot.container.tag) return { ok: false, reason: '页面没有容器控件', attempts, readback: null };
  if (snapshot.container.tag === 'SELECT') {
    // 容器选项由地点联动异步加载；先等选项出现，再判断是否真的不可用。
    let wanted = describeOption(snapshot.container.options, expected);
    if (!wanted) {
      snapshot = await waitForContainerOptions(page, expected, 500);
      wanted = describeOption(snapshot.container.options, expected);
    }
    if (!wanted) {
      const available = (snapshot.container.options ?? []).map(option => option.label).filter(Boolean);
      return {
        ok: false,
        reason: '该地点下没有可用容器：' + expected + (available.length ? '（可用：' + available.join('、') + '）' : ''),
        attempts,
        readback: snapshot.container.value,
        options: snapshot.container.options,
      };
    }
    if (snapshot.container.value === wanted.value) {
      attempts.push({ method: 'unchanged', readback: snapshot.container.value, label: wanted.label });
      return { ok: true, method: 'already-present', attempts, readback: snapshot.container.value, label: wanted.label };
    }
    const chosen = await selectOptionByKeyboard(page, SELECTORS.container, expected, snapshot.container.options, async () => (await readForm(page)).container.value);
    attempts.push({ method: 'select', target: wanted.value, ...chosen });
    if (!chosen.ok || chosen.value !== wanted.value) {
      return { ok: false, reason: '容器选择未生效：' + expected, attempts, readback: chosen.value, options: snapshot.container.options };
    }
    await sleep(5);
    const readback = (await readForm(page)).container.value;
    if (readback !== wanted.value) {
      return { ok: false, reason: '容器回读与录入不一致', attempts, readback: readback };
    }
    return { ok: true, method: 'select', attempts, readback, label: wanted.label };
  }
  // 非 select 的容器控件：按普通文本录入处理，仍然不使用 DOM 赋值。
  const cleared = await clearFocusedField(page, SELECTORS.container);
  if (cleared !== '') return { ok: false, reason: '容器字段未能清空', attempts, readback: cleared };
  await page.keyboard.insertText(expected);
  const matched = await waitForValue(page, SELECTORS.container, expected, 400);
  const readback = (await readForm(page)).container.value;
  attempts.push({ method: 'text', readback, committed: matched });
  if (!matched) return { ok: false, reason: '容器回读与录入不一致', attempts, readback };
  if ((await readForm(page)).active === 'container') await page.keyboard.press('Tab');
  return { ok: true, method: 'text', attempts, readback };
}

export async function enterQuantity(page, raw) {
  const expected = canonicalQuantity(raw);
  const attempts = [];
  const selector = SELECTORS.quantity;
  let snapshot = await readForm(page);
  if (snapshot.quantity.disabled) return { ok: false, reason: '数量控件不可用', attempts, readback: snapshot.quantity.value };
  if (quantityMatches(snapshot.quantity.value, raw)) {
    attempts.push({ method: 'unchanged', readback: snapshot.quantity.value, canonical: snapshot.quantity.value });
    return { ok: true, method: 'already-present', attempts, readback: snapshot.quantity.value };
  }
  await clearFocusedField(page, selector);
  await page.keyboard.type(String(raw));
  let readback = (await readForm(page)).quantity.value;
  if (!quantityMatches(readback, raw)) {
    // 页面可能在输入过程中做了规范化；只允许一次重录，不循环覆盖。
    await clearFocusedField(page, selector);
    await page.keyboard.type(String(raw));
    readback = (await readForm(page)).quantity.value;
    attempts.push({ method: 'type-retry', readback });
  }
  const matched = quantityMatches(readback, raw);
  attempts.unshift({ method: 'type', raw: String(raw), readback, canonical: canonicalQuantity(readback) });
  if (!matched) return { ok: false, reason: '数量回读与录入不一致', attempts, readback, expected };
  return { ok: true, method: 'typed', attempts, readback, canonical: canonicalQuantity(readback) };
}

export async function commitQuantity(page) {
  const snapshot = await readForm(page);
  if (snapshot.active === 'quantity') {
    await page.keyboard.press('Tab');
  } else {
    await page.locator(SELECTORS.quantity).focus();
    await page.keyboard.press('Tab');
  }
  return readForm(page);
}

/**
 * 等待“本轮输入”的联动计算。只接受 calculatedGeneration === inputGeneration
 * 且总量满足业务含义的结果；旧代次晚到时继续等待，必要时重新提交一次数量失焦，
 * 绝不改写刚录入的数量。
 */
export async function awaitLinkedCalculation(page, options, carried = []) {
  const { expectedQuantity, acceptTotal, timeout = 2000, settle = 100, retriggers = 1, rejectSettle = 250 } = options;
  const attempts = carried;
  const deadline = Date.now() + timeout;
  let last = null;
  let firstFailureAt = null;
  while (Date.now() < deadline) {
    const snapshot = await readForm(page);
    last = snapshot;
    const failure = snapshot.validation && snapshot.validation !== '校验通过' ? snapshot.validation : null;
    if (failure) {
      // 校验文案可能是上一轮残留：先观察一个稳定窗口，确认它不会被本轮结果替换。
      firstFailureAt ??= Date.now();
      attempts.push({ status: 'validation-pending', reason: failure, waited: Date.now() - firstFailureAt });
      if (Date.now() - firstFailureAt >= rejectSettle && snapshot.calculatedGeneration !== snapshot.inputGeneration) {
        attempts.push({ status: 'page-rejected', reason: failure, inputGeneration: snapshot.inputGeneration, calculatedGeneration: snapshot.calculatedGeneration });
        return { status: 'rejected', reason: failure, snapshot, attempts };
      }
      await sleep(20);
      continue;
    }
    firstFailureAt = null;
    const totalValue = snapshot.total === '' ? null : Number(snapshot.total);
    const fresh = snapshot.inputGeneration >= 0
      && snapshot.calculatedGeneration === snapshot.inputGeneration
      && quantityMatches(snapshot.quantity.value, expectedQuantity)
      && totalValue !== null
      && acceptTotal(totalValue);
    if (fresh) {
      // 稳定窗口：旧代次计算可能在窗口内晚到并覆盖刚算好的结果。
      const checkedAt = Date.now();
      await sleep(settle);
      const confirmation = await readForm(page);
      const confirmedFailure = confirmation.validation && confirmation.validation !== '校验通过' ? confirmation.validation : null;
      if (confirmedFailure) {
        attempts.push({ status: 'page-rejected-after-settle', reason: confirmedFailure });
        return { status: 'rejected', reason: confirmedFailure, snapshot: confirmation, attempts };
      }
      const confirmedTotal = confirmation.total === '' ? null : Number(confirmation.total);
      if (confirmation.inputGeneration === confirmation.calculatedGeneration
        && quantityMatches(confirmation.quantity.value, expectedQuantity)
        && confirmedTotal !== null
        && acceptTotal(confirmedTotal)) {
        attempts.push({
          status: 'settled',
          waited: Date.now() - checkedAt,
          inputGeneration: confirmation.inputGeneration,
          calculatedGeneration: confirmation.calculatedGeneration,
          total: confirmedTotal,
        });
        return { status: 'settled', snapshot: confirmation, attempts };
      }
      attempts.push({ status: 'changed-during-settle', total: confirmation.total, inputGeneration: confirmation.inputGeneration, calculatedGeneration: confirmation.calculatedGeneration });
    } else {
      attempts.push({
        status: 'not-ready',
        inputGeneration: snapshot.inputGeneration,
        calculatedGeneration: snapshot.calculatedGeneration,
        total: snapshot.total,
        validation: snapshot.validation,
      });
    }
    await sleep(15);
  }
  if (retriggers > 0) {
    attempts.push({ status: 'retrigger-blur', reason: '本轮计算未在时限内稳定' });
    await commitQuantity(page);
    return awaitLinkedCalculation(page, { ...options, retriggers: retriggers - 1 }, attempts);
  }
  return { status: 'timeout', reason: '联动计算未在本轮输入内完成', snapshot: last, attempts };
}

export function snapshotIsReady(snapshot, desired, total) {
  const checks = [];
  const wantedLocation = normalizeText(desired.location);
  checks.push({ item: 'location.committed', expected: wantedLocation, actual: normalizeText(snapshot.location.value), ok: normalizeText(snapshot.location.value) === wantedLocation });
  checks.push({ item: 'location.composing', expected: false, actual: snapshot.location.composing, ok: snapshot.location.composing === false });
  const wantedContainer = describeOption(snapshot.container.options, desired.container);
  const containerActual = wantedContainer ? wantedContainer.value : null;
  checks.push({ item: 'container.selected', expected: String(desired.container).trim(), actual: containerActual, ok: Boolean(wantedContainer) && snapshot.container.value === containerActual });
  checks.push({ item: 'quantity.normalized', expected: canonicalQuantity(desired.quantity), actual: canonicalQuantity(snapshot.quantity.value), ok: quantityMatches(snapshot.quantity.value, desired.quantity) });
  const totalValue = snapshot.total === '' ? null : Number(snapshot.total);
  const linkedTotal = expectedTotal(desired.quantity, wantedContainer?.factor ?? null);
  const expectedTotalValue = linkedTotal ?? total;
  checks.push({
    item: 'total.linked',
    expected: expectedTotalValue,
    actual: totalValue,
    ok: totalValue !== null
      && Number.isInteger(totalValue)
      && totalValue > 0
      && expectedTotalValue !== null
      && expectedTotalValue !== undefined
      && totalValue === expectedTotalValue
      && (total === null || total === undefined || total === expectedTotalValue),
  });
  checks.push({ item: 'calculation.generation', expected: snapshot.inputGeneration, actual: snapshot.calculatedGeneration, ok: snapshot.calculatedGeneration === snapshot.inputGeneration && snapshot.inputGeneration >= 0 });
  checks.push({ item: 'validation.accepted', expected: '校验通过', actual: snapshot.validation, ok: snapshot.validation === '校验通过' || snapshot.validation === '' });
  return { ok: checks.every(check => check.ok), checks };
}

/** 只聚焦并离开地点字段，触发页面自己的 change / focusout 联动，不修改字段值。 */
export async function nudgeLocation(page) {
  await page.locator(SELECTORS.location).focus();
  await page.keyboard.press('Tab');
}

export async function waitForContainerOptions(page, desired, timeout = 250) {
  const deadline = Date.now() + timeout;
  let snapshot = await readForm(page);
  while (Date.now() < deadline) {
    if (describeOption(snapshot.container.options, desired)) break;
    await sleep(15);
    snapshot = await readForm(page);
  }
  return snapshot;
}

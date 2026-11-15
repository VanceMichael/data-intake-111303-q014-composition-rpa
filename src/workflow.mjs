import path from 'node:path';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import {
  SELECTORS,
  awaitLinkedCalculation,
  canonicalQuantity,
  chooseContainer,
  commitQuantity,
  enterLocation,
  enterQuantity,
  installRecorder,
  normalizeText,
  quantityMatches,
  readForm,
  readRecorder,
  snapshotIsReady,
  expectedTotal,
  nudgeLocation,
  waitForContainerOptions,
} from './portal-form.mjs';

const DRAFT_VERSION = 1;

function normalizeInput(input) {
  return {
    location: String(input?.location ?? ''),
    container: String(input?.container ?? ''),
    quantity: String(input?.quantity ?? ''),
  };
}

function sameInput(left, right) {
  if (!left || !right) return false;
  return normalizeText(left.location) === normalizeText(right.location)
    && normalizeText(left.container).trim() === normalizeText(right.container).trim()
    && canonicalQuantity(left.quantity) === canonicalQuantity(right.quantity);
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeJsonAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = file + '.tmp-' + process.pid;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n');
  await rename(temporary, file);
}

function optionValue(options, desired) {
  const wanted = normalizeText(desired).trim();
  const match = options?.find(option => option.value === wanted)
    ?? options?.find(option => option.label === wanted && option.value !== '');
  return match ? match.value : null;
}

function locationCommitted(snapshot, desired) {
  return !snapshot.location.composing && normalizeText(snapshot.location.value) === normalizeText(desired);
}

function containerChosen(snapshot, desired) {
  const value = optionValue(snapshot.container.options, desired);
  return Boolean(value) && snapshot.container.value === value;
}

function compositionEvidence(recorder, snapshot, desired) {
  const events = (recorder?.events ?? []).filter(event => event.field === 'location');
  const lastEndIndex = events.map(event => event.type).lastIndexOf('compositionend');
  const lastEnd = lastEndIndex >= 0 ? events[lastEndIndex] : null;
  const afterEnd = lastEndIndex >= 0 ? events.slice(lastEndIndex + 1) : events;
  const committedText = afterEnd.find(event => (event.type === 'input' || event.type === 'change' || event.type === 'compositionend')
    && event.value === desired
    && event.composing !== 'true');
  const compositionSeen = events.some(event => event.type === 'compositionstart');
  const compositionEnded = Boolean(lastEnd);
  const fallback = Boolean(committedText) && !(lastEnd && lastEnd.value === desired);
  // 恢复场景下字段可能本来就是完整的提交值：没有组合事件但回读精确且不在组合中，
  // 只能视为“已提交”，并明确标注依据，不伪造组合事件。
  const preExisting = !compositionSeen
    && !snapshot.location.composing
    && normalizeText(snapshot.location.value) === desired;
  return {
    compositionSeen,
    compositionEnded,
    compositionEndValue: lastEnd?.value ?? null,
    committedTextValue: committedText?.value ?? null,
    committedAfterEnd: Boolean(committedText),
    fallback,
    preExisting,
    composingNow: snapshot.location.composing,
    ok: !snapshot.location.composing
      && (lastEnd?.value === desired || Boolean(committedText) || preExisting),
    eventCount: events.length,
  };
}

function linkedTotalFor(snapshot, desired) {
  const option = optionValue(snapshot.container.options, desired.container);
  const factor = snapshot.container.options?.find(candidate => candidate.value === option)?.factor ?? null;
  return expectedTotal(desired.quantity, factor);
}

function calculationEvidence(recorder, snapshot, expectedTotal) {
  const quantityInputs = (recorder?.events ?? []).filter(event => event.field === 'quantity' && (event.type === 'input' || event.type === 'change'));
  const lastQuantityInput = quantityInputs[quantityInputs.length - 1] ?? null;
  const totalChanges = recorder?.totalChanges ?? [];
  const matching = totalChanges.filter(change => String(change.value ?? change.text) === String(expectedTotal)
    && change.inputGeneration === change.calculatedGeneration);
  const lastChange = totalChanges[totalChanges.length - 1] ?? null;
  const origin = matching[matching.length - 1] ?? null;
  return {
    expectedTotal: Number(expectedTotal),
    inputGeneration: snapshot.inputGeneration,
    calculatedGeneration: snapshot.calculatedGeneration,
    lastQuantityInputAt: lastQuantityInput?.at ?? null,
    matchingChange: origin,
    lastTotalChange: lastChange,
    totalChangeCount: totalChanges.length,
    belongsToThisRound: Boolean(origin)
      && snapshot.calculatedGeneration === snapshot.inputGeneration
      && (!lastQuantityInput || origin.at >= lastQuantityInput.at)
      && (!lastChange || String(lastChange.value ?? lastChange.text) === String(expectedTotal)),
    ok: Boolean(origin)
      && snapshot.calculatedGeneration === snapshot.inputGeneration
      && (!lastChange || String(lastChange.value ?? lastChange.text) === String(expectedTotal)),
  };
}

function buildComparison({ desired, snapshot, request, serverRecord, total }) {
  const containerExpected = optionValue(snapshot.container.options, desired.container) ?? desired.container;
  const quantityExpected = canonicalQuantity(desired.quantity);
  const freshExpected = snapshot.inputGeneration >= 0 && snapshot.calculatedGeneration === snapshot.inputGeneration;
  const requestFresh = request?.inputGeneration !== undefined && request?.calculatedGeneration !== undefined
    ? request.inputGeneration === request.calculatedGeneration
    : null;
  const rows = [
    {
      item: 'location',
      expected: normalizeText(desired.location),
      pageReadback: snapshot.location.value,
      saveRequest: request?.record?.location ?? null,
      serverRecord: serverRecord?.location ?? null,
    },
    {
      item: 'container',
      expected: containerExpected,
      pageReadback: snapshot.container.value,
      saveRequest: request?.record?.container ?? null,
      serverRecord: serverRecord?.container ?? null,
    },
    {
      item: 'quantity.normalized',
      expected: quantityExpected,
      pageReadback: canonicalQuantity(snapshot.quantity.value),
      saveRequest: request?.record?.quantity ?? null,
      serverRecord: serverRecord ? canonicalQuantity(serverRecord.quantity) : null,
    },
    {
      item: 'total.linked',
      expected: total,
      pageReadback: snapshot.total === '' ? null : Number(snapshot.total),
      saveRequest: request?.record?.total ?? null,
      serverRecord: serverRecord ? Number(serverRecord.total) : null,
    },
    {
      item: 'location.composing',
      expected: false,
      pageReadback: snapshot.location.composing,
      saveRequest: request && 'composing' in request ? Boolean(request.composing) : null,
      serverRecord: null,
    },
    {
      item: 'calculation.fresh',
      expected: true,
      pageReadback: freshExpected,
      saveRequest: requestFresh,
      serverRecord: null,
    },
  ];
  return rows.map(row => {
    const observed = [row.pageReadback, row.saveRequest, row.serverRecord].filter(value => value !== null);
    return {
      ...row,
      match: row.expected !== null && observed.length > 0 && observed.every(value => value === row.expected),
    };
  });
}

function rejectedResult({ input, reason, evidence, record, extra = {} }) {
  return {
    state: 'rejected',
    reason,
    input,
    ...(record ? { record } : {}),
    ...extra,
    evidence,
  };
}

async function openPortal(source) {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(6000);
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const response = await page.goto(new URL('/portal', source).toString(), { waitUntil: 'domcontentloaded' });
  if (!response || !response.ok()) {
    await browser.close();
    throw new Error('门户不可用：' + (response ? response.status() : '无响应'));
  }
  await page.waitForSelector(SELECTORS.location);
  await page.waitForSelector(SELECTORS.save);
  await installRecorder(page);
  return { browser, context, page, pageErrors };
}

async function readServerState(page) {
  return page.evaluate(async () => {
    const response = await fetch('/portal/state', { headers: { accept: 'application/json' }, cache: 'no-store' });
    let body = null;
    try { body = await response.json(); } catch { body = null; }
    return { status: response.status, body };
  });
}

function recordMatchesServer(serverRecord, desired) {
  if (!serverRecord) return false;
  const containerExpected = normalizeText(desired.container).trim();
  const containerActual = normalizeText(serverRecord.container).trim();
  const total = Number(serverRecord.total);
  return normalizeText(serverRecord.location) === normalizeText(desired.location)
    && containerActual === containerExpected
    && canonicalQuantity(serverRecord.quantity) === canonicalQuantity(desired.quantity)
    && Number.isInteger(total)
    && total > 0;
}

async function enterPendingFields({ page, context, desired, draft, steps }) {
  const failures = new Map();
  const tasks = [
    {
      id: 'location',
      done: snapshot => locationCommitted(snapshot, desired.location),
      ready: () => true,
      enter: async snapshot => {
        const outcome = await enterLocation(page, desired.location, context);
        steps.push({ field: 'location', at: Date.now(), ...outcome });
        draft.fields.location = { readback: outcome.readback, method: outcome.method, ok: outcome.ok, attempts: outcome.attempts };
        return outcome;
      },
    },
    {
      id: 'container',
      done: snapshot => containerChosen(snapshot, desired.container),
      ready: snapshot => locationCommitted(snapshot, desired.location),
      prepare: async () => {
        // 容器选项随地点异步加载：先触发页面自身的联动刷新，再等待所需选项出现。
        await nudgeLocation(page);
        const waited = await waitForContainerOptions(page, desired.container, 800);
        if (!optionValue(waited.container.options, desired.container)) {
          await nudgeLocation(page);
          return waitForContainerOptions(page, desired.container, 500);
        }
        return waited;
      },
      enter: async () => {
        const outcome = await chooseContainer(page, desired.container, context);
        steps.push({ field: 'container', at: Date.now(), ...outcome });
        draft.fields.container = { readback: outcome.readback, method: outcome.method, ok: outcome.ok, attempts: outcome.attempts };
        if (outcome.ok) {
          // 容器变化会让总量作废：后续必须由本轮数量失焦重新计算，不能沿用旧总量。
          const after = await readForm(page);
          if (after.calculatedGeneration !== after.inputGeneration) {
            steps.push({ field: 'calculation', at: Date.now(), ok: true, method: 'invalidated-by-container', calculatedGeneration: after.calculatedGeneration, inputGeneration: after.inputGeneration });
          }
        }
        return outcome;
      },
    },
    {
      id: 'quantity',
      done: snapshot => quantityMatches(snapshot.quantity.value, desired.quantity),
      ready: snapshot => containerChosen(snapshot, desired.container),
      enter: async () => {
        const outcome = await enterQuantity(page, desired.quantity);
        steps.push({ field: 'quantity', at: Date.now(), ...outcome });
        draft.fields.quantity = { readback: outcome.readback, canonical: outcome.canonical, method: outcome.method, ok: outcome.ok, attempts: outcome.attempts };
        return outcome;
      },
    },
  ];

  for (let round = 0; round < 9; round += 1) {
    const snapshot = await readForm(page);
    if (!snapshot.ready) return { ok: false, reason: '门户表单尚未就绪', snapshot };
    const pending = tasks.filter(task => !task.done(snapshot));
    if (pending.length === 0) return { ok: true, snapshot };

    const candidate = pending.find(task => task.ready(snapshot));
    if (!candidate) {
      if (pending.some(task => task.id === 'container') && !pending.some(task => task.id === 'location')) {
        const waited = await waitForContainerOptions(page, desired.container, 350);
        if (!optionValue(waited.container.options, desired.container)) {
          return { ok: false, reason: '地点录入后没有出现所需容器：' + desired.container, snapshot: waited };
        }
      }
      await new Promise(resolve => setTimeout(resolve, 15));
      continue;
    }

    if (candidate.prepare) {
      const prepared = await candidate.prepare();
      const preparedSnapshot = prepared ?? await readForm(page);
      if (candidate.done(preparedSnapshot)) {
        // 已满足的字段也要留下判断依据：来自页面回读，而不是草稿里的旧值。
        const readback = candidate.id === 'container'
          ? preparedSnapshot.container.value
          : candidate.id === 'quantity'
            ? preparedSnapshot.quantity.value
            : preparedSnapshot.location.value;
        steps.push({ field: candidate.id, at: Date.now(), ok: true, method: 'skipped-readable', source: 'page-readback', readback });
        continue;
      }
    }
    const outcome = await candidate.enter(snapshot);
    const count = (failures.get(candidate.id) ?? 0) + (outcome.ok ? 0 : 1);
    failures.set(candidate.id, count);
    if (!outcome.ok && count >= 2) {
      return { ok: false, reason: outcome.reason ?? (candidate.id + ' 录入失败'), snapshot: await readForm(page), failedField: candidate.id };
    }
    const after = await readForm(page);
    if (!candidate.done(after)) {
      failures.set(candidate.id, (failures.get(candidate.id) ?? 0) + 1);
      if (failures.get(candidate.id) >= 3) {
        return { ok: false, reason: candidate.id + ' 回读与录入不一致', snapshot: after, failedField: candidate.id };
      }
    }
  }
  return { ok: false, reason: '录入未能收敛', snapshot: await readForm(page) };
}

export async function run({ source, stateDir, input }) {
  if (!source) throw new Error('缺少来源地址');
  if (!stateDir) throw new Error('缺少状态目录');
  const desired = normalizeInput(input);
  const resultFile = path.join(stateDir, 'result.json');
  const draftFile = path.join(stateDir, 'draft.json');

  // 已落盘且判定明确的结果直接复用，不再打开门户，避免重复触发有副作用的保存。
  const stored = await readJson(resultFile);
  if (stored && stored.input && sameInput(stored.input, desired) && ['saved', 'rejected'].includes(stored.state)) {
    return { ...stored, evidence: { ...(stored.evidence ?? {}), reusedStoredResult: true } };
  }

  if (!desired.location || !desired.container || !desired.quantity) {
    const result = rejectedResult({
      input: desired,
      reason: '地点、容器与数量均为必填',
      evidence: { checks: [{ item: 'input.complete', ok: false, input: desired }] },
    });
    await writeJsonAtomic(resultFile, { ...result, input: desired });
    return result;
  }

  await mkdir(stateDir, { recursive: true });
  let draft = await readJson(draftFile);
  const draftReused = Boolean(draft && sameInput(draft.input, desired));
  if (!draftReused) {
    draft = {
      version: DRAFT_VERSION,
      input: desired,
      createdAt: new Date().toISOString(),
      fields: {},
      steps: [],
      calculation: null,
      save: { attempts: [], confirmed: false },
      resume: null,
    };
  }
  draft.input = desired;
  draft.steps = draft.steps ?? [];
  draft.fields = draft.fields ?? {};
  draft.save = draft.save ?? { attempts: [], confirmed: false };
  await writeJsonAtomic(draftFile, draft);

  const session = await openPortal(source);
  const { browser, context, page, pageErrors } = session;
  const actions = [];
  let responseStatus = null;
  try {
    const pageSnapshotAtResume = await readForm(page);
    // 以页面现状为准决定哪些字段还要录；草稿只用来追溯当时读到什么，不直接当页面值使用。
    const satisfiedAtResume = [
      locationCommitted(pageSnapshotAtResume, desired.location) ? 'location' : null,
      containerChosen(pageSnapshotAtResume, desired.container) ? 'container' : null,
      quantityMatches(pageSnapshotAtResume.quantity.value, desired.quantity) ? 'quantity' : null,
    ].filter(Boolean);
    const resume = {
      draftReused,
      storedResultReused: false,
      draftFields: Object.fromEntries(Object.entries(draft.fields ?? {}).map(([key, value]) => [key, value?.readback ?? null])),
      pageStateAtResume: {
        location: pageSnapshotAtResume.location.value,
        container: {
          value: pageSnapshotAtResume.container.value,
          options: (pageSnapshotAtResume.container.options ?? []).map(option => option.value).filter(Boolean),
        },
        quantity: pageSnapshotAtResume.quantity.value,
        total: pageSnapshotAtResume.total,
        validation: pageSnapshotAtResume.validation,
        inputGeneration: pageSnapshotAtResume.inputGeneration,
      },
      skippedFields: satisfiedAtResume,
      remainingFields: ['location', 'container', 'quantity'].filter(field => !satisfiedAtResume.includes(field)),
      pendingSaveFromDraft: Boolean(draft.save?.attempts?.length && !draft.save?.confirmed),
      serverRecheck: null,
    };

    // 恢复：上次已发起保存但未拿到确认时，只读查看服务端现状，避免重复触发有副作用的保存。
    if (resume.pendingSaveFromDraft) {
      const server = await readServerState(page);
      resume.serverRecheck = {
        at: new Date().toISOString(),
        status: server.status,
        record: server.body?.record ?? null,
        requestCount: draft.save.attempts.length,
      };
      if (server.status === 200 && recordMatchesServer(server.body?.record, desired)) {
        const result = {
          state: 'saved',
          input: desired,
          record: {
            location: server.body.record.location,
            container: server.body.record.container,
            quantity: canonicalQuantity(server.body.record.quantity),
            total: Number(server.body.record.total),
          },
          evidence: {
            portal: { origin: new URL(source).origin, path: '/portal', title: await page.title() },
            recovery: resume,
            actions,
            comparison: [{
              item: 'server.recovery',
              expected: 'same-input-record',
              pageReadback: null,
              saveRequest: null,
              serverRecord: server.body.record,
              match: true,
            }],
            pageErrors,
          },
        };
        draft.save.confirmed = true;
        draft.result = result;
        await writeJsonAtomic(draftFile, draft);
        await writeJsonAtomic(resultFile, result);
        return result;
      }
    }

    // 本次执行的逐字段动作证据；草稿里的 steps 属于此前执行，只作历史保留。
    const steps = [];
    const entry = await enterPendingFields({ page, context, desired, draft, steps });
    const previousSteps = draft.steps ?? [];
    if (previousSteps.length) {
      draft.resumeHistory = [...(draft.resumeHistory ?? []), { at: new Date().toISOString(), steps: previousSteps }];
    }
    draft.steps = steps;
    await writeJsonAtomic(draftFile, draft);
    if (!entry.ok) {
      const recorder = await readRecorder(page);
      const result = rejectedResult({
        input: desired,
        reason: entry.reason,
        evidence: {
          portal: { origin: new URL(source).origin, path: '/portal', title: await page.title() },
          resume,
          fields: steps,
          snapshot: entry.snapshot,
          events: recorder?.events ?? [],
          pageErrors,
        },
        extra: { failedField: entry.failedField ?? null },
      });
      draft.result = result;
      await writeJsonAtomic(draftFile, draft);
      await writeJsonAtomic(resultFile, result);
      return result;
    }

    // 数量必须在失焦后触发本轮联动计算。即使页面看起来已有结果，也重新失焦一次，
    // 让联动计算确实发生在本轮输入上（只触发计算，不改写任何字段值）。
    const beforeBlur = await readForm(page);
    await commitQuantity(page);
    steps.push({
      field: 'quantity.commit',
      at: Date.now(),
      ok: true,
      method: beforeBlur.active === 'quantity' ? 'tab-out' : 'focus-then-tab-out',
      inputGeneration: beforeBlur.inputGeneration,
      calculatedGenerationBefore: beforeBlur.calculatedGeneration,
    });
    const expectedLinked = linkedTotalFor(await readForm(page), desired);
    const linked = await awaitLinkedCalculation(page, {
      expectedQuantity: desired.quantity,
      acceptTotal: value => Number.isInteger(value) && value > 0 && (expectedLinked === null || value === expectedLinked),
      timeout: 2000,
      settle: 100,
    });

    if (linked.status === 'rejected') {
      const recorder = await readRecorder(page);
      const result = rejectedResult({
        input: desired,
        reason: linked.reason || '数量未通过页面校验',
        record: { location: desired.location, container: desired.container, quantity: canonicalQuantity(desired.quantity) },
        evidence: {
          portal: { origin: new URL(source).origin, path: '/portal', title: await page.title() },
          resume,
          fields: steps,
          validation: linked.snapshot?.validation ?? linked.reason,
          calculationAttempts: linked.attempts,
          quantityReadback: linked.snapshot?.quantity?.value ?? null,
          events: recorder?.events ?? [],
          totalChanges: recorder?.totalChanges ?? [],
          pageErrors,
          note: '页面业务校验拒绝，保留原始输入，不覆盖用户选择，也不发起保存',
        },
      });
      draft.result = result;
      draft.fields.quantity = { ...(draft.fields.quantity ?? {}), validated: false, reason: result.reason };
      await writeJsonAtomic(draftFile, draft);
      await writeJsonAtomic(resultFile, result);
      return result;
    }

    if (linked.status !== 'settled') {
      const result = rejectedResult({
        input: desired,
        reason: '联动计算未在本轮输入内稳定：' + (linked.reason ?? linked.status),
        evidence: {
          portal: { origin: new URL(source).origin, path: '/portal', title: await page.title() },
          resume,
          fields: steps,
          calculationAttempts: linked.attempts,
          snapshot: linked.snapshot ?? null,
          pageErrors,
        },
      });
      draft.result = result;
      await writeJsonAtomic(draftFile, draft);
      await writeJsonAtomic(resultFile, result);
      return result;
    }

    let snapshot = linked.snapshot ?? await readForm(page);
    const derivedTotal = Number(snapshot.total);
    const semanticTotal = linkedTotalFor(snapshot, desired);
    const semantic = snapshotIsReady(snapshot, desired, derivedTotal);
    const recorder = await readRecorder(page);
    const composition = compositionEvidence(recorder, snapshot, normalizeText(desired.location));
    const calculation = calculationEvidence(recorder, snapshot, derivedTotal);

    // 只有组合文本已提交、字段回读一致、联动计算确属本轮时才允许保存。
    const totalAgrees = Number.isInteger(derivedTotal) && derivedTotal > 0
      && (semanticTotal === null || derivedTotal === semanticTotal);
    if (!semantic.ok || !composition.ok || !calculation.ok || !calculation.belongsToThisRound
      || !totalAgrees) {
      const result = rejectedResult({
        input: desired,
        reason: '页面状态不满足保存条件',
        evidence: {
          portal: { origin: new URL(source).origin, path: '/portal', title: await page.title() },
          resume,
          fields: steps,
          checks: semantic.checks,
          composition,
          calculation,
          snapshot,
          pageErrors,
          note: '未发起保存，避免把半截地点或上一轮总量写入记录',
        },
      });
      draft.result = result;
      await writeJsonAtomic(draftFile, draft);
      await writeJsonAtomic(resultFile, result);
      return result;
    }

    draft.calculation = {
      inputGeneration: snapshot.inputGeneration,
      calculatedGeneration: snapshot.calculatedGeneration,
      total: derivedTotal,
      validation: snapshot.validation,
      at: new Date().toISOString(),
    };
    draft.save.attempts.push({ at: new Date().toISOString(), status: 'requested', record: {
      location: snapshot.location.value,
      container: snapshot.container.value,
      quantity: canonicalQuantity(snapshot.quantity.value),
      total: derivedTotal,
    } });
    await writeJsonAtomic(draftFile, draft);

    const requestPromise = page.waitForRequest(request => {
      if (!request.url().endsWith('/portal/action') || request.method() !== 'POST') return false;
      try { return request.postDataJSON()?.action === 'save'; } catch { return false; }
    }, { timeout: 6000 });
    const responsePromise = page.waitForResponse(reply => {
      if (!reply.url().endsWith('/portal/action') || reply.request().method() !== 'POST') return false;
      try { return reply.request().postDataJSON()?.action === 'save'; } catch { return false; }
    }, { timeout: 6000 });
    await page.click(SELECTORS.save);
    const request = await requestPromise;
    const response = await responsePromise;
    responseStatus = response.status();
    const requestBody = request.postDataJSON();
    let responseBody = null;
    try { responseBody = await response.json(); } catch { responseBody = null; }
    actions.push({
      action: 'save',
      at: new Date().toISOString(),
      request: requestBody,
      status: responseStatus,
      response: responseBody,
      responseFeedback: await page.locator('#feedback').textContent().catch(() => null),
    });
    const serverRecord = responseBody && typeof responseBody === 'object' && responseBody.record ? responseBody.record : null;
    const comparison = buildComparison({
      desired,
      snapshot,
      request: requestBody,
      serverRecord,
      total: derivedTotal,
    });

    const serverMatches = Boolean(serverRecord)
      && normalizeText(serverRecord.location) === normalizeText(desired.location)
      && canonicalQuantity(serverRecord.quantity) === canonicalQuantity(desired.quantity)
      && Number(serverRecord.total) === derivedTotal
      && serverRecord.container === snapshot.container.value;

    if (responseStatus >= 400 || !serverMatches) {
      const reason = responseBody?.error ?? (responseStatus >= 400
        ? '门户拒绝保存（HTTP ' + responseStatus + '）'
        : '服务端保存值与录入不一致');
      const result = rejectedResult({
        input: desired,
        reason,
        // 拒绝时 record 保留本次实际录入的原值；服务端改写后的值另放 serverRecord 供对照。
        record: {
          location: snapshot.location.value,
          container: snapshot.container.value,
          quantity: canonicalQuantity(snapshot.quantity.value),
          total: derivedTotal,
        },
        extra: { serverRecord: serverRecord ?? null },
        evidence: {
          portal: { origin: new URL(source).origin, path: '/portal', title: await page.title() },
          resume,
          fields: steps,
          composition,
          calculation,
          comparison,
          actions,
          pageErrors,
          note: '拒绝原因来自门户响应，原始输入保持不变',
        },
      });
      draft.save.attempts[draft.save.attempts.length - 1] = { at: new Date().toISOString(), status: 'rejected', statusCode: responseStatus, reason, request: requestBody, response: responseBody };
      draft.result = result;
      await writeJsonAtomic(draftFile, draft);
      await writeJsonAtomic(resultFile, result);
      return result;
    }

    const record = {
      location: serverRecord.location,
      container: serverRecord.container,
      quantity: canonicalQuantity(serverRecord.quantity),
      total: Number(serverRecord.total),
    };
    const result = {
      state: 'saved',
      input: desired,
      record,
      evidence: {
        portal: { origin: new URL(source).origin, path: '/portal', title: await page.title() },
        resume,
        fields: steps,
        composition,
        calculation,
        comparison,
        actions,
        requestGeneration: {
          inputGeneration: requestBody?.inputGeneration ?? null,
          calculatedGeneration: requestBody?.calculatedGeneration ?? null,
          composing: requestBody?.composing ?? null,
        },
        pageErrors,
      },
    };
    draft.save.attempts[draft.save.attempts.length - 1] = { at: new Date().toISOString(), status: 'confirmed', statusCode: responseStatus, request: requestBody, response: responseBody };
    draft.save.confirmed = true;
    draft.save.confirmedAt = new Date().toISOString();
    draft.result = result;
    await writeJsonAtomic(draftFile, draft);
    await writeJsonAtomic(resultFile, result);
    return result;
  } finally {
    await browser.close().catch(() => {});
  }
}

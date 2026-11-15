# 来源与接收约定

input.location/container/quantity 是原始录入。页面 quantity 失焦后规范化并发起异步计算；data-calculated-generation 必须等于当前 data-input-generation 后才能保存。地点有组合输入状态，可通过真实组合事件或能证明同样提交语义的用户输入完成。输出 state、record；拒绝时提供 reason。

## 边界与操作

来源地址由启动函数动态分配，不固定端口。所有时间值只按各自字段的业务含义使用；不以请求抵达顺序推导资料版本。可见结果应附真实原始响应、页面或运行证据，不能仅根据调用参数生成结果。

来源演练用例位于 fixtures/cases.json，name 为当前情形名称，routes 为实际供方响应。工作流只通过 source 暴露的接口或页面访问来源；不得导入模拟源内部状态、读取它的文件来代替真实采集。浏览器门户内部动作接口只服务页面，不是机器人可直接调用的业务 API。

读取失败不等于不存在；部分资料可以保留，但需要完整性承诺的结果不能伪称完成。重启时只能复用已落盘且能追溯依据的进度。输出可扩展更多证据字段，但不能省略下列业务状态。

## 业务输入与结果

### 组合文本提交后再保存

业务输入：
```json
{
  "location": "贝加尔湖",
  "container": "瓶",
  "quantity": "003"
}
```
结果必须包含：
```json
{
  "state": "saved",
  "record": {
    "location": "贝加尔湖",
    "quantity": "3",
    "total": 6
  }
}
```

### 旧计算晚到不可误接收

业务输入：
```json
{
  "location": "贝加尔湖",
  "container": "瓶",
  "quantity": "004"
}
```
结果必须包含：
```json
{
  "state": "saved",
  "record": {
    "quantity": "4",
    "total": 8
  }
}
```

### 非法数量保留拒绝原因

业务输入：
```json
{
  "location": "贝加尔湖",
  "container": "瓶",
  "quantity": "-1"
}
```
结果必须包含：
```json
{
  "state": "rejected",
  "reason": "数量必须为正整数"
}
```

### 录入适配层的判定与证据

`src/workflow.mjs` 通过 `src/portal-form.mjs` 操作页面：地点用真实 IME 组合事件（`compositionstart`/`compositionupdate`/`compositionend` + `Input.insertText`），容器用键盘选择，数量用键盘键入；不直接给 DOM 赋 `value`。每一步之后都从页面回读字段值、组合状态、`data-input-generation`/`data-calculated-generation` 和校验文案，再按页面现状决定下一个要录的字段。

- 录入顺序由页面现状决定：地点先提交（组合结束且回读一致）才录入容器；容器选项随地点异步加载（`/portal/containers`），选项变化或容器变更会让旧总量作废，数量需要重新失焦触发本轮计算。
- 组合期间若页面抢走焦点，组合会被浏览器提前结束；适配层清理残留的半截文本（不用拼接、不在半截值后追加），再用 `insertText` 完成同样提交语义的录入，并在证据里标注 `fallbackReason`。
- 数量允许页面在失焦时规范化回写，判定以规范值（`003` → `3`）比较；总量必须等于本轮容器系数 × 规范数量。
- 只有以下条件同时成立才点击保存：地点组合文本已提交且不在组合中、各字段回读与输入语义一致、`calculatedGeneration === inputGeneration`、总量属于本轮（总量变化的时刻不早于本轮数量输入）、页面校验通过。
- 页面/服务端校验拒绝时保留原始输入与可理解原因（`reason` 来自页面文案或响应 `error`），`record` 保留本次录入原值，服务端改写后的值放在 `serverRecord`，不重试保存、不循环覆盖已选容器。
- 草稿 `stateDir/draft.json` 记录每轮实际读到的字段值、动作、计算代次以及保存尝试。相同输入已有明确结论时直接复用 `result.json`（`evidence.reusedStoredResult`）；上次保存已发起但未确认时，只读查询 `/portal/state` 对照服务端记录，一致则收尾、不一致则按页面现状重新录入，不会重复触发有副作用的保存。
- 成功结果的 `evidence.comparison` 逐项对照期望值、页面回读、保存请求体与服务端记录（地点、容器、规范数量、联动总量、组合状态、计算代次）。

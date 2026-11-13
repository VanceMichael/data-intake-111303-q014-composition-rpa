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

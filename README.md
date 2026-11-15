# 输入法提交与联动计算表单的录入自动化

这是 composition-rpa 的 Node.js 项目。包含本地资料源启动、来源检查、门户页与资料接收工作流（`src/workflow.mjs`）。工作流通过真实浏览器录入组合文本、联动容器与数量，并按页面回读与服务端记录逐项核对后才保存。

## 环境

使用 Node.js 22，最低 22.20.0；Docker 基础镜像按摘要固定，依赖已在 package-lock.json 固定。浏览器使用 Playwright 1.56.1 与 Chromium，镜像中包含匹配的浏览器。不需要真实账户、新闻站点连接或生产数据。

开发环境首次安装执行 `npm ci --ignore-scripts --no-audit --no-fund`。构建镜像执行 `docker build -t composition-rpa:local .`，依赖准备只在这一步进行；正式运行不下载包、浏览器或数据。

## 常用操作

```sh
npm test
npm run build
npm run inspect
npm run source
npm start -- --host 127.0.0.1 --port 3000
```

`npm test` 检查已有资料源与真实浏览器页面。`npm run build` 做全部 JavaScript 源码语法检查，不生成运行时依赖。`npm run source` 启动回环服务并打印地址，`SOURCE_CASE=1 npm run source` 可切换异常场景。

`npm start` 启动带业务接口的门户服务，首页与 `/portal` 均可操作。可用 `HOST`、`PORT` 配置监听地址，也可通过 `--host`、`--port` 覆盖；默认使用回环地址和自动分配端口。页面与 `/portal/state`、`/portal/action` 必须由同一进程提供，不能只用静态文件服务器托管 web 目录。

## 工作流接入

业务入口约定为 `src/workflow.mjs` 导出的异步 `run({ source, stateDir, input })`。source 是本地资料源地址，input 是业务输入，stateDir 是跨次执行保留的状态目录。调用结束返回结构化业务结果，并将相同结果持久化至 stateDir/result.json，其他持久状态布局由业务模块决定。不能依赖调用方持有的内存来完成恢复。

input.location/container/quantity 是原始录入。页面 quantity 失焦后规范化并发起异步计算；data-calculated-generation 必须等于当前 data-input-generation 后才能保存。地点有组合输入状态，可通过真实组合事件或能证明同样提交语义的用户输入完成。输出 state、record；拒绝时提供 reason。

完整来源约定、输出示例与状态判定见 `docs/source-contract.md`。fixtures 下的资料只用于本地演练，代表不同供方响应或门户状态，不是资料接收器的实现。

## 业务核对与短演示

```sh
npm run acceptance
npm run demo
```

acceptance 检查结果、落盘内容和实际来源访问，覆盖组合提交、旧计算晚到、非法数量、地点联动更换容器、服务端回退与刷新续录；demo 从干净临时状态启动本地服务，实际执行前三种情况并完整输出结果及请求，不回放记录。每种情形应在 15 秒内完成，整次演示在 75 秒超时后报失败退出，预留在 90 秒内展示的余量。

容器内执行基线检查：`docker run --rm --network none composition-rpa:local npm test`。工作流开发完成后执行 `docker run --rm --network none composition-rpa:local npm run demo`。容器内回环端口可用；正式核对过程不连接外部网络。

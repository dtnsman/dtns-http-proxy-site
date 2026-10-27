# DTNS HTTP Proxy · 项目介绍站

这是 `/data/dtns.http-proxy` 的项目介绍网站，由项目自身的隧道发布。

访问地址：<http://dtns-proxy.html.dtns.top/>

> 当前实例的公网入口只配置了 HTTP；生产环境应在 nginx 侧为隧道域名配置证书并强制 HTTPS。

## 特点

- 纯静态页面，无 CDN、无外部字体、无第三方脚本
- 零依赖 Node 服务（只用 `http` / `fs` / `path` / `zlib`）
- 响应式布局，支持 `prefers-reduced-motion`
- 内容覆盖：概览、架构、核心能力、DTNS 协议、快速上手、配置参考、当前隧道、FAQ
- `/api/tunnels` 从 `client/config.js` 读取隧道数量（不返回域名、内网地址与用途）
- `/api/status`、`/healthz` 供探活与页脚状态使用
- `test-agent.html`：浏览器内 DTNS 客户端，把页面能力封装为 HTTP API（Bearer Token）
- `agent.html`：同一套能力的 URL-only 版本，不校验 Token
- `sdk.html` + `assets/sdk.js`：把 DTNS 隧道封装成 HTTP + WebSocket 的 Express 风格代理 SDK

## 目录

```
website/
├── index.html          # 首页
├── 404.html            # 404 页面
├── server.js           # 零依赖静态服务 + 只读 API
├── start.sh            # 启动脚本
├── package.json
├── test-agent.html     # Agent API 测试页（index.html 的副本 + 控制台，Bearer Token）
├── agent.html          # URL-only 版本（不校验 Token，随机 URL 即凭证）
├── sdk.html            # SDK 指南 + Live Demo（agent.html 的副本）
└── assets/
    ├── style.css
    ├── agent.css
    ├── sdk.css
    ├── sdk.js            # 零依赖 Express 风格隧道代理 SDK（内置 DTNS 协议）
    ├── sdk-guide.js      # sdk.html 的 Live Demo
    ├── app.js
    ├── agent.js          # 浏览器隧道 + 页面 HTTP API
    ├── dtns-protocol.js  # client/protocol.js 的浏览器移植
    ├── early.js
    └── favicon.svg
```

## Agent API 测试页

`http://dtns-proxy.html.dtns.top/test-agent.html`

这是 `index.html` 的复制版本，额外加了一个 Agent 控制台。页面会：

1. 在浏览器里运行 `assets/dtns-protocol.js`（`client/protocol.js` 的浏览器移植）；
2. 连接 `wss://res2.dtns.top/tunnel`，以浏览器身份注册一条随机 `agent-xxxx.html.dtns.top` 隧道；
3. 接收隧道转来的 `http_request`，在本页执行只读/交互操作，再以 `http_response` 返回。

所以，只要标签页保持打开，AI Agent 就可以用普通 HTTP 调用页面：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/agent/status` | 连接状态、协议版本、端点列表（公开） |
| GET | `/agent/openapi.json` | OpenAPI 3 描述（公开） |
| GET | `/agent/help` | 端点与 curl 示例（公开） |
| GET | `/agent/page` | 标题、章节、滚动位置、站点统计 |
| GET | `/agent/sections` | 章节大纲 |
| GET | `/agent/text?selector=main` | 读取元素文本（Token 自动脱敏） |
| POST | `/agent/scroll` | 滚动到章节或坐标 |
| POST | `/agent/highlight` | 高亮元素 |
| POST | `/agent/click` | 点击 button / summary / tab |
| GET | `/agent/ping` | 回显请求（敏感头已过滤） |
| GET | `/agent/site` | 站点 `/api/status` |
| GET | `/agent/log` | 最近请求日志 |
| POST | `/agent/log/clear` | 清空日志 |
| POST | `/agent/reconnect` | 重连隧道 |

鉴权使用 Bearer Token：

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://agent-xxxx.html.dtns.top/agent/page"
```

- Token 每个标签页随机生成，只显示在页面上；`status` / `openapi.json` / `help` 为公开端点。
- 默认域名随机，避免和其他标签页或服务冲突；页面里可以改成固定域名（仅限 `*.html.dtns.top`）。
- 关闭标签页后隧道立即离线，API 不可用；重新打开会得到新的随机域名（同一标签页刷新会保留 sessionStorage 中的域名）。
- 页面不执行任意 `eval`，点击仅允许 button / summary / tab / `[data-agent-click]`，链接会被拒绝。
- `text` / `ping` / `page` / `log` 输出会脱敏 Token；API 不返回 Token。

### SDK：sdk.js / sdk.html

`http://dtns-proxy.html.dtns.top/sdk.html`

`sdk.html` 是 `agent.html` 的复制版本，在 Agent 控制台之后加了 SDK 指南与 Live Demo。上方 Agent 控制台仍是原页面隧道；下方 Demo 用 `sdk.js` 新建第二条隧道，实时演示 `app.get` / `app.post` 以及 `app.ws` 双工消息。

[`assets/sdk.js`](/data/dtns.http-proxy/website/assets/sdk.js) 是零依赖代理 SDK，内置 DTNS 二进制编解码。浏览器用全局 `DTNSAgent`，Node.js 用 `require`。它负责：

- 连接 `wss://res2.dtns.top/tunnel`、注册域名、心跳、断线重连；
- 解码 `http_request`、匹配 Express 风格路由、编码 `http_response`；
- 解析 query / JSON / form / text body，处理 HEAD / OPTIONS / 404 / 405 / 401；
- 处理 WebSocket 升级、`websocket_data` / `websocket_close` 帧，提供 `app.ws` 双工路由；
- URL-only 或 Bearer Token。

浏览器：

```html
<script src="/assets/sdk.js"></script>
<script>
  (async () => {
    const app = DTNSAgent.app({
      domain: 'agent-xxxx.html.dtns.top'
    });

    app.get('/hello', (req, res) => {
      res.json({ ok: true, query: req.query });
    });

    app.post('/echo', (req, res) => {
      res.status(201).json({ body: req.body });
    });

    await app.listen();
  })();
</script>
```

Node.js：

```js
const DTNSAgent = require('./sdk.js');
const WebSocket = require('ws');

(async () => {
  const app = DTNSAgent.app({
    domain: 'agent-xxxx.html.dtns.top',
    WebSocket
  });

  app.get('/hello', (req, res) => res.json({ ok: true }));
  await app.listen();
})();
```

WebSocket（同一个 app）：

```js
app.ws('/live/:room', (ws, req) => {
  ws.send('welcome ' + req.params.room);

  ws.on('message', (data, isBinary) => {
    // data: string（文本）/ Uint8Array（二进制）
    ws.send(data, isBinary);
  });

  ws.on('close', (code, reason) => {
    console.log('closed', code, reason);
  });
});
```

浏览器端：

```js
const socket = new WebSocket('ws://agent-xxxx.html.dtns.top/live/room1');
socket.onopen = () => socket.send('hello');
socket.onmessage = (event) => console.log(event.data);
```

当前入口只配置了 HTTP，所以公网 WebSocket 使用 `ws://`；启用 TLS 后改为 `wss://`。

Token 模式只需多传 `token`：

```js
const app = DTNSAgent.app({
  domain: 'agent-xxxx.html.dtns.top',
  token: '<bearer token>',
  WebSocket
});
```

SDK 会校验 `Authorization: Bearer ...`；不传 token 即 URL-only。OPTIONS 预检不需要 token。浏览器 WebSocket 不能自定义 Authorization 头，Token 模式请用 `ws://.../live?token=<bearer token>`。

主要 API：

| 方法 | 说明 |
| --- | --- |
| `DTNSAgent.app(options)` | 创建隧道应用 |
| `app.get/post/put/patch/delete/head/options/all(path, handler)` | 绑定 HTTP 路由 |
| `app.ws(path, handler)` | 绑定 WebSocket 路由 |
| `app.use([path], middleware)` | `(req, res, next)` 中间件 |
| `app.listen() / app.close()` | 连接注册 / 断开 |
| `app.status() / app.on(event, fn)` | 状态 / 事件 |
| `app.routes / app.apiBase` | 路由表 / 公网 URL |
| `req.method/path/query/params/headers/body` | 请求元信息 |
| `req.get(name)` | 读取请求头 |
| `res.status(code) / res.set(name, value)` | 状态码 / 响应头 |
| `res.json(obj) / res.send(value)` | JSON / 自动类型响应 |
| `res.text(str) / res.end(body)` | 文本 / 结束响应 |
| `res.redirect(url, status)` | 重定向 |
| `ws.send(data[, binary])` / `sendText` / `sendBinary` | 发送文本 / 二进制 |
| `ws.on('message', (data, isBinary) => ...)` | 接收双工消息 |
| `ws.on('close', (code, reason) => ...)` | 连接关闭 |
| `ws.close(code, reason)` | 主动关闭 |

Handler 支持 async/await；返回对象会自动 JSON；抛错自动 500。中间件使用 `(req, res, next)`，路由支持 `:param` 路径参数。

WebSocket 关闭码在隧道协议中占 1 字节；SDK 会将正常关闭 `1000` 映射为 `0` 后由服务端还原为 `1000`，建议使用 `ws.close(1000, reason)`，非 `1000` 的自定义关闭码可能被归一化。

`sdk.html` 的 Demo 会注册一条独立的 `sdk-demo-*.html.dtns.top` 隧道，按钮直接请求 `/hello`、`/users/:id`、`/echo`、`/auto`、`/page`、`/highlight`、`/status`，并显示 Demo 请求日志；下方 WebSocket 面板连接 `app.ws('/live')`，发送消息即可看到双工回显。`/page` 和 `/highlight` 展示了 SDK 在浏览器里直接操作页面 DOM 的能力。

### URL-only 版本：agent.html

`http://dtns-proxy.html.dtns.top/agent.html`

与 `test-agent.html` 共用 [agent.js](/data/dtns.http-proxy/website/assets/agent.js)，但页面 `body` 带 `data-agent-auth="none"`，运行时会：

- 不生成、不显示、不校验 Token；
- API 的 `auth.required` 为 `false`，`/agent/openapi.json` 不含 `security` / `components`；
- 默认域名使用 96 bit 随机值（`agent-` + 24 位 hex），URL 本身就是凭证；
- 页面不显示 Token 行，curl 示例与「复制给 Agent」只包含 API Base 和 OpenAPI 地址。

安全边界：拿到 URL 的人就能调用 API。只把链接发给可信的 Agent，不要发到公开渠道；自定义固定域名会降低不可猜测性，建议保留随机域名。关闭标签页后 API 立即离线，且当前入口为 HTTP，生产环境请先启用 TLS 再使用。

浏览器侧的 `fetch` 跨域依赖入口 nginx 的 CORS（当前会反射 Origin 并允许 `Authorization` / `Content-Type`）。`server.js` 的 CSP 已允许：

- `wss://res2.dtns.top`（隧道长连接）
- `ws://*.html.dtns.top` / `wss://*.html.dtns.top`（WebSocket 调用页面 / SDK API）
- `http://*.html.dtns.top` / `https://*.html.dtns.top`（测试调用页面 API）

如果更换隧道服务端域名，需要同步修改 `assets/agent.js` 的 `WS_BASE`、`server.js` 的 CSP 以及 `client/config.js`。

## 本地运行

```bash
cd website
node server.js
# http://127.0.0.1:3016/
```

可用环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3016` | 监听端口 |
| `HOST` | `127.0.0.1` | 监听地址，默认只绑定回环 |
| `DTNS_CONFIG` | `../client/config.js` | 隧道配置路径 |

## 发布方式

`client/config.js` 中的隧道：

```js
{
  id: 'site',
  domain: 'dtns-proxy.html.dtns.top',
  local: { host: '127.0.0.1', port: 3016, protocol: 'http' },
  enabled: true,
  description: '项目介绍网站'
}
```

修改 `config.js` 前先备份：

```bash
cp client/config.js client/config.js.bak-$(date +%Y%m%d-%H%M%S)
```

然后重启隧道客户端，让新的隧道完成注册：

```bash
# 若由 forever 托管，重启对应任务；或直接重启 node client/index.js
```

## 安全

- 服务只读，仅绑定 `127.0.0.1`，不直接暴露到公网
- `/api/tunnels` 只返回数量，不公开域名与端口
- Agent API 的 Token 不写入日志、不返回给调用方；`text` 输出会脱敏
- `agent.html` 没有 Token，URL 即凭证；请勿公开链接
- `sdk.js` 不存储凭证；Token 只在调用方传入时用于 `Authorization` 头
- 两个页面都不执行任意代码，点击目标有白名单
- 响应带 CSP、`X-Content-Type-Options`、`Referrer-Policy` 等头
- 站点目录内不要放置密钥、备份或未脱敏配置

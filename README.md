# DTNS HTTP Proxy

> 一个域名，直达内网服务。把「本地能跑」变成「公网可用」——不需要公网 IP，不需要装客户端，甚至不需要一台常驻服务器。

许可证：**GPL-3.0** · 运行环境：**Node.js ≥ 18** · 线上示例：<http://dtns-proxy.html.dtns.top/>

---

## 目录

- [解决什么问题](#解决什么问题)
- [与同类方案对比](#与同类方案对比)
- [典型使用场景](#典型使用场景)
- [快速开始](#快速开始)
- [架构](#架构)
- [浏览器端 Agent API](#浏览器端-agent-api)
- [代理 SDK](#代理-sdk)
- [本地运行](#本地运行)
- [配置参考](#配置参考)
- [安全边界](#安全边界)
- [开源协议](#开源协议)

---

## 解决什么问题

内网穿透这个品类已经很成熟，但真实工作里的卡点往往不在「有没有工具」，而在**这个工具在你的环境里跑不跑得起来**。

### 困境一：没有公网 IP，端口映射也做不了

家宽、校园网、公司办公网几乎都在 NAT 后面。路由器不在你手上，即使拿到了动态公网 IP，运营商也可能封了 80/443。想给同事看一眼刚做好的页面，或者让外部回调打到本机，第一步就卡住。

### 困境二：装不了客户端

这是最常见、也最少被讨论的痛点。公司电脑没有管理员权限，`ngrok`、`cloudflared`、`frpc` 这类二进制装不上；即使能装，安全策略也常常禁止未经审批的常驻进程。**但浏览器一定是有的。**

### 困境三：想让 AI Agent 操作"我正开着的那个页面"

给 Agent 开放浏览器这事，卡在两难：

- 直接给 Agent 一个真实浏览器 → 它拿着你的登录态，风险不可控；
- 用无头浏览器（Playwright / Browserbase）→ 得复刻登录态、过验证码、同步 Cookie，而且它操作的**永远是一份副本**，不是你屏幕上那个有状态的页面。

你真正想要的，往往是"让 Agent 读一下这个页面、点一下这个按钮"，而不是"再起一个浏览器"。

### 困境四：实时能力被阉割

很多穿透方案把 HTTP 转发做得很顺，一到 WebSocket 就开始断流、要额外配置、或者干脆不支持。SSE 流式响应同理。做实时看板、协同编辑、AI 流式输出时，这个短板很致命。

### 困境五：不想把整个内网暴露出去

只想让外部访问**一个页面**或**一个 API**，而不是把整台机器、整个网段挂到公网上。最小暴露面本身就是安全需求。

**DTNS HTTP Proxy 的答案**：把隧道客户端做成**一个浏览器标签页**，让页面本身成为可被 HTTP 调用、可被 AI Agent 驱动的公网端点；同时用一条自定义二进制协议，把 WebSocket 双工、SSE 流式响应和背压一起透传过去。

---

## 与同类方案对比

### 横向对比

| 方案 | 运行形态 | 需要公网 IP / 自备服务器 | 需要安装客户端 | 浏览器标签页即可起服务 | WebSocket / SSE | 主要门槛 |
| --- | --- | --- | --- | --- | --- | --- |
| **DTNS HTTP Proxy**（本项目） | 隧道 + 浏览器/Node 双端客户端 | 否（隧道服务端已提供） | 浏览器端：**否**<br>Node 端：是 | ✅ | ✅ 双工 + SSE + 背压 | 需要一条已注册的隧道域名 |
| [ngrok](https://ngrok.com/) | 商业 SaaS 隧道 | 否 | 是（ngrok agent） | ❌ | ✅ | 免费版为随机临时域名、HTML 响应带浏览器提示页，固定域名属付费能力 |
| [Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/) | 商业 SaaS 隧道 | 否 | 是（cloudflared） | ❌ | ✅ | 域名 DNS 必须托管在 Cloudflare，连接器与路由需自行配置 |
| [frp](https://github.com/fatedier/frp) | 开源自建 | **是**（自己的 VPS） | 是（frpc） | ❌ | ✅（需额外配置） | 需自购 VPS、维护 frps、处理域名与证书 |
| [localtunnel](https://github.com/localtunnel/localtunnel) | 免费公共中继 | 否 | 是（`npx`，近乎零安装） | ❌ | ⚠️ 支持有限 | 访客需在同意页输入隧道密码；公共中继稳定性与限速不可控 |
| [Tailscale Funnel](https://tailscale.com/kb/1223/funnel) | 组网 + 公网出口 | 否 | 是（Tailscale 客户端） | ❌ | ✅ | 仅开放 443 / 8443 / 10000 端口，需登录 Tailscale 账号，域名固定为 `*.ts.net` |
| [Playwright](https://playwright.dev/) / [Browserbase](https://www.browserbase.com/) 等浏览器自动化 | 无头浏览器（本地或云） | 通常需要 | 是（SDK + 浏览器运行时） | ❌ | ⚠️ 走 CDP 调试协议 | 需复刻登录态、应对验证码，操作的是浏览器副本而非用户的真实会话 |

> 表中竞品特性基于其公开文档与常见部署形态整理，具体额度与限制以各项目官方当前政策为准。

### 我们的四个竞争点

#### 1. 零安装：浏览器就是隧道客户端

这是最硬的一条差异。上面几乎所有方案都要求你在目标机器上装一个二进制或常驻进程；本项目把隧道客户端做成了 `assets/agent.js`——**打开一个页面，隧道就通了**。

对于受限终端（无管理员权限、禁止安装软件、只能用浏览器）的场景，这不是"更方便"，而是"唯一可行"。

#### 2. 页面即 API：操作真实会话，而不是复刻一份

`test-agent.html` / `agent.html` 把当前页面的能力包装成标准 HTTP API，并自动生成 OpenAPI 3 描述：

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://agent-xxxx.html.dtns.top/agent/page"
```

Agent 拿到的是**你屏幕上这个页面的真实 DOM 与真实登录态**，不需要 Cookie 导出、不需要重放登录流程、不需要对抗风控。读取标题与章节、滚动、高亮、点击按钮——都在原页面里发生。

对比无头浏览器方案，这省掉的是整条"复刻环境"的成本；对比直接开放浏览器，它把能力收敛到一组**白名单端点**（只允许 button / summary / tab / `[data-agent-click]`，链接一律拒绝），暴露面小得多。

#### 3. 协议级完整透传：不只是 HTTP

DTNS 是一套二进制帧协议，请求与响应**原样搬运**，因此同一条 WSS 长连接上可以同时承载：

- **WebSocket 全双工**：升级请求、双向帧、关闭码都走隧道，SDK 提供 `app.ws()` 路由；
- **SSE 与流式响应**：分块响应不被缓冲截断；
- **双向背压**：下游慢的时候上游会被压住，而不是无限堆内存；
- **Host 即路由**：一个服务端按 `Host` 分发到不同隧道，无需为每个服务开端口。

#### 4. 可自托管，不锁定

协议实现、浏览器客户端、代理 SDK、站点源码都在这个仓库里，GPL-3.0 授权。你不需要把流量交给一个只能订阅的 SaaS：可以自己部署隧道服务端，把域名、证书、访问策略握在自己手里。

SDK 是**零依赖**的——`assets/sdk.js` 内置了协议编解码，浏览器用全局 `DTNSAgent`，Node.js 直接 `require`，不拉任何 npm 包。

### 不适合的场景

诚实地讲，以下场景请选别的方案：

| 你的需求 | 更合适的选择 | 原因 |
| --- | --- | --- |
| 生产级 SLA、固定域名、团队协作与审计 | Cloudflare Tunnel / 商业版 ngrok | 本项目定位是轻量、可控、可自托管，不承诺商业 SLA |
| 转发 SSH、数据库、任意 TCP/UDP | frp / Tailscale | 本项目专注 HTTP 系协议（含 WebSocket / SSE），不是通用四层隧道 |
| 大规模网页抓取、无人值守的浏览器集群 | Playwright + 代理池 / Browserbase | 页面隧道依赖标签页存活，不适合做批量采集基础设施 |
| 7×24 常驻服务 | 用 Node 客户端而非浏览器标签页 | 浏览器标签页关闭即离线，这是设计上的取舍 |

---

## 典型使用场景

| 场景 | 怎么做 |
| --- | --- |
| **给同事/客户演示本地页面** | 起本地服务 → 配一条隧道 → 发域名，对方直接打开，无需你装任何东西 |
| **接收第三方 Webhook 回调** | 把回调地址指向隧道域名，请求直接落到 `127.0.0.1` 的服务 |
| **给 AI Agent 一个可调用的界面** | 打开 `agent.html`，把 API Base + OpenAPI 地址交给 Agent，它用普通 HTTP 就能读页面、点按钮 |
| **远程联调 WebSocket 服务** | 隧道透传升级与双工帧，公网 `ws://` 直连本地实现 |
| **演示环境临时暴露单个 API** | 只暴露目标端口，内网其余部分不可见 |
| **在受限终端上做临时出口** | 无管理员权限时，浏览器标签页就是客户端 |

---

## 快速开始

### 方式一：浏览器标签页（零安装）

1. 打开 <http://dtns-proxy.html.dtns.top/agent.html>；
2. 页面自动注册一条随机隧道（形如 `agent-xxxxxxxx.html.dtns.top`），域名即凭证；
3. 把页面显示的 API Base 与 `/agent/openapi.json` 地址交给调用方；

```bash
curl -s "http://agent-xxxxxxxx.html.dtns.top/agent/page"
```

> URL-only 模式下，拿到链接的人即可调用。只发给可信对象，不要公开。需要 Token 校验请用 `test-agent.html`。

### 方式二：Node 客户端（常驻）

```bash
git clone https://github.com/dtnsman/dtns-http-proxy-site.git
cd dtns-http-proxy-site
node server.js          # 本地预览站点，默认 127.0.0.1:3016
```

在 `client/config.js` 中登记隧道：

```js
{
  id: 'site',
  domain: 'dtns-proxy.html.dtns.top',
  local: { host: '127.0.0.1', port: 3016, protocol: 'http' },
  enabled: true,
  description: '项目介绍网站'
}
```

重启隧道客户端使配置生效，浏览器访问域名，看到 200 即打通。

### 方式三：用 SDK 在自己的页面里起服务

```html
<script src="/assets/sdk.js"></script>
<script>
  const app = DTNSAgent.app({ domain: 'agent-xxxx.html.dtns.top' });

  app.get('/hello', (req, res) => res.json({ ok: true, query: req.query }));
  app.post('/echo', (req, res) => res.status(201).json({ body: req.body }));

  app.listen();
</script>
```

---

## 架构

```
浏览器 ──► 接入层(nginx, 终止 TLS) ──► 代理(:18386) ──► 隧道服务端
                                                        │  WSS 长连接
                                                        ▼
                                            隧道客户端(浏览器标签页 / Node)
                                                        │
                                                        ▼
                                                  本地服务 :3016
```

一次请求的完整链路：

1. **接入**：接入层终止 TLS，把 HTTP 请求交给 `:18386` 代理；
2. **查表**：代理读取 `Host`，在已注册隧道中定位 `clientId` 与目标隧道；
3. **编码**：请求被编码为 DTNS 二进制帧，经 WSS 长连接送达内网；
4. **转发**：客户端按 `config.js` 转发到本地端口，响应沿原路返回；
5. **透传**：WebSocket 升级、双向帧与 SSE 事件流都走同一条通道。

### 核心能力

| 能力 | 说明 |
| --- | --- |
| Host 即路由 | 一个服务端按域名分发到多条隧道，互不干扰 |
| WebSocket 全双工 | 升级与双向帧原生支持，关闭码在协议内保留 |
| SSE 与流式响应 | 分块响应不缓冲、不截断 |
| DTNS 二进制协议 | 紧凑帧格式，请求响应原样搬运 |
| 双向背压 | 下游拥塞时反向压制上游，避免内存堆积 |
| 自愈连接 | 心跳 + 线性退避重连（上限 60 秒），健康检查发现隧道丢失会主动重注册 |

### 本仓库的范围

本仓库包含**项目介绍站**、**浏览器端隧道客户端**（`assets/agent.js`）、**代理 SDK**（`assets/sdk.js`）与**协议浏览器移植**（`assets/dtns-protocol.js`）。隧道服务端（`res2.dtns.top`）为独立部署，不在本仓库内。

```
dtns-http-proxy-site/
├── index.html          # 首页（概览 / 架构 / 能力 / 协议 / 上手 / FAQ）
├── 404.html            # 404 页面
├── server.js           # 零依赖静态服务 + 只读 API
├── start.sh            # 启动脚本
├── package.json
├── test-agent.html     # Agent API 测试页（index.html 的副本 + 控制台，Bearer Token）
├── agent.html          # URL-only 版本（不校验 Token，随机 URL 即凭证）
├── sdk.html            # SDK 指南 + Live Demo
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

站点的只读 API：`/healthz`（探活）、`/api/status`（运行状态）、`/api/tunnels`（隧道数量，不含域名与端口）。

---

## 浏览器端 Agent API

`test-agent.html` 是 `index.html` 的副本，额外挂了一个 Agent 控制台。页面会：

1. 在浏览器里运行 `assets/dtns-protocol.js`（`client/protocol.js` 的浏览器移植）；
2. 连接 `wss://res2.dtns.top/tunnel`，以浏览器身份注册一条随机 `agent-xxxx.html.dtns.top` 隧道；
3. 接收隧道转来的 `http_request`，在本页执行只读/交互操作，再以 `http_response` 返回。

只要标签页保持打开，AI Agent 就能用普通 HTTP 调用页面：

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

- Token 每个标签页随机生成，只显示在页面上；`status` / `openapi.json` / `help` 为公开端点；
- 默认域名随机，避免和其他标签页或服务冲突；页面里可以改成固定域名（仅限 `*.html.dtns.top`）；
- 关闭标签页后隧道立即离线，API 不可用；重新打开会得到新的随机域名（同一标签页刷新会保留 sessionStorage 中的域名）；
- 页面不执行任意 `eval`，点击仅允许 button / summary / tab / `[data-agent-click]`，链接会被拒绝；
- `text` / `ping` / `page` / `log` 输出会脱敏 Token；API 不返回 Token。

### URL-only 版本：agent.html

`http://dtns-proxy.html.dtns.top/agent.html`

与 `test-agent.html` 共用 `assets/agent.js`，但页面 `body` 带 `data-agent-auth="none"`，运行时会：

- 不生成、不显示、不校验 Token；
- API 的 `auth.required` 为 `false`，`/agent/openapi.json` 不含 `security` / `components`；
- 默认域名使用 96 bit 随机值（`agent-` + 24 位 hex），URL 本身就是凭证；
- 页面不显示 Token 行，curl 示例与「复制给 Agent」只包含 API Base 和 OpenAPI 地址。

**安全边界**：拿到 URL 的人就能调用 API。只把链接发给可信的 Agent，不要发到公开渠道；自定义固定域名会降低不可猜测性，建议保留随机域名。关闭标签页后 API 立即离线。

---

## 代理 SDK

`http://dtns-proxy.html.dtns.top/sdk.html`

`assets/sdk.js` 是零依赖代理 SDK，内置 DTNS 二进制编解码。浏览器用全局 `DTNSAgent`，Node.js 用 `require`。它负责：

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

---

## 本地运行

```bash
node server.js
# http://127.0.0.1:3016/
```

可用环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3016` | 监听端口 |
| `HOST` | `127.0.0.1` | 监听地址，默认只绑定回环 |
| `DTNS_CONFIG` | `../client/config.js` | 隧道配置路径 |

零依赖：只用 `http` / `fs` / `path` / `zlib`，无需 `npm install`。

---

## 配置参考

### 客户端 `client/config.js`

```js
{
  id: 'site',
  domain: 'dtns-proxy.html.dtns.top',
  local: { host: '127.0.0.1', port: 3016, protocol: 'http' },
  enabled: true,
  description: '项目介绍网站'
}
```

修改前先备份：

```bash
cp client/config.js client/config.js.bak-$(date +%Y%m%d-%H%M%S)
```

然后重启隧道客户端，让新的隧道完成注册。

### 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 域名返回 `No tunnel registered for domain` | 请求已到服务端，但 Host 未匹配到已注册隧道。检查域名拼写、客户端是否在线、客户端日志是否显示「隧道注册成功」 |
| 4xx / 5xx 状态码显示不正常 | v1 协议单字节状态码限制（`401 & 0xff = 145`）。使用 v2 协议即可无损；客户端连接旧服务端时会自动把超范围响应切到 JSON 包 |
| WebSocket 连上就断 | 先确认本地服务本身能升级，再检查路径、子协议与 `Origin`。若本地框架校验 Host / Origin，可在隧道上开启 `rewriteHost` / `rewriteOrigin` |
| 上传大文件被 413 | 服务端默认请求体上限 32 MB。可在 `limits.maxBodySize` 调整全局值，或用 `maxBodySizeByDomain` 为特定域名放宽 |
| 断线要手动重连吗 | 不需要。客户端内置心跳与线性退避重连（上限 60 秒）；健康检查发现隧道未注册时会主动重连并全量重新注册 |
| 能给隧道加访问控制吗 | 建议在入口层（nginx basic auth、IP 白名单、OIDC 等）做。隧道配置里的 auth 是访问上游时附加的 Basic Auth，不是公网鉴权 |

---

## 安全边界

- 服务只读，仅绑定 `127.0.0.1`，不直接暴露到公网；
- `/api/tunnels` 只返回数量，不公开域名与端口；
- Agent API 的 Token 不写入日志、不返回给调用方；`text` 输出会脱敏；
- `agent.html` 没有 Token，URL 即凭证；请勿公开链接；
- `sdk.js` 不存储凭证；Token 只在调用方传入时用于 `Authorization` 头；
- 页面不执行任意代码，点击目标有白名单；
- 响应带 CSP、`X-Content-Type-Options`、`Frame-Options`、`Referrer-Policy` 等头；
- 站点目录内不要放置密钥、备份或未脱敏配置。

> 当前实例的公网入口只配置了 HTTP；生产环境应在 nginx 侧为隧道域名配置证书并强制 HTTPS。

---

## 开源协议

本项目基于 [GNU General Public License v3.0](LICENSE) 发布。

你可以自由使用、修改、分发，包括商业用途，但衍生作品须以同等许可开源，并保留版权声明。完整条款见 [LICENSE](LICENSE)。

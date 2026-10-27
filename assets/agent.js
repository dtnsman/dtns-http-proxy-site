/**
 * test-agent.html — browser-side DTNS tunnel + page API
 *
 * The page connects to wss://res2.dtns.top/tunnel as a tunnel client, registers
 * a *.html.dtns.top domain, and answers incoming HTTP requests with page
 * functions (read text, scroll, highlight, click, ...). An AI agent can then use
 * plain HTTP against that domain while this tab is open.
 */
(function () {
  'use strict';

  var P = window.DTNSProtocol;
  var app = document.getElementById('agentApp');
  if (!app) return;

  var WS_BASE = 'wss://res2.dtns.top/tunnel';
  var DOMAIN_SUFFIX = '.html.dtns.top';
  var DEFAULT_PREFIX = 'agent';
  var AUTH_REQUIRED = !(document.body && document.body.dataset && document.body.dataset.agentAuth === 'none');
  var TOKEN_KEY = AUTH_REQUIRED ? 'dtns.agent.token' : 'dtns.agent.open.token';
  var DOMAIN_KEY = AUTH_REQUIRED ? 'dtns.agent.domain' : 'dtns.agent.open.domain';
  var AUTO_KEY = AUTH_REQUIRED ? 'dtns.agent.auto' : 'dtns.agent.open.auto';
  var MAX_BODY = 1024 * 1024;
  var MAX_TEXT = 20000;
  var MAX_LOG = 50;
  var MAX_FRAMES = 40;
  var PUBLIC_PATHS = { '/': true, '/agent': true, '/agent/help': true, '/agent/status': true, '/agent/openapi.json': true };

  var ENDPOINTS = [
    { method: 'GET', path: '/agent/status', desc: '连接状态、协议版本、端点列表', auth: false },
    { method: 'GET', path: '/agent/openapi.json', desc: 'OpenAPI 3 描述，供 Agent 自动发现', auth: false },
    { method: 'GET', path: '/agent/page', desc: '页面标题、章节、滚动位置与站点统计', auth: true },
    { method: 'GET', path: '/agent/sections', desc: '章节 id / 标题 / 位置', auth: true },
    { method: 'GET', path: '/agent/text?selector=main&limit=4000', desc: '读取元素文本（自动脱敏 Token）', auth: true },
    { method: 'POST', path: '/agent/scroll', desc: '滚动到章节或坐标', auth: true, body: { selector: '#agent' } },
    { method: 'POST', path: '/agent/highlight', desc: '高亮页面元素', auth: true, body: { selector: '#agent h2', durationMs: 1800 } },
    { method: 'POST', path: '/agent/click', desc: '点击 button / summary / tab', auth: true, body: { selector: '#tabbtn-client' } },
    { method: 'GET', path: '/agent/ping', desc: '回显方法、查询、请求头与 body', auth: true },
    { method: 'GET', path: '/agent/site', desc: '站点 /api/status（隧道数、运行时长）', auth: true },
    { method: 'GET', path: '/agent/log', desc: '最近的 API 请求日志', auth: true },
    { method: 'GET', path: '/agent/help', desc: '端点与 curl 示例（公开）', auth: false },
    { method: 'POST', path: '/agent/log/clear', desc: '清空请求日志', auth: true },
    { method: 'POST', path: '/agent/reconnect', desc: '重新连接并注册隧道', auth: true }
  ];

  var state = {
    clientId: '',
    domain: '',
    token: '',
    showToken: false,
    autoFallback: true,
    fallbackTried: false,
    ws: null,
    status: 'idle',
    statusText: '初始化中',
    detail: '正在加载协议与连接隧道…',
    registered: false,
    manualStop: false,
    serverVersion: 1,
    requests: 0,
    errors: 0,
    framesIn: 0,
    framesOut: 0,
    bytesIn: 0,
    bytesOut: 0,
    startedAt: Date.now(),
    connectedAt: 0,
    lastError: '',
    reconnectAttempts: 0,
    reconnectTimer: null,
    heartbeatTimer: null,
    log: [],
    frames: []
  };

  var siteCache = { at: 0, data: null };
  var toastTimer = null;

  // ============================================================
  // helpers
  // ============================================================

  function $(id) {
    return document.getElementById(id);
  }

  function setText(id, value) {
    var el = $(id);
    if (el) el.textContent = value == null ? '' : String(value);
  }

  function create(tag, className, text) {
    var el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined && text !== null) el.textContent = String(text);
    return el;
  }

  function storeGet(key, fallback) {
    try {
      var value = window.sessionStorage.getItem(key);
      return value === null ? fallback : value;
    } catch (error) {
      return fallback;
    }
  }

  function storeSet(key, value) {
    try { window.sessionStorage.setItem(key, value); } catch (error) { /* ignore */ }
  }

  function randomHex(bytes) {
    var data = new Uint8Array(bytes);
    if (window.crypto && window.crypto.getRandomValues) {
      window.crypto.getRandomValues(data);
    } else {
      for (var i = 0; i < data.length; i++) data[i] = Math.floor(Math.random() * 256);
    }
    return Array.prototype.map.call(data, function (byte) {
      return byte.toString(16).padStart(2, '0');
    }).join('');
  }

  function randomDomain() {
    // URL-only mode is protected by the URL alone, so use 96 bits of entropy.
    return DEFAULT_PREFIX + '-' + randomHex(AUTH_REQUIRED ? 5 : 12) + DOMAIN_SUFFIX;
  }

  function validDomain(value) {
    var domain = String(value || '').trim().toLowerCase();
    if (!domain || domain.length > 120) return '';
    if (!/^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/.test(domain)) return '';
    if (domain.slice(-DOMAIN_SUFFIX.length) !== DOMAIN_SUFFIX) return '';
    return domain;
  }

  function apiBase() {
    return 'http://' + state.domain;
  }

  function clean(text) {
    return String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  }

  function redact(text) {
    var value = String(text == null ? '' : text);
    if (state.token && state.token.length >= 8) {
      value = value.split(state.token).join('[REDACTED]');
    }
    return value;
  }

  function formatTime(ts) {
    var date = new Date(ts);
    function pad(n) { return n < 10 ? '0' + n : String(n); }
    return pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
  }

  function bytesToText(bytes) {
    try {
      return new TextDecoder('utf-8').decode(bytes || new Uint8Array(0));
    } catch (error) {
      return '';
    }
  }

  function lowerHeaders(headers) {
    var output = {};
    Object.keys(headers || {}).forEach(function (key) {
      output[String(key).toLowerCase()] = headers[key];
    });
    return output;
  }

  function headerValue(headers, name) {
    var value = headers[String(name).toLowerCase()];
    return Array.isArray(value) ? value[0] : value;
  }

  function extractToken(headers, query) {
    var auth = headerValue(headers, 'authorization');
    if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
    var custom = headerValue(headers, 'x-agent-token');
    if (custom) return String(custom).trim();
    if (query && query.token) return String(query.token);
    return '';
  }

  function normalizePath(path) {
    var value = String(path || '/');
    if (value.length > 1) value = value.replace(/\/+$/, '');
    return value || '/';
  }

  function parseRequestUrl(raw, domain) {
    try {
      return new URL(raw || '/', 'http://' + (domain || 'agent.local'));
    } catch (error) {
      return new URL('/', 'http://agent.local');
    }
  }

  function delay(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function result(status, body, headers, opts) {
    return { status: status, body: body, headers: headers || {}, opts: opts || {} };
  }

  function methodNotAllowed(allowed) {
    return result(405, {
      ok: false,
      error: 'method_not_allowed',
      allow: allowed.join(', ')
    }, { allow: allowed.join(', ') });
  }

  function metaDescription() {
    var meta = document.querySelector('meta[name="description"]');
    return meta ? meta.getAttribute('content') || '' : '';
  }

  // ============================================================
  // toast / clipboard
  // ============================================================

  function toast(message) {
    var el = $('agentToast');
    if (!el) return;
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 1800);
  }

  function legacyCopy(text) {
    var area = document.createElement('textarea');
    area.className = 'agent-copy-area';
    area.value = text;
    area.setAttribute('readonly', '');
    document.body.appendChild(area);
    area.select();
    try { document.execCommand('copy'); } catch (error) { /* ignore */ }
    document.body.removeChild(area);
  }

  function copyText(text) {
    return new Promise(function (resolve) {
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(function () { resolve(true); }, function () {
          legacyCopy(text);
          resolve(false);
        });
      } else {
        legacyCopy(text);
        resolve(false);
      }
    });
  }

  function copyAndToast(text, message) {
    copyText(text).then(function () { toast(message || '已复制'); });
  }

  // ============================================================
  // UI rendering
  // ============================================================

  var STATUS_META = {
    idle: { label: '未连接', dot: 'is-offline' },
    connecting: { label: '连接中…', dot: 'is-warn' },
    connected: { label: '已连接', dot: 'is-warn' },
    registered: { label: '在线', dot: 'is-online' },
    reconnecting: { label: '重连中…', dot: 'is-warn' },
    error: { label: '连接失败', dot: 'is-error' },
    offline: { label: '已断开', dot: 'is-offline' }
  };

  function setStatus(status, detail) {
    var meta = STATUS_META[status] || STATUS_META.idle;
    state.status = status;
    state.statusText = meta.label;
    state.detail = detail || '';
    render();
  }

  function render() {
    var meta = STATUS_META[state.status] || STATUS_META.idle;
    var dot = $('agentDot');
    if (dot) dot.className = 'agent-dot ' + meta.dot;

    setText('agentState', state.statusText);
    setText('agentStateDetail', state.detail);
    setText('agentProtocol', 'DTNS v' + state.serverVersion);
    setText('agentProtocolTag', 'DTNS v' + state.serverVersion);
    setText('agentClientId', state.clientId);
    setText('agentRequests', state.requests);
    setText('agentFrames', state.framesIn + ' 收 / ' + state.framesOut + ' 发');
    setText('agentDomain', state.domain);

    var input = $('agentDomainInput');
    if (input && document.activeElement !== input) input.value = state.domain;

    var base = state.registered ? apiBase() : '';
    var apiLink = $('agentApiBase');
    if (apiLink) {
      apiLink.textContent = state.registered ? apiBase() : '等待注册…';
      apiLink.href = state.registered ? apiBase() : '#';
      apiLink.setAttribute('aria-disabled', state.registered ? 'false' : 'true');
    }

    var openApi = $('agentOpenApi');
    if (openApi) {
      openApi.href = state.registered ? apiBase() + '/agent/openapi.json' : '#';
      openApi.setAttribute('aria-disabled', state.registered ? 'false' : 'true');
    }

    var tests = document.querySelectorAll('[data-agent-test]');
    Array.prototype.forEach.call(tests, function (button) {
      button.disabled = !state.registered;
    });

    renderToken();
    renderCurl();
  }

  function maskedToken() {
    if (!state.token) return '••••';
    if (state.token.length <= 10) return '••••••••';
    return state.token.slice(0, 4) + '••••••••' + state.token.slice(-4);
  }

  function renderToken() {
    if (!AUTH_REQUIRED) return;
    setText('agentToken', state.showToken ? state.token : maskedToken());
    var toggle = $('agentToggleToken');
    if (toggle) toggle.textContent = state.showToken ? '隐藏' : '显示';
  }

  function buildCurlText(withRealToken) {
    if (!AUTH_REQUIRED) {
      return [
        'API="' + apiBase() + '"',
        '',
        'curl -s "$API/agent/status"',
        'curl -s "$API/agent/page"',
        'curl -s -X POST -H "Content-Type: application/json" \\',
        '  -d \'{"selector":"#agent h2","durationMs":1800}\' "$API/agent/highlight"'
      ].join('\n');
    }
    var token = withRealToken ? state.token : maskedToken();
    return [
      'API="' + apiBase() + '"',
      'TOKEN="' + token + '"',
      '',
      'curl -s -H "Authorization: Bearer $TOKEN" "$API/agent/status"',
      'curl -s -H "Authorization: Bearer $TOKEN" "$API/agent/page"',
      'curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \\',
      '  -d \'{"selector":"#agent h2","durationMs":1800}\' "$API/agent/highlight"'
    ].join('\n');
  }

  function renderCurl() {
    var pre = $('agentCurl');
    if (pre) pre.textContent = state.registered ? buildCurlText(false) : '等待隧道注册…';
  }

  function buildBundle() {
    if (!AUTH_REQUIRED) {
      return [
        'DTNS Agent API · agent.html (URL-only)',
        'API (also the credential): ' + apiBase(),
        'OpenAPI: ' + apiBase() + '/agent/openapi.json',
        '',
        '把以上 URL 交给可信的 AI Agent；请勿公开链接。页面保持打开，API 才可用。'
      ].join('\n');
    }
    return [
      'DTNS Agent API · test-agent.html',
      'API: ' + apiBase(),
      'Token: ' + state.token,
      'OpenAPI: ' + apiBase() + '/agent/openapi.json',
      '',
      '把以上信息交给 AI Agent；页面保持打开，API 才可用。'
    ].join('\n');
  }

  function buildEndpointCurl(ep) {
    var base = apiBase();
    var authHeader = AUTH_REQUIRED ? '-H "Authorization: Bearer ' + state.token + '" ' : '';
    if (ep.method === 'GET') {
      return 'curl -s ' + authHeader + '"' + base + ep.path + '"';
    }
    var body = JSON.stringify(ep.body || {});
    return 'curl -s -X POST ' + authHeader +
      '-H "Content-Type: application/json" -d \'' + body + '\' "' + base + ep.path + '"';
  }

  function renderEndpoints() {
    var host = $('agentEndpoints');
    if (!host) return;
    host.textContent = '';

    ENDPOINTS.forEach(function (ep, index) {
      var row = create('div', 'agent-endpoint');
      var method = create('span', 'agent-method ' + ep.method.toLowerCase(), ep.method);

      var main = create('div', 'agent-endpoint-main');
      var code = create('code', null, ep.path);
      var authLabel = AUTH_REQUIRED ? (ep.auth ? 'token' : 'public') : 'url';
      var auth = create('span', 'agent-auth', authLabel);
      code.appendChild(auth);
      main.appendChild(code);
      main.appendChild(create('span', 'agent-endpoint-desc', ep.desc));

      var button = create('button', 'agent-mini', 'curl');
      button.type = 'button';
      button.setAttribute('data-endpoint', String(index));

      row.appendChild(method);
      row.appendChild(main);
      row.appendChild(button);
      host.appendChild(row);
    });

    host.addEventListener('click', function (event) {
      var button = event.target.closest('[data-endpoint]');
      if (!button) return;
      var ep = ENDPOINTS[Number(button.getAttribute('data-endpoint'))];
      if (!ep) return;
      copyAndToast(buildEndpointCurl(ep), '已复制 ' + ep.method + ' ' + ep.path);
    });
  }

  function renderStatsOnly() {
    setText('agentRequests', state.requests);
    setText('agentFrames', state.framesIn + ' 收 / ' + state.framesOut + ' 发');
    var stats = $('agentFrameStats');
    if (stats) stats.textContent = state.framesIn + ' 收 / ' + state.framesOut + ' 发';
  }

  function renderRequestLog() {
    var host = $('agentRequestLog');
    if (!host) return;
    host.textContent = '';

    if (!state.log.length) {
      host.appendChild(create('p', 'agent-empty', '等待请求…'));
      return;
    }

    state.log.forEach(function (entry) {
      var row = create('div', 'agent-log-row');
      row.appendChild(create('span', 'agent-log-time', formatTime(entry.at)));
      row.appendChild(create('span', 'agent-method ' + String(entry.method).toLowerCase(), entry.method));
      row.appendChild(create('span', 'agent-log-path', entry.path));

      var status = create('span', 'agent-log-status', entry.status);
      if (entry.status >= 500) status.className += ' err';
      else if (entry.status >= 400) status.className += ' warn';
      row.appendChild(status);

      row.appendChild(create('span', 'agent-log-ms', entry.ms + 'ms'));
      host.appendChild(row);
    });
  }

  function renderFrameLog() {
    var host = $('agentFrameLog');
    if (!host) return;
    host.textContent = '';

    if (!state.frames.length) {
      host.appendChild(create('p', 'agent-empty', '等待帧…'));
      return;
    }

    state.frames.forEach(function (entry) {
      var row = create('div', 'agent-log-row');
      var dir = create('span', 'agent-frame-dir' + (entry.dir === 'out' ? ' out' : ''), entry.dir === 'in' ? '↓' : '↑');
      row.appendChild(create('span', 'agent-log-time', formatTime(entry.at)));
      row.appendChild(dir);
      row.appendChild(create('span', 'agent-frame-type', entry.type));
      row.appendChild(create('span', 'agent-frame-size', entry.size + 'B'));
      host.appendChild(row);
    });
  }

  function showResult(value) {
    var pre = $('agentResult');
    if (!pre) return;
    var text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    pre.textContent = redact(text).slice(0, 12000);
  }

  function pushFrame(dir, type, size) {
    state.frames.unshift({ at: Date.now(), dir: dir, type: type, size: size });
    if (state.frames.length > MAX_FRAMES) state.frames.pop();
    renderFrameLog();
    renderStatsOnly();
  }

  function logRequest(method, path, status, ms, authOk) {
    state.requests += 1;
    if (status >= 500) state.errors += 1;
    state.log.unshift({
      at: Date.now(),
      method: method,
      path: path,
      status: status,
      ms: Math.round(ms),
      auth: !!authOk
    });
    if (state.log.length > MAX_LOG) state.log.pop();
    renderRequestLog();
    renderStatsOnly();
  }

  // ============================================================
  // tunnel connection
  // ============================================================

  function sendFrame(frame, type, quiet) {
    var ws = state.ws;
    if (!ws || ws.readyState !== 1) return false;
    try {
      ws.send(frame);
      state.framesOut += 1;
      state.bytesOut += frame.length;
      if (!quiet) pushFrame('out', type, frame.length);
      return true;
    } catch (error) {
      state.lastError = '发送帧失败: ' + error.message;
      return false;
    }
  }

  function sendCapabilities() {
    sendFrame(P.encodeCapabilities({
      clientId: state.clientId,
      stream: false,
      multiValueHeaders: true
    }), 'capabilities');
  }

  function sendRegister() {
    sendFrame(P.encodeRegisterTunnel({
      clientId: state.clientId,
      tunnel: {
        id: 'browser-agent',
        domain: state.domain,
        localPort: 80,
        localHost: '127.0.0.1',
        protocol: 'http',
        description: 'test-agent.html (browser)'
      }
    }), 'register_tunnel');
  }

  function sendHeartbeat() {
    sendFrame(P.encodeHeartbeat({
      clientId: state.clientId,
      timestamp: new Date().toISOString(),
      stats: {
        tunnelCount: 1,
        registeredCount: state.registered ? 1 : 0,
        sseConnections: 0,
        totalRequests: state.requests,
        totalErrors: state.errors
      }
    }), 'heartbeat', true);
  }

  function startHeartbeat() {
    stopHeartbeat();
    sendHeartbeat();
    state.heartbeatTimer = setInterval(sendHeartbeat, 25000);
  }

  function stopHeartbeat() {
    if (state.heartbeatTimer) {
      clearInterval(state.heartbeatTimer);
      state.heartbeatTimer = null;
    }
  }

  function connect() {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;

    if (state.ws) {
      var old = state.ws;
      state.ws = null;
      try { old.close(1000, 'reconnect'); } catch (error) { /* ignore */ }
    }

    state.registered = false;
    setStatus('connecting', '正在建立 WSS 连接…');

    var ws;
    try {
      ws = new WebSocket(WS_BASE + '?clientId=' + encodeURIComponent(state.clientId));
    } catch (error) {
      setStatus('error', 'WebSocket 初始化失败: ' + error.message);
      scheduleReconnect();
      return;
    }

    ws.binaryType = 'arraybuffer';
    state.ws = ws;

    ws.onopen = function () {
      if (state.ws !== ws) return;
      state.reconnectAttempts = 0;
      state.lastError = '';
      setStatus('connected', '已连接，正在声明能力并注册隧道…');
      sendCapabilities();
      sendRegister();
      startHeartbeat();
    };

    ws.onmessage = function (event) {
      if (state.ws !== ws) return;
      handleIncoming(event.data);
    };

    ws.onerror = function () {
      if (state.ws !== ws) return;
      state.lastError = 'WebSocket 连接错误';
    };

    ws.onclose = function (event) {
      if (state.ws !== ws) return;
      state.ws = null;
      onClose(event);
    };
  }

  function scheduleReconnect() {
    if (state.manualStop || state.reconnectTimer) return;
    state.reconnectAttempts += 1;
    var seconds = Math.min(1.5 * Math.pow(1.7, state.reconnectAttempts - 1), 20);
    var wait = Math.round(seconds * 1000);
    state.detail = '第 ' + state.reconnectAttempts + ' 次重连，' + Math.round(seconds) + ' 秒后…';
    render();
    state.reconnectTimer = setTimeout(function () {
      state.reconnectTimer = null;
      if (!state.manualStop) connect();
    }, wait);
  }

  function onClose(event) {
    stopHeartbeat();
    state.registered = false;

    if (state.manualStop) {
      if (state.status !== 'error') setStatus('offline', '隧道已断开，可点击「重连」。');
      else render();
      return;
    }

    var reason = event && event.reason ? ': ' + event.reason : '';
    state.lastError = '连接已关闭' + (event && event.code ? ' (code ' + event.code + ')' : '') + reason;
    setStatus('reconnecting', state.lastError);
    scheduleReconnect();
  }

  function forceReconnect() {
    state.manualStop = false;
    state.reconnectAttempts = 0;
    state.lastError = '';
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
    connect();
  }

  function handleIncoming(data) {
    var frame;
    try {
      frame = P.decodeFrame(data);
    } catch (error) {
      state.lastError = '帧解码失败: ' + error.message;
      render();
      return;
    }

    state.framesIn += 1;
    state.bytesIn += frame.byteLength;
    if (frame.type !== 'heartbeat_ack') pushFrame('in', frame.type, frame.byteLength);

    var message = P.decodeMessage(frame);

    switch (message.type) {
      case 'welcome':
        state.serverVersion = message.protocolVersion || 1;
        render();
        break;

      case 'registered':
        handleRegistered(message);
        break;

      case 'http_request':
        handleRequest(message);
        break;

      case 'unregistered':
        state.registered = false;
        setStatus('connected', '隧道已注销');
        break;

      case 'heartbeat_ack':
        break;

      default:
        break;
    }
  }

  function handleRegistered(message) {
    if (message.success) {
      state.registered = true;
      state.connectedAt = Date.now();
      state.lastError = '';
      storeSet(DOMAIN_KEY, state.domain);
      setStatus('registered', '隧道已注册。保持标签页打开，等待 AI Agent 调用。');
      toast('隧道已注册：' + state.domain);
      return;
    }

    state.registered = false;
    state.lastError = message.error || '隧道注册失败';
    setStatus('error', state.lastError);

    if (/already taken/i.test(state.lastError) && state.autoFallback && !state.fallbackTried) {
      state.fallbackTried = true;
      state.domain = randomDomain();
      storeSet(DOMAIN_KEY, state.domain);
      storeSet(AUTO_KEY, '1');
      var input = $('agentDomainInput');
      if (input) input.value = state.domain;
      toast('域名被占用，已切换到 ' + state.domain);
      setTimeout(forceReconnect, 350);
      return;
    }

    state.manualStop = true;
    if (state.ws) {
      try { state.ws.close(4001, 'registration failed'); } catch (error) { /* ignore */ }
    }
  }

  // ============================================================
  // HTTP request handling
  // ============================================================

  function sendResponse(request, status, payload, extraHeaders, opts) {
    opts = opts || {};
    var body = new Uint8Array(0);

    if (status !== 204 && payload !== undefined && payload !== null) {
      if (payload instanceof Uint8Array) body = payload;
      else if (typeof payload === 'string') body = P.utf8(payload);
      else body = P.utf8(JSON.stringify(payload));
    }

    var headers = { 'cache-control': 'no-store' };
    if (status !== 204) {
      headers['content-type'] = 'application/json; charset=utf-8';
      headers['content-length'] = String(body.length);
    }
    Object.keys(extraHeaders || {}).forEach(function (key) {
      headers[key] = String(extraHeaders[key]);
    });
    if (request.requestId) headers['x-agent-request-id'] = request.requestId;
    if (status === 401) headers['www-authenticate'] = 'Bearer realm="dtns-agent"';

    var frame = P.encodeHttpResponse({
      requestId: request.requestId,
      domain: request.domain,
      status: status,
      headers: headers,
      body: body,
      isSSE: false,
      sseRequestId: request.sseRequestId || null,
      isWebSocket: !!opts.isWebSocket,
      wsRequestId: opts.wsRequestId || request.wsRequestId || null,
      error: null
    }, state.serverVersion);

    sendFrame(frame, 'http_response');
  }

  function handleRequest(request) {
    var started = (window.performance && performance.now) ? performance.now() : Date.now();
    var method = String(request.method || 'GET').toUpperCase();
    var parsed = parseRequestUrl(request.url, request.domain);
    var path = normalizePath(parsed.pathname);
    var query = {};
    parsed.searchParams.forEach(function (value, key) { query[key] = value; });

    var headers = lowerHeaders(request.headers || {});
    var bodyBytes = request.body || new Uint8Array(0);
    var bodyText = bytesToText(bodyBytes);
    var bodyJson = null;
    if (bodyText) {
      try { bodyJson = JSON.parse(bodyText); } catch (error) { bodyJson = null; }
    }

    var token = extractToken(headers, query);
    var authOk = AUTH_REQUIRED ? (!!token && token === state.token) : true;

    function done(status) {
      logRequest(method, path, status, ((window.performance && performance.now) ? performance.now() : Date.now()) - started, authOk);
    }

    if (bodyBytes.length > MAX_BODY) {
      sendResponse(request, 413, { ok: false, error: 'payload_too_large', limitBytes: MAX_BODY });
      done(413);
      return;
    }

    if (method === 'OPTIONS') {
      sendResponse(request, 204, null, {});
      done(204);
      return;
    }

    if (request.isWebSocket) {
      sendResponse(request, 501, {
        ok: false,
        error: 'websocket_not_supported',
        hint: 'This test API only handles plain HTTP.'
      }, {}, { isWebSocket: true, wsRequestId: request.wsRequestId });
      done(501);
      return;
    }

    if (!/^(GET|POST)$/.test(method)) {
      sendResponse(request, 405, {
        ok: false,
        error: 'method_not_allowed',
        allow: 'GET, POST, OPTIONS'
      }, { allow: 'GET, POST, OPTIONS' });
      done(405);
      return;
    }

    var context = {
      method: method,
      path: path,
      query: query,
      headers: headers,
      bodyText: bodyText,
      bodyJson: bodyJson,
      bodyBytes: bodyBytes,
      authOk: authOk,
      request: request
    };

    Promise.resolve().then(function () {
      return route(context);
    }).then(function (response) {
      response = response || result(404, { ok: false, error: 'not_found' });
      sendResponse(request, response.status, response.body, response.headers, response.opts);
      done(response.status);
    }).catch(function (error) {
      sendResponse(request, 500, {
        ok: false,
        error: 'internal_error',
        message: String((error && error.message) || error)
      });
      done(500);
    });
  }

  // ============================================================
  // page API routes
  // ============================================================

  function route(context) {
    var path = context.path;
    var method = context.method;

    if (PUBLIC_PATHS[path]) {
      if (method !== 'GET') return methodNotAllowed(['GET']);
      if (path === '/agent/status') return result(200, statusBody());
      if (path === '/agent/openapi.json') return result(200, buildOpenApi());
      return result(200, helpBody());
    }

    if (AUTH_REQUIRED && !context.authOk) {
      return result(401, {
        ok: false,
        error: 'unauthorized',
        hint: 'Send Authorization: Bearer <token>. The token is shown on test-agent.html.'
      });
    }

    if (path === '/agent/page') {
      if (method !== 'GET') return methodNotAllowed(['GET']);
      return pageResult();
    }

    if (path === '/agent/sections') {
      if (method !== 'GET') return methodNotAllowed(['GET']);
      return result(200, { ok: true, sections: getSections() });
    }

    if (path === '/agent/text') {
      if (method !== 'GET') return methodNotAllowed(['GET']);
      return textResult(context);
    }

    if (path === '/agent/scroll') {
      if (method !== 'POST') return methodNotAllowed(['POST']);
      return scrollResult(context);
    }

    if (path === '/agent/highlight') {
      if (method !== 'POST') return methodNotAllowed(['POST']);
      return highlightResult(context);
    }

    if (path === '/agent/click') {
      if (method !== 'POST') return methodNotAllowed(['POST']);
      return clickResult(context);
    }

    if (path === '/agent/ping') {
      if (method !== 'GET') return methodNotAllowed(['GET']);
      return result(200, pingBody(context));
    }

    if (path === '/agent/site') {
      if (method !== 'GET') return methodNotAllowed(['GET']);
      return siteResult();
    }

    if (path === '/agent/log') {
      if (method !== 'GET') return methodNotAllowed(['GET']);
      return result(200, { ok: true, count: state.log.length, entries: state.log });
    }

    if (path === '/agent/log/clear') {
      if (method !== 'POST') return methodNotAllowed(['POST']);
      state.log = [];
      renderRequestLog();
      return result(200, { ok: true, cleared: true });
    }

    if (path === '/agent/reconnect') {
      if (method !== 'POST') return methodNotAllowed(['POST']);
      setTimeout(forceReconnect, 300);
      return result(200, {
        ok: true,
        reconnecting: true,
        note: 'This response is sent before the tunnel reconnects.'
      });
    }

    return result(404, {
      ok: false,
      error: 'not_found',
      path: path,
      endpoints: ENDPOINTS.map(function (ep) { return ep.method + ' ' + ep.path; })
    });
  }

  function statusBody() {
    return {
      ok: true,
      service: 'dtns-agent-page-api',
      page: 'test-agent.html',
      connected: !!(state.ws && state.ws.readyState === 1),
      registered: state.registered,
      domain: state.domain,
      apiBase: apiBase(),
      protocolVersion: state.serverVersion,
      uptimeMs: Date.now() - state.startedAt,
      requests: state.requests,
      frames: {
        in: state.framesIn,
        out: state.framesOut,
        bytesIn: state.bytesIn,
        bytesOut: state.bytesOut
      },
      auth: AUTH_REQUIRED ? {
        required: true,
        scheme: 'Bearer',
        header: 'Authorization',
        note: 'Token is shown on test-agent.html and is never returned by this endpoint.'
      } : {
        required: false,
        scheme: 'url',
        header: null,
        note: 'The API URL itself is the credential; no token is required.'
      },
      openapi: apiBase() + '/agent/openapi.json',
      endpoints: ENDPOINTS.map(function (ep) {
        return {
          method: ep.method,
          path: ep.path,
          description: ep.desc,
          auth: AUTH_REQUIRED ? (ep.auth ? 'token' : 'public') : 'url'
        };
      }),
      serverTime: new Date().toISOString()
    };
  }

  function helpBody() {
    return {
      ok: true,
      service: 'dtns-agent-page-api',
      apiBase: apiBase(),
      page: window.location.href,
      auth: AUTH_REQUIRED ? {
        type: 'bearer',
        header: 'Authorization',
        format: 'Bearer <token>',
        note: 'Copy the token from test-agent.html. Keep the page open.'
      } : {
        type: 'url',
        note: 'The API URL itself is the credential; share it only with trusted agents.'
      },
      endpoints: ENDPOINTS.map(function (ep) {
        return {
          method: ep.method,
          path: ep.path,
          description: ep.desc,
          auth: AUTH_REQUIRED ? (ep.auth ? 'token' : 'public') : 'url'
        };
      }),
      examples: AUTH_REQUIRED ? [
        'curl -s -H "Authorization: Bearer $AGENT_TOKEN" "$API_BASE/agent/status"',
        'curl -s -H "Authorization: Bearer $AGENT_TOKEN" "$API_BASE/agent/page"',
        'curl -s -H "Authorization: Bearer $AGENT_TOKEN" "$API_BASE/agent/text?selector=%23agent&limit=2000"',
        'curl -s -X POST -H "Authorization: Bearer $AGENT_TOKEN" -H "Content-Type: application/json" -d \'{"selector":"#agent h2","durationMs":1800}\' "$API_BASE/agent/highlight"'
      ] : [
        'curl -s "$API_BASE/agent/status"',
        'curl -s "$API_BASE/agent/page"',
        'curl -s "$API_BASE/agent/text?selector=%23agent&limit=2000"',
        'curl -s -X POST -H "Content-Type: application/json" -d \'{"selector":"#agent h2","durationMs":1800}\' "$API_BASE/agent/highlight"'
      ],
      note: (AUTH_REQUIRED ? '' : 'Access is URL-only; the URL is the credential. ') + 'Every request is answered by the browser tab through the DTNS tunnel. Closing the tab takes the API offline.'
    };
  }

  function getHeadings() {
    var nodes = document.querySelectorAll('h1, h2, h3');
    var output = [];
    for (var i = 0; i < nodes.length && output.length < 80; i++) {
      var el = nodes[i];
      var section = el.closest ? el.closest('section[id]') : null;
      output.push({
        level: Number(el.tagName.charAt(1)),
        text: redact(clean(el.textContent)),
        id: el.id || null,
        section: section ? section.id : null
      });
    }
    return output;
  }

  function getSections() {
    var nodes = document.querySelectorAll('main section[id]');
    var output = [];
    for (var i = 0; i < nodes.length; i++) {
      var section = nodes[i];
      var heading = section.querySelector('h2');
      var rect = section.getBoundingClientRect();
      output.push({
        id: section.id,
        title: redact(clean(heading ? heading.textContent : '')),
        top: Math.round(rect.top + (window.scrollY || window.pageYOffset || 0))
      });
    }
    return output;
  }

  function getSiteStatus() {
    var now = Date.now();
    if (now - siteCache.at < 15000) return Promise.resolve(siteCache.data);

    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, 2500) : null;

    return fetch('/api/status', {
      cache: 'no-store',
      headers: { 'Accept': 'application/json' },
      signal: controller ? controller.signal : undefined
    }).then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.json();
    }).then(function (data) {
      var value = {
        tunnels: data.tunnels,
        uptimeSeconds: data.uptimeSeconds,
        node: data.node
      };
      siteCache = { at: Date.now(), data: value };
      return value;
    }).catch(function () {
      siteCache = { at: Date.now(), data: null };
      return null;
    }).then(function (value) {
      if (timer) clearTimeout(timer);
      return value;
    });
  }

  function pageResult() {
    return getSiteStatus().then(function (site) {
      var maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
      return result(200, {
        ok: true,
        title: document.title,
        description: metaDescription(),
        url: window.location.href,
        apiBase: apiBase(),
        scroll: {
          y: Math.round(window.scrollY || 0),
          max: maxScroll,
          viewport: window.innerHeight
        },
        headings: getHeadings(),
        sections: getSections(),
        site: site,
        auth: AUTH_REQUIRED ? { required: true, scheme: 'Bearer' } : { required: false, scheme: 'url' },
        serverTime: new Date().toISOString()
      });
    });
  }

  function textResult(context) {
    var selector = context.query.selector || 'main';
    var limit = parseInt(context.query.limit, 10);
    if (!isFinite(limit) || limit <= 0) limit = 4000;
    limit = Math.min(limit, MAX_TEXT);

    var element;
    try {
      element = document.querySelector(selector);
    } catch (error) {
      return result(400, { ok: false, error: 'invalid_selector', selector: selector });
    }
    if (!element) {
      return result(404, { ok: false, error: 'selector_not_found', selector: selector });
    }

    var text = redact(clean(element.innerText || element.textContent || ''));
    var truncated = text.length > limit;
    if (truncated) text = text.slice(0, limit);

    return result(200, {
      ok: true,
      selector: selector,
      length: text.length,
      truncated: truncated,
      text: text
    });
  }

  function scrollResult(context) {
    var body = (context.bodyJson && typeof context.bodyJson === 'object') ? context.bodyJson : {};
    var selector = typeof body.selector === 'string' ? body.selector : (context.query.selector || '');
    var behavior = body.behavior === 'auto' ? 'auto' : 'smooth';
    var yValue = body.y !== undefined ? Number(body.y) : Number(context.query.y);
    var wait = behavior === 'smooth' ? 320 : 0;

    if (selector) {
      var element;
      try {
        element = document.querySelector(selector);
      } catch (error) {
        return result(400, { ok: false, error: 'invalid_selector', selector: selector });
      }
      if (!element) {
        return result(404, { ok: false, error: 'selector_not_found', selector: selector });
      }
      element.scrollIntoView({ behavior: behavior, block: 'start' });
      return delay(wait).then(function () {
        return result(200, {
          ok: true,
          selector: selector,
          scrollY: Math.round(window.scrollY || 0)
        });
      });
    }

    if (!isFinite(yValue)) {
      return result(400, {
        ok: false,
        error: 'missing_target',
        hint: 'Provide {"selector":"#agent"} or {"y":1200}.'
      });
    }

    var maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    var target = Math.max(0, Math.min(Math.round(yValue), maxScroll));
    window.scrollTo({ top: target, behavior: behavior });
    return delay(wait).then(function () {
      return result(200, {
        ok: true,
        requestedY: target,
        scrollY: Math.round(window.scrollY || 0)
      });
    });
  }

  function highlightResult(context) {
    var body = (context.bodyJson && typeof context.bodyJson === 'object') ? context.bodyJson : {};
    var selector = typeof body.selector === 'string' ? body.selector : (context.query.selector || '');
    if (!selector) {
      return result(400, { ok: false, error: 'missing_selector' });
    }

    var duration = parseInt(body.durationMs, 10);
    if (!isFinite(duration)) duration = 1800;
    duration = Math.max(600, Math.min(duration, 10000));

    var elements;
    try {
      elements = document.querySelectorAll(selector);
    } catch (error) {
      return result(400, { ok: false, error: 'invalid_selector', selector: selector });
    }
    if (!elements.length) {
      return result(404, { ok: false, error: 'selector_not_found', selector: selector });
    }

    var targets = Array.prototype.slice.call(elements, 0, 20);
    targets.forEach(function (element) { element.classList.add('agent-highlight'); });
    if (targets[0].scrollIntoView) {
      targets[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    setTimeout(function () {
      targets.forEach(function (element) { element.classList.remove('agent-highlight'); });
    }, duration);

    return result(200, {
      ok: true,
      selector: selector,
      count: targets.length,
      durationMs: duration
    });
  }

  function clickResult(context) {
    var body = (context.bodyJson && typeof context.bodyJson === 'object') ? context.bodyJson : {};
    var selector = typeof body.selector === 'string' ? body.selector : (context.query.selector || '');
    if (!selector) {
      return result(400, { ok: false, error: 'missing_selector' });
    }

    var element;
    try {
      element = document.querySelector(selector);
    } catch (error) {
      return result(400, { ok: false, error: 'invalid_selector', selector: selector });
    }
    if (!element) {
      return result(404, { ok: false, error: 'selector_not_found', selector: selector });
    }

    var safe = element.matches('button, summary, [role="tab"], .tab, [data-agent-click]');
    if (!safe) {
      return result(403, {
        ok: false,
        error: 'unsafe_selector',
        hint: 'Only button, summary, tab and [data-agent-click] elements can be clicked. Links are blocked.'
      });
    }
    if (element.disabled) {
      return result(409, { ok: false, error: 'element_disabled', selector: selector });
    }

    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    element.click();

    return result(200, {
      ok: true,
      selector: selector,
      tag: element.tagName.toLowerCase(),
      text: redact(clean(element.textContent || '')).slice(0, 120)
    });
  }

  function pingBody(context) {
    var safeHeaders = {};
    Object.keys(context.headers).forEach(function (key) {
      if (['authorization', 'x-agent-token', 'cookie', 'set-cookie'].indexOf(key) !== -1) return;
      safeHeaders[key] = redact(context.headers[key]);
    });

    var safeQuery = {};
    Object.keys(context.query).forEach(function (key) {
      if (key === 'token') return;
      safeQuery[key] = redact(context.query[key]);
    });

    return {
      ok: true,
      method: context.method,
      path: context.path,
      query: safeQuery,
      headers: safeHeaders,
      body: redact(context.bodyText || '').slice(0, 2000),
      bodyLength: context.bodyBytes.length,
      at: new Date().toISOString()
    };
  }

  function siteResult() {
    return getSiteStatus().then(function (site) {
      if (!site) return result(502, { ok: false, error: 'site_status_unavailable' });
      return result(200, { ok: true, site: site });
    });
  }

  function buildOpenApi() {
    var base = apiBase();
    var okResponse = { '200': { description: 'OK', content: { 'application/json': { schema: { type: 'object' } } } } };
    var authResponse = AUTH_REQUIRED ? { '401': { description: 'Missing or invalid bearer token' } } : {};

    function responses() {
      return Object.assign({}, okResponse, authResponse);
    }

    function post(summary, description, properties, required) {
      var operation = {
        summary: summary,
        description: description,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: properties || {},
                additionalProperties: false,
                required: required || []
              }
            }
          }
        },
        responses: responses()
      };
      if (AUTH_REQUIRED) operation.security = [{ bearerAuth: [] }];
      return { post: operation };
    }

    function get(summary, description, secure, parameters) {
      var operation = {
        summary: summary,
        description: description,
        responses: secure ? responses() : Object.assign({}, okResponse)
      };
      if (AUTH_REQUIRED) operation.security = secure ? [{ bearerAuth: [] }] : [];
      if (parameters) operation.parameters = parameters;
      return { get: operation };
    }

    var spec = {
      openapi: '3.0.3',
      info: {
        title: 'DTNS Agent Page API',
        version: '1.0.0',
        description: AUTH_REQUIRED
          ? 'HTTP API exposed by test-agent.html through the DTNS tunnel. Requires a bearer token. The browser tab must stay open.'
          : 'HTTP API exposed by agent.html through the DTNS tunnel. Access is URL-only; the URL is the credential. The browser tab must stay open.'
      },
      servers: [{ url: base }],
      paths: {
        '/': get('Service help', 'Public endpoint list and examples.', false),
        '/agent/status': get('Tunnel status', 'Connection state, protocol version and endpoints.', false),
        '/agent/help': get('Help', 'Endpoint list, auth format and curl examples.', false),
        '/agent/openapi.json': get('OpenAPI document', 'This document.', false),
        '/agent/page': get('Page metadata', 'Title, headings, sections, scroll position and site stats.', true),
        '/agent/sections': get('Sections', 'Section ids, titles and absolute offsets.', true),
        '/agent/text': get('Read text', 'Return redacted text of a CSS selector.', true, [
          { name: 'selector', in: 'query', schema: { type: 'string', default: 'main' }, description: 'CSS selector' },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 4000 }, description: 'Max characters (<= 20000)' }
        ]),
        '/agent/scroll': post('Scroll', 'Scroll to a selector or a y coordinate.', {
          selector: { type: 'string' },
          y: { type: 'integer' },
          behavior: { type: 'string', enum: ['auto', 'smooth'] }
        }),
        '/agent/highlight': post('Highlight', 'Outline one or more elements temporarily.', {
          selector: { type: 'string' },
          durationMs: { type: 'integer', minimum: 600, maximum: 10000 }
        }, ['selector']),
        '/agent/click': post('Click', 'Click a safe button, summary, tab or [data-agent-click].', {
          selector: { type: 'string' }
        }, ['selector']),
        '/agent/ping': get('Echo', 'Echo method, query, filtered headers and body.', true),
        '/agent/site': get('Site status', 'Proxy to the site server /api/status.', true),
        '/agent/log': get('Request log', 'Recent API requests handled by this tab.', true),
        '/agent/log/clear': {
          post: Object.assign({
            summary: 'Clear log',
            responses: responses()
          }, AUTH_REQUIRED ? { security: [{ bearerAuth: [] }] } : {})
        },
        '/agent/reconnect': {
          post: Object.assign({
            summary: 'Reconnect tunnel',
            responses: responses()
          }, AUTH_REQUIRED ? { security: [{ bearerAuth: [] }] } : {})
        }
      }
    };

    if (AUTH_REQUIRED) {
      spec.security = [{ bearerAuth: [] }];
      spec.components = {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer' }
        }
      };
    }
    return spec;
  }

  // ============================================================
  // UI test calls
  // ============================================================

  function callApi(method, path, body) {
    if (!state.registered) {
      showResult({ ok: false, error: 'tunnel_not_registered', hint: '等待状态变为「在线」后再试。' });
      return;
    }

    var options = {
      method: method,
      cache: 'no-store',
      headers: {
        'Accept': 'application/json'
      }
    };
    if (AUTH_REQUIRED) options.headers['Authorization'] = 'Bearer ' + state.token;
    if (method !== 'GET') {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body || {});
    }

    showResult({ pending: true, method: method, url: apiBase() + path });

    fetch(apiBase() + path, options).then(function (response) {
      return response.text().then(function (text) {
        var parsed;
        try { parsed = JSON.parse(text); } catch (error) { parsed = text; }
        showResult({ status: response.status, ok: response.ok, response: parsed });
      });
    }).catch(function (error) {
      showResult({
        error: String((error && error.message) || error),
        hint: '若浏览器拦截跨域请求，请确认入口 nginx 的 CORS 配置允许 Authorization 请求头。'
      });
    });
  }

  var TEST_ACTIONS = {
    status: function () { callApi('GET', '/agent/status'); },
    page: function () { callApi('GET', '/agent/page'); },
    highlight: function () { callApi('POST', '/agent/highlight', { selector: '#agent h2', durationMs: 1800 }); },
    scroll: function () {
      callApi('POST', '/agent/scroll', { selector: '#agent', behavior: 'smooth' });
    },
    click: function () { callApi('POST', '/agent/click', { selector: '#tabbtn-client' }); }
  };

  // ============================================================
  // events + boot
  // ============================================================

  function applyDomain(value, byUser) {
    var domain = validDomain(value);
    if (!domain) {
      toast('域名需为 *.html.dtns.top');
      var input = $('agentDomainInput');
      if (input) input.focus();
      return;
    }

    if (domain === state.domain && state.registered) {
      toast('已经在使用该域名');
      return;
    }

    state.domain = domain;
    state.autoFallback = !byUser;
    state.fallbackTried = false;
    storeSet(DOMAIN_KEY, domain);
    storeSet(AUTO_KEY, byUser ? '0' : '1');

    var field = $('agentDomainInput');
    if (field) field.value = domain;

    toast('正在注册 ' + domain);
    forceReconnect();
  }

  function bindUi() {
    var form = $('agentDomainForm');
    if (form) {
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        applyDomain($('agentDomainInput') ? $('agentDomainInput').value : '', true);
      });
    }

    var random = $('agentRandom');
    if (random) {
      random.addEventListener('click', function () {
        var domain = randomDomain();
        var input = $('agentDomainInput');
        if (input) input.value = domain;
        applyDomain(domain, false);
      });
    }

    var reconnect = $('agentReconnect');
    if (reconnect) {
      reconnect.addEventListener('click', function () {
        toast('正在重连…');
        forceReconnect();
      });
    }

    var regen = $('agentRegenToken');
    if (regen) {
      regen.addEventListener('click', function () {
        state.token = randomHex(16);
        storeSet(TOKEN_KEY, state.token);
        state.showToken = false;
        renderToken();
        renderCurl();
        toast('Token 已更新，旧 Token 立即失效');
      });
    }

    var toggle = $('agentToggleToken');
    if (toggle) {
      toggle.addEventListener('click', function () {
        state.showToken = !state.showToken;
        renderToken();
        renderCurl();
      });
    }

    var copyBase = $('agentCopyBase');
    if (copyBase) {
      copyBase.addEventListener('click', function () {
        copyAndToast(apiBase(), AUTH_REQUIRED ? 'API Base 已复制' : 'API Base 已复制（URL 即凭证）');
      });
    }

    var copyToken = $('agentCopyToken');
    if (copyToken) {
      copyToken.addEventListener('click', function () {
        copyAndToast(state.token, 'Token 已复制（不要公开）');
      });
    }

    var copyBundle = $('agentCopyBundle');
    if (copyBundle) {
      copyBundle.addEventListener('click', function () {
        copyAndToast(buildBundle(), '已复制 API、Token 与 OpenAPI 地址');
      });
    }

    ['agentCopyCurl', 'agentCopyCurl2'].forEach(function (id) {
      var button = $(id);
      if (button) {
        button.addEventListener('click', function () {
          copyAndToast(buildCurlText(true), 'curl 示例已复制（含真实 Token）');
        });
      }
    });

    var clear = $('agentClearLog');
    if (clear) {
      clear.addEventListener('click', function () {
        state.log = [];
        renderRequestLog();
        toast('请求日志已清空');
      });
    }

    Array.prototype.forEach.call(document.querySelectorAll('[data-agent-test]'), function (button) {
      button.addEventListener('click', function () {
        var action = button.getAttribute('data-agent-test');
        if (TEST_ACTIONS[action]) TEST_ACTIONS[action]();
      });
    });

    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && !state.registered && !state.manualStop && !state.ws) {
        forceReconnect();
      }
    });

    window.addEventListener('beforeunload', function () {
      state.manualStop = true;
      clearTimeout(state.reconnectTimer);
      stopHeartbeat();
      if (state.ws) {
        try { state.ws.close(1000, 'page unload'); } catch (error) { /* ignore */ }
      }
    });
  }

  function boot() {
    if (!P) {
      state.status = 'error';
      state.statusText = '协议加载失败';
      state.detail = 'assets/dtns-protocol.js 未加载，无法连接隧道。';
      renderEndpoints();
      render();
      return;
    }

    state.clientId = 'agent-' + randomHex(6);

    if (AUTH_REQUIRED) {
      var storedToken = storeGet(TOKEN_KEY, '');
      state.token = /^[a-f0-9]{32,64}$/i.test(storedToken) ? storedToken : randomHex(16);
      storeSet(TOKEN_KEY, state.token);
    } else {
      state.token = '';
    }

    var paramDomain = '';
    try {
      paramDomain = validDomain(new URLSearchParams(window.location.search).get('domain'));
    } catch (error) { paramDomain = ''; }

    var storedDomain = validDomain(storeGet(DOMAIN_KEY, ''));
    if (paramDomain) {
      state.domain = paramDomain;
      state.autoFallback = false;
      storeSet(DOMAIN_KEY, state.domain);
      storeSet(AUTO_KEY, '0');
    } else if (storedDomain) {
      state.domain = storedDomain;
      state.autoFallback = storeGet(AUTO_KEY, '0') === '1';
    } else {
      state.domain = randomDomain();
      state.autoFallback = true;
      storeSet(DOMAIN_KEY, state.domain);
      storeSet(AUTO_KEY, '1');
    }

    var input = $('agentDomainInput');
    if (input) input.value = state.domain;

    state.detail = '正在连接 ' + state.domain + '…';
    renderEndpoints();
    renderRequestLog();
    renderFrameLog();
    renderStatsOnly();
    render();
    bindUi();
    setStatus('connecting', '正在连接隧道服务端…');
    connect();
  }

  boot();
})();

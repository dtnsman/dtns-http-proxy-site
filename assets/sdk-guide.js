/**
 * sdk.html — Express-style SDK guide + live demo.
 *
 * Creates a second DTNS tunnel with sdk.js, defines real app.get/app.post
 * routes, and drives them with fetch from the buttons.
 */
(function () {
  'use strict';

  var statusEl = document.getElementById('sdkStatus');
  var resultEl = document.getElementById('sdkResult');
  var callEl = document.getElementById('sdkCall');
  var baseEl = document.getElementById('sdkDemoBase');
  var logEl = document.getElementById('sdkDemoLog');
  var countEl = document.getElementById('sdkDemoCount');
  var wsStatusEl = document.getElementById('sdkWsStatus');
  var wsUrlEl = document.getElementById('sdkWsUrl');
  var wsLogEl = document.getElementById('sdkWsLog');
  var wsConnect = document.getElementById('sdkWsConnect');
  var wsClose = document.getElementById('sdkWsClose');
  var wsSend = document.getElementById('sdkWsSend');
  var wsInput = document.getElementById('sdkWsInput');
  var buttons = Array.prototype.slice.call(document.querySelectorAll('[data-sdk-demo]'));
  if (!statusEl || !resultEl || !buttons.length) return;

  var demoApp = null;
  var demoBase = '';
  var demoRequests = 0;
  var lastCall = '';
  var logRows = 0;
  var restartTimer = null;
  var liveSocket = null;

  var ACTIONS = {
    hello: { method: 'GET', path: '/hello?from=demo', curl: '/hello?from=demo' },
    users: { method: 'GET', path: '/users/42?tab=info', curl: '/users/42?tab=info' },
    'echo-get': { method: 'GET', path: '/echo?x=1&x=2', curl: '/echo?x=1&x=2' },
    'echo-post': {
      method: 'POST',
      path: '/echo',
      body: { hello: 'sdk.js', n: 3 },
      curl: "-X POST -H 'Content-Type: application/json' -d '{\"hello\":\"sdk.js\",\"n\":3}' /echo"
    },
    auto: { method: 'GET', path: '/auto', curl: '/auto' },
    page: { method: 'GET', path: '/page', curl: '/page' },
    highlight: {
      method: 'POST',
      path: '/highlight',
      body: { selector: '#sdk h2', durationMs: 1600 },
      curl: "-X POST -H 'Content-Type: application/json' -d '{\"selector\":\"#sdk h2\",\"durationMs\":1600}' /highlight"
    },
    status: { method: 'GET', path: '/status', curl: '/status' }
  };

  function $(id) { return document.getElementById(id); }

  function randomHex(bytes) {
    var data = new Uint8Array(bytes);
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(data);
    else for (var i = 0; i < data.length; i++) data[i] = Math.floor(Math.random() * 256);
    return Array.prototype.map.call(data, function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }

  function setStatus(text, kind) {
    statusEl.textContent = text;
    statusEl.className = 'sdk-status' + (kind ? ' is-' + kind : '');
  }

  function setResult(value, isError) {
    var text;
    if (typeof value === 'string') text = value;
    else text = JSON.stringify(value, null, 2);
    if (text === undefined) text = String(value);
    if (text.length > 12000) text = text.slice(0, 12000) + '\n…';
    resultEl.textContent = text;
    resultEl.classList.toggle('is-error', !!isError);
  }

  function setBase(base) {
    demoBase = base || '';
    if (baseEl) baseEl.textContent = demoBase || '—';
  }

  function setReady(ready) {
    buttons.forEach(function (button) { button.disabled = !ready; });
  }

  function setCall(text) {
    lastCall = text || '';
    if (callEl) callEl.textContent = lastCall;
  }

  function setWsStatus(text, kind) {
    if (!wsStatusEl) return;
    wsStatusEl.textContent = text;
    wsStatusEl.className = 'sdk-status' + (kind ? ' is-' + kind : '');
  }

  function setWsUrl(base) {
    var url = base ? base.replace(/^http/, 'ws') + '/live?name=demo' : '—';
    if (wsUrlEl) wsUrlEl.textContent = url;
    return url;
  }

  function setWsControls(state) {
    if (wsConnect) wsConnect.disabled = state !== 'closed' || !demoBase;
    if (wsClose) wsClose.disabled = state !== 'open';
    if (wsSend) wsSend.disabled = state !== 'open';
    if (wsInput) wsInput.disabled = state !== 'open';
  }

  function resetWsLog(text) {
    if (wsLogEl) wsLogEl.textContent = text || '等待 Demo 在线…';
  }

  function wsLog(line) {
    if (!wsLogEl) return;
    var time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    var lines = String(wsLogEl.textContent || '').split('\n').filter(Boolean);
    if (lines.length === 1 && lines[0].indexOf('等待') === 0) lines = [];
    lines.unshift(time + ' ' + line);
    wsLogEl.textContent = lines.slice(0, 30).join('\n');
  }

  function wsText(data) {
    if (typeof data === 'string') return data;
    if (typeof Blob !== 'undefined' && data instanceof Blob) return '[binary blob]';
    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
      try { return new TextDecoder('utf-8').decode(data); }
      catch (error) { return '[binary]'; }
    }
    return String(data);
  }

  function closeLiveSocket(reason) {
    var socket = liveSocket;
    liveSocket = null;
    if (socket) {
      try { socket.close(1000, reason || 'demo close'); } catch (error) { /* ignore */ }
      wsLog('← CLOSE (local)');
    }
    setWsStatus('未连接');
    setWsControls('closed');
  }

  function connectLive() {
    if (!demoBase) return;
    closeLiveSocket('reconnect');
    var url = setWsUrl(demoBase);
    setWsStatus('连接中…', 'wait');
    setWsControls('connecting');
    wsLog('→ CONNECT ' + url);

    var socket;
    try { socket = new WebSocket(url); }
    catch (error) {
      setWsStatus('连接失败', 'error');
      setWsControls('closed');
      wsLog('← ERROR ' + ((error && error.message) || error));
      return;
    }

    liveSocket = socket;
    socket.onopen = function () {
      if (liveSocket !== socket) return;
      setWsStatus('已连接', 'online');
      setWsControls('open');
      wsLog('← OPEN');
    };
    socket.onmessage = function (event) {
      if (liveSocket !== socket) return;
      wsLog('← ' + wsText(event.data));
    };
    socket.onerror = function () {
      if (liveSocket !== socket) return;
      wsLog('← ERROR');
    };
    socket.onclose = function (event) {
      if (liveSocket !== socket) return;
      liveSocket = null;
      setWsStatus('已断开', 'wait');
      setWsControls('closed');
      wsLog('← CLOSE ' + (event.code || 0) + ' ' + (event.reason || ''));
    };
  }

  function sendLive() {
    if (!liveSocket || liveSocket.readyState !== 1) return;
    var text = wsInput && wsInput.value ? wsInput.value : '';
    if (!text) return;
    liveSocket.send(text);
    wsLog('→ ' + text);
  }

  function copyCurl(action) {
    var base = demoBase || '$DEMO';
    var rest = action.curl;
    if (rest.indexOf('-X') === 0) {
      var match = rest.match(/^(.*) (\/[a-z]+)$/);
      if (match) return 'curl -s ' + match[1] + ' "' + base + match[2] + '"';
      return 'curl -s ' + rest;
    }
    return 'curl -s "' + base + rest + '"';
  }

  function addLog(info) {
    if (!logEl) return;
    if (!logRows) logEl.textContent = '';
    logRows += 1;
    var row = document.createElement('div');
    row.className = 'agent-log-row';

    var time = document.createElement('span');
    time.className = 'agent-log-time';
    time.textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });

    var method = document.createElement('span');
    method.className = 'agent-method ' + String(info.method || '').toLowerCase();
    method.textContent = info.method || 'GET';

    var path = document.createElement('span');
    path.className = 'agent-log-path';
    path.textContent = info.path || '/';

    var status = document.createElement('span');
    status.className = 'agent-log-status' + (info.status >= 500 ? ' err' : info.status >= 400 ? ' warn' : '');
    status.textContent = String(info.status == null ? '' : info.status);

    var ms = document.createElement('span');
    ms.className = 'agent-log-ms';
    ms.textContent = info.ms == null ? '' : info.ms + 'ms';

    row.appendChild(time);
    row.appendChild(method);
    row.appendChild(path);
    row.appendChild(status);
    row.appendChild(ms);
    logEl.insertBefore(row, logEl.firstChild);

    while (logEl.children.length > 40) logEl.removeChild(logEl.lastChild);
    if (countEl) countEl.textContent = demoRequests + ' 请求';
  }

  function clearLog() {
    if (!logEl) return;
    logEl.textContent = '';
    var empty = document.createElement('p');
    empty.className = 'agent-empty';
    empty.textContent = '等待请求…';
    logEl.appendChild(empty);
    logRows = 0;
    demoRequests = 0;
    if (countEl) countEl.textContent = '0 请求';
  }

  function fallbackCopy(text) {
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
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(function () {
        return true;
      }, function () {
        fallbackCopy(text);
        return false;
      });
    }
    fallbackCopy(text);
    return Promise.resolve(false);
  }

  function defineRoutes(app) {
    app.use(function (req, res, next) {
      res.set('x-sdk-demo', '1');
      next();
    });

    app.get('/hello', function (req, res) {
      res.json({
        ok: true,
        message: 'hello from sdk.js',
        query: req.query,
        at: new Date().toISOString()
      });
    });

    app.get('/users/:id', function (req, res) {
      res.json({ ok: true, id: req.params.id, query: req.query });
    });

    app.get('/echo', function (req, res) {
      res.json({
        ok: true,
        method: req.method,
        path: req.path,
        query: req.query,
        headers: req.headers
      });
    });

    app.post('/echo', function (req, res) {
      res.status(201).json({ ok: true, method: req.method, body: req.body, query: req.query });
    });

    app.get('/auto', function () {
      return { ok: true, auto: true, note: 'returned without res.json' };
    });

    app.get('/page', function (req, res) {
      var headings = [];
      var nodes = document.querySelectorAll('h1, h2, h3');
      for (var i = 0; i < nodes.length && headings.length < 20; i++) {
        headings.push({
          level: Number(nodes[i].tagName.charAt(1)),
          text: String(nodes[i].textContent || '').replace(/\s+/g, ' ').trim(),
          id: nodes[i].id || null
        });
      }
      res.json({ ok: true, title: document.title, headings: headings });
    });

    app.post('/highlight', function (req, res) {
      var body = req.body || {};
      var selector = typeof body.selector === 'string' ? body.selector : '#sdk h2';
      var duration = parseInt(body.durationMs, 10);
      if (!isFinite(duration)) duration = 1600;
      duration = Math.max(600, Math.min(duration, 10000));

      var nodes;
      try { nodes = document.querySelectorAll(selector); }
      catch (error) { return res.status(400).json({ ok: false, error: 'invalid_selector' }); }
      if (!nodes.length) return res.status(404).json({ ok: false, error: 'selector_not_found' });

      var targets = Array.prototype.slice.call(nodes, 0, 10);
      targets.forEach(function (element) { element.classList.add('agent-highlight'); });
      if (targets[0].scrollIntoView) targets[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(function () {
        targets.forEach(function (element) { element.classList.remove('agent-highlight'); });
      }, duration);

      res.json({ ok: true, selector: selector, count: targets.length, durationMs: duration });
    });

    app.ws('/live', function (ws, req) {
      var name = (req.query && req.query.name) || 'guest';
      ws.send('connected: ' + name + ' @ ' + req.path);
      ws.on('message', function (data, isBinary) {
        if (isBinary) ws.send(data, true);
        else ws.send('echo: ' + data);
      });
    });

    app.get('/status', function (req, res) {
      res.json({
        ok: true,
        app: app.status(),
        routes: app.listRoutes()
      });
    });
  }

  function startDemo() {
    if (!window.DTNSAgent) {
      setStatus('sdk.js 加载失败', 'error');
      setResult({ error: 'window.DTNSAgent is missing' }, true);
      return;
    }

    stopDemo();
    clearLog();
    setReady(false);
    setBase('');
    setWsUrl('');
    setWsStatus('等待 Demo 在线…', 'wait');
    setWsControls('disabled');
    resetWsLog('等待 Demo 在线…');
    var domain = 'sdk-demo-' + randomHex(12) + '.html.dtns.top';
    setStatus('正在注册 ' + domain + ' …', 'wait');
    setResult('正在启动 sdk.js Demo app…');

    var app = window.DTNSAgent.app({
      domain: domain,
      description: 'sdk.html live demo'
    });
    demoApp = app;
    defineRoutes(app);

    app.on('request', function (info) {
      demoRequests += 1;
      addLog(info);
    });
    app.on('error', function (error) {
      addLog({ method: 'ERR', path: (error && error.code) || 'error', status: 500, ms: 0 });
    });
    app.on('reconnecting', function (info) {
      setStatus('Demo 重连中（第 ' + info.attempt + ' 次）…', 'wait');
      setReady(false);
    });
    app.on('disconnected', function () {
      closeLiveSocket('demo disconnected');
      setStatus('Demo 连接断开，等待重连…', 'wait');
      setReady(false);
      setWsStatus('Demo 断开', 'wait');
      setWsControls('disabled');
      wsLog('Demo 断开，等待重连…');
    });
    app.on('reconnected', function () {
      closeLiveSocket('demo reconnected');
      setBase(app.apiBase);
      setStatus('Demo 在线 · ' + app.apiBase, 'online');
      setReady(true);
      setWsUrl(app.apiBase);
      setWsControls('closed');
      setWsStatus('未连接');
      wsLog('Demo 重连完成，可连接 WS。');
    });

    app.listen().then(function () {
      setBase(app.apiBase);
      setStatus('Demo 在线 · ' + app.apiBase, 'online');
      setReady(true);
      setCall('curl -s "' + app.apiBase + '/hello?from=demo"');
      setResult('Demo app 已注册。点击按钮，通过 sdk.js 的 Express 路由调用。');
      setWsUrl(app.apiBase);
      setWsStatus('未连接');
      setWsControls('closed');
      wsLog('Demo 在线，点击“连接 WS”。');
    }).catch(function (error) {
      setStatus('Demo 启动失败：' + ((error && error.message) || error), 'error');
      setResult({ error: String((error && error.message) || error), code: error && error.code }, true);
      setReady(false);
      if (demoApp === app) {
        try { app.close(); } catch (e) { /* ignore */ }
        demoApp = null;
      }
    });
  }

  function stopDemo() {
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
    closeLiveSocket('demo closed');
    if (demoApp) {
      try { demoApp.close(); } catch (error) { /* ignore */ }
      demoApp = null;
    }
    demoBase = '';
    setBase('');
    setReady(false);
    setWsUrl('');
    setWsStatus('未连接');
    setWsControls('disabled');
    resetWsLog('等待 Demo 在线…');
  }

  function callDemo(actionName) {
    var action = ACTIONS[actionName];
    if (!action) return;
    if (!demoBase) {
      setResult({ error: 'Demo 隧道尚未注册', hint: '等待状态变为 Demo 在线，或点击重启 Demo。' }, true);
      return;
    }

    var curl = copyCurl(action);
    setCall(curl);
    setResult({ pending: true, method: action.method, url: demoBase + action.path });

    var options = {
      method: action.method,
      cache: 'no-store',
      headers: { 'Accept': 'application/json' }
    };
    if (action.body) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(action.body);
    }

    fetch(demoBase + action.path, options).then(function (response) {
      return response.text().then(function (text) {
        var data;
        try { data = JSON.parse(text); } catch (error) { data = text; }
        setResult({ status: response.status, ok: response.ok, response: data });
      });
    }).catch(function (error) {
      setResult({
        error: String((error && error.message) || error),
        hint: '检查 Demo 隧道是否在线，以及入口 CORS 是否允许请求。'
      }, true);
    });
  }

  buttons.forEach(function (button) {
    button.addEventListener('click', function () {
      callDemo(button.getAttribute('data-sdk-demo'));
    });
  });

  var restart = $('sdkRestart');
  if (restart) {
    restart.addEventListener('click', function () {
      restart.textContent = '重启中…';
      startDemo();
      restartTimer = setTimeout(function () {
        restart.textContent = '重启 Demo';
        restartTimer = null;
      }, 1200);
    });
  }

  var copyBase = $('sdkCopyBase');
  if (copyBase) {
    copyBase.addEventListener('click', function () {
      if (!demoBase) return;
      copyText(demoBase).then(function () {
        copyBase.textContent = '已复制';
        setTimeout(function () { copyBase.textContent = '复制'; }, 1200);
      });
    });
  }

  var copyCall = $('sdkCopyCall');
  if (copyCall) {
    copyCall.addEventListener('click', function () {
      if (!lastCall) return;
      copyText(lastCall).then(function () {
        copyCall.textContent = '已复制';
        setTimeout(function () { copyCall.textContent = '复制 curl'; }, 1200);
      });
    });
  }

  if (wsConnect) wsConnect.addEventListener('click', connectLive);
  if (wsClose) wsClose.addEventListener('click', function () { closeLiveSocket('demo close'); });
  if (wsSend) wsSend.addEventListener('click', sendLive);
  if (wsInput) {
    wsInput.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') sendLive();
    });
  }

  window.addEventListener('beforeunload', function () {
    closeLiveSocket('page close');
    stopDemo();
  });

  clearLog();
  startDemo();
})();

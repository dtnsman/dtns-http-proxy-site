/* sdk-app.js — DTNS Agent proxy app (built into sdk.js with the DTNS codec) */

function createSDK(Protocol) {
  'use strict';

  var VERSION = '2.0.0';
  var DEFAULT_WS_URL = 'wss://res2.dtns.top/tunnel';
  var DOMAIN_RE = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/i;

  class SDKError extends Error {
    constructor(message, options) {
      super(message || 'DTNS Agent SDK error');
      this.name = 'DTNSAgentError';
      options = options || {};
      this.code = options.code || 'SDK_ERROR';
      this.status = options.status || 0;
      if (options.cause) this.cause = options.cause;
    }
  }

  class Emitter {
    constructor() { this._events = {}; }
    on(name, fn) {
      if (typeof fn === 'function') (this._events[name] = this._events[name] || []).push(fn);
      return this;
    }
    off(name, fn) {
      var list = this._events[name];
      if (!list) return this;
      if (!fn) { delete this._events[name]; return this; }
      this._events[name] = list.filter(function (item) { return item !== fn; });
      return this;
    }
    emit(name) {
      var args = Array.prototype.slice.call(arguments, 1);
      var list = (this._events[name] || []).slice();
      for (var i = 0; i < list.length; i++) {
        try { list[i].apply(null, args); } catch (error) { /* listener errors must not break the tunnel */ }
      }
      return this;
    }
  }

  function now() { return Date.now(); }

  function randomHex(bytes) {
    var data = new Uint8Array(bytes);
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(data);
    else for (var i = 0; i < data.length; i++) data[i] = Math.floor(Math.random() * 256);
    return Array.prototype.map.call(data, function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }

  function utf8(value) { return new TextEncoder().encode(String(value == null ? '' : value)); }

  function textOf(bytes) {
    try { return new TextDecoder('utf-8').decode(bytes || new Uint8Array(0)); }
    catch (error) { return ''; }
  }

  function normalizePath(path) {
    var value = String(path || '/');
    if (value.charAt(0) !== '/') value = '/' + value;
    if (value.length > 1) value = value.replace(/\/+$/, '');
    return value || '/';
  }

  function parseQuery(search) {
    var out = {};
    var params = new URLSearchParams(String(search || '').replace(/^\?/, ''));
    params.forEach(function (value, key) {
      if (out[key] === undefined) out[key] = value;
      else if (Array.isArray(out[key])) out[key].push(value);
      else out[key] = [out[key], value];
    });
    return out;
  }

  function lowerHeaders(headers) {
    var out = {};
    Object.keys(headers || {}).forEach(function (key) {
      out[String(key).toLowerCase()] = headers[key];
    });
    return out;
  }

  function headerValue(headers, name) {
    var value = headers[String(name).toLowerCase()];
    return Array.isArray(value) ? value.join(', ') : value;
  }

  function compilePath(path) {
    var normalized = normalizePath(path);
    if (normalized === '/') return [];
    return normalized.slice(1).split('/').map(function (segment) {
      if (segment === '*') return { wildcard: true };
      if (segment.charAt(0) === ':') return { param: segment.slice(1) };
      return { literal: segment };
    });
  }

  function matchPath(segments, path) {
    var parts = path === '/' ? [] : path.slice(1).split('/');
    var params = {};
    for (var i = 0; i < segments.length; i++) {
      var segment = segments[i];
      if (segment.wildcard) {
        params['*'] = parts.slice(i).join('/');
        return params;
      }
      if (i >= parts.length) return null;
      if (segment.param) {
        try { params[segment.param] = decodeURIComponent(parts[i]); }
        catch (error) { params[segment.param] = parts[i]; }
      } else if (segment.literal !== parts[i]) {
        return null;
      }
    }
    return parts.length === segments.length ? params : null;
  }

  function matchesPrefix(path, prefix) {
    if (!prefix || prefix === '/') return true;
    return path === prefix || path.indexOf(prefix + '/') === 0;
  }

  function isValidStatus(code) { return code >= 100 && code <= 599; }

  function isPromise(value) {
    return !!value && typeof value.then === 'function';
  }

  class Request {
    constructor(message) {
      this.method = String(message.method || 'GET').toUpperCase();
      this.url = message.url || '/';
      this.originalUrl = this.url;
      var parsed = new URL(this.url, 'http://sdk.local');
      this.path = normalizePath(parsed.pathname);
      this.query = parseQuery(parsed.search);
      this.headers = lowerHeaders(message.headers || {});
      this.rawBody = message.body || new Uint8Array(0);
      this.body = undefined;
      this.params = {};
      this.domain = message.domain || '';
      this.requestId = message.requestId || '';
      this.remoteAddress = message.remoteAddress || '';
      this.locals = {};
      this.message = message;
    }
    get(name) { return headerValue(this.headers, name); }
    header(name) { return this.get(name); }
  }

  class Response {
    constructor(app, request, message, onFinish) {
      this.app = app;
      this.req = request;
      this.message = message;
      this.statusCode = 200;
      this.headers = {};
      this.locals = {};
      this.finished = false;
      this.headersSent = false;
      this.onFinish = onFinish || null;
    }

    status(code) { this.statusCode = Number(code) || 200; return this; }

    set(name, value) {
      if (!this.finished) this.headers[String(name).toLowerCase()] = String(value);
      return this;
    }

    header(name, value) { return this.set(name, value); }
    setHeader(name, value) { return this.set(name, value); }
    get(name) { return this.headers[String(name).toLowerCase()]; }

    type(value) {
      var type = String(value || '');
      if (type === 'json') type = 'application/json; charset=utf-8';
      else if (type === 'text' || type === 'txt') type = 'text/plain; charset=utf-8';
      else if (type === 'html') type = 'text/html; charset=utf-8';
      else if (type.indexOf('/') === -1) type = 'application/' + type;
      return this.set('content-type', type);
    }

    json(value) {
      if (!this.get('content-type')) this.set('content-type', 'application/json; charset=utf-8');
      return this.end(JSON.stringify(value === undefined ? null : value));
    }

    send(value) {
      if (value === undefined || value === null) return this.end('');
      if (value instanceof Uint8Array) {
        if (!this.get('content-type')) this.set('content-type', 'application/octet-stream');
        return this.end(value);
      }
      if (typeof value === 'object') return this.json(value);
      if (typeof value === 'string') {
        if (!this.get('content-type')) this.set('content-type', 'text/plain; charset=utf-8');
        return this.end(value);
      }
      return this.end(String(value));
    }

    text(value) {
      if (!this.get('content-type')) this.set('content-type', 'text/plain; charset=utf-8');
      return this.end(String(value == null ? '' : value));
    }

    redirect(url, status) {
      this.status(status || 302);
      this.set('location', String(url));
      return this.end('');
    }

    sendStatus(code) {
      this.status(code);
      return this.end('');
    }

    acceptWebSocket(headers) {
      if (this.finished) return this;
      this.finished = true;
      this.headersSent = true;
      var merged = {};
      var self = this;
      Object.keys(this.headers).forEach(function (key) { merged[key] = self.headers[key]; });
      Object.keys(headers || {}).forEach(function (key) { merged[key] = headers[key]; });
      this.app._acceptWebSocket(this.message, merged);
      if (this.onFinish) this.onFinish(101);
      return this;
    }

    end(body) {
      if (this.finished) return this;
      var status = isValidStatus(this.statusCode) ? this.statusCode : 200;
      var bytes;
      if (body instanceof Uint8Array) bytes = body;
      else if (body instanceof ArrayBuffer) bytes = new Uint8Array(body);
      else if (body === undefined || body === null) bytes = new Uint8Array(0);
      else if (typeof body === 'string') bytes = utf8(body);
      else bytes = utf8(String(body));

      if (this.req.method === 'HEAD') bytes = new Uint8Array(0);

      var headers = {};
      Object.keys(this.headers).forEach(function (key) {
        if (this.headers[key] !== undefined && this.headers[key] !== null) {
          headers[key] = String(this.headers[key]);
        }
      }, this);

      if (status === 204 || status === 304) {
        delete headers['content-type'];
        delete headers['content-length'];
      } else {
        if (headers['content-type'] === undefined && bytes.length) {
          headers['content-type'] = 'application/octet-stream';
        }
        if (headers['content-length'] === undefined) {
          headers['content-length'] = String(bytes.length);
        }
      }

      this.finished = true;
      this.headersSent = true;
      this.app._sendResponse(this.message, status, headers, bytes);
      if (this.onFinish) this.onFinish(status);
      return this;
    }
  }


  class WsConnection extends Emitter {
    constructor(app, message, req, protocol) {
      super();
      this.app = app;
      this.message = message;
      this.req = req;
      this.wsRequestId = message.wsRequestId;
      this.readyState = 1;
      this.open = true;
      this.remoteAddress = req.remoteAddress || '';
      this.path = req.path;
      this.protocol = protocol || '';
      this.url = 'ws://' + (req.domain || '') + req.url;
      this.bytesSent = 0;
      this.bytesReceived = 0;
      this._closed = false;
    }

    send(data, options) {
      if (this._closed || this.readyState !== 1) return false;

      var binary;
      var bytes;
      if (typeof data === 'string') {
        bytes = utf8(data);
        binary = false;
      } else if (data instanceof ArrayBuffer) {
        bytes = new Uint8Array(data);
        binary = true;
      } else if (data instanceof Uint8Array) {
        bytes = data;
        binary = true;
      } else if (ArrayBuffer.isView(data)) {
        bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        binary = true;
      } else if (data === undefined || data === null) {
        bytes = new Uint8Array(0);
        binary = false;
      } else {
        bytes = utf8(String(data));
        binary = false;
      }

      if (typeof options === 'boolean') binary = options;
      else if (options && typeof options.binary === 'boolean') binary = options.binary;

      var sent = this.app._send(Protocol.encodeWebSocketData({
        wsRequestId: this.wsRequestId,
        data: bytes,
        binary: binary,
        timestamp: new Date().toISOString()
      }));
      if (sent) this.bytesSent += bytes.length;
      return sent;
    }

    sendText(text) { return this.send(text); }
    sendBinary(data) { return this.send(data, true); }

    close(code, reason) {
      if (this._closed) return;
      this.readyState = 2;
      var closeCode = code === undefined ? 1000 : Number(code);
      if (!isFinite(closeCode)) closeCode = 1000;
      this._finish(closeCode, reason || '', true);
    }

    terminate() {
      this.close(1000, 'terminated');
    }

    _handleMessage(message) {
      if (this._closed) return;
      var data = message.data || new Uint8Array(0);
      this.bytesReceived += data.length;
      var isBinary = !!message.isBinary;
      this.emit('message', isBinary ? data : textOf(data), isBinary);
    }

    _onServerClose(message) {
      var code = Number(message.code);
      if (!code || code < 1000) code = 1000;
      this._finish(code, message.reason || '', false);
    }

    _onServerEnd() {
      this._finish(1000, 'ended', false);
    }

    _onServerError(message) {
      this.emit('error', new SDKError(
        (message && message.error) || 'websocket error',
        { code: 'WS_PEER_ERROR' }
      ));
      this._finish(1011, (message && message.error) || 'websocket error', false);
    }

    _finish(code, reason, sendClose) {
      if (this._closed) return;
      this._closed = true;
      this.readyState = 3;
      this.open = false;

      var closeCode = code === undefined ? 1000 : Number(code);
      if (!isFinite(closeCode)) closeCode = 1000;

      if (sendClose) {
        // The tunnel protocol carries close codes in one byte. Normal close
        // (1000) is sent as 0 so the server maps it back to 1000 cleanly.
        var protocolCode = closeCode === 1000 ? 0 : (closeCode & 0xff);
        this.app._send(Protocol.encodeWebSocketClose({
          wsRequestId: this.wsRequestId,
          code: protocolCode,
          reason: reason || '',
          timestamp: new Date().toISOString()
        }));
      }

      this.app.wsConnections.delete(this.wsRequestId);
      this.emit('close', closeCode, reason || '');
    }

    _fail(error) {
      this.emit('error', error);
      this.close(1011, (error && error.message) || 'websocket handler error');
    }
  }

  WsConnection.OPEN = 1;
  WsConnection.CLOSING = 2;
  WsConnection.CLOSED = 3;

  class AgentApp extends Emitter {
    constructor(options) {
      super();
      options = options || {};
      var domain = String(options.domain || '').trim().toLowerCase();
      if (!domain || !DOMAIN_RE.test(domain)) {
        throw new SDKError('options.domain is required, e.g. agent-xxxx.html.dtns.top', { code: 'INVALID_DOMAIN' });
      }
      this.domain = domain;
      this.apiBase = 'http://' + domain;
      this.wsUrl = options.wsUrl || DEFAULT_WS_URL;
      this.clientId = options.clientId || ('sdk-' + randomHex(6));
      this.token = options.token ? String(options.token).trim() : '';
      this.WebSocket = options.WebSocket || null;
      this.description = options.description || 'sdk.js app';
      this.localPort = options.localPort || 80;
      this.maxBodySize = options.maxBodySize || 1024 * 1024;
      this.heartbeatInterval = options.heartbeatInterval || 25000;
      this.reconnect = options.reconnect !== false;
      this.exposeErrors = !!options.exposeErrors;

      this.routes = [];
      this.middlewares = [];
      this.wsRoutes = [];
      this.wsConnections = new Map();
      this.socket = null;
      this.ready = null;
      this.connected = false;
      this.registered = false;
      this.closed = false;
      this.listening = false;
      this.serverVersion = 2;
      this.requests = 0;
      this.errors = 0;
      this.reconnects = 0;
      this.startedAt = 0;
      this.heartbeatTimer = null;
      this.reconnectTimer = null;
      this._resolveReady = null;
      this._rejectReady = null;
    }

    // ==================== routing ====================

    _route(method, path, handler) {
      if (typeof handler !== 'function') {
        throw new SDKError(method + ' ' + path + ' handler must be a function', { code: 'INVALID_HANDLER' });
      }
      var normalized = normalizePath(path);
      this.routes.push({
        method: method,
        path: normalized,
        matcher: compilePath(normalized),
        handler: handler
      });
      return this;
    }

    get(path, handler) { return this._route('GET', path, handler); }
    post(path, handler) { return this._route('POST', path, handler); }
    put(path, handler) { return this._route('PUT', path, handler); }
    patch(path, handler) { return this._route('PATCH', path, handler); }
    delete(path, handler) { return this._route('DELETE', path, handler); }
    head(path, handler) { return this._route('HEAD', path, handler); }
    options(path, handler) { return this._route('OPTIONS', path, handler); }
    all(path, handler) { return this._route('ALL', path, handler); }

    ws(path, handler) {
      if (typeof handler !== 'function') {
        throw new SDKError('ws ' + path + ' handler must be a function', { code: 'INVALID_HANDLER' });
      }
      var normalized = normalizePath(path);
      this.wsRoutes.push({
        path: normalized,
        matcher: compilePath(normalized),
        handler: handler
      });
      return this;
    }

    use(pathOrFn, fn) {
      var prefix = '';
      var handler = pathOrFn;
      if (typeof pathOrFn === 'string') {
        prefix = normalizePath(pathOrFn);
        handler = fn;
      }
      if (typeof handler !== 'function') {
        throw new SDKError('middleware must be a function', { code: 'INVALID_MIDDLEWARE' });
      }
      this.middlewares.push({ path: prefix, fn: handler });
      return this;
    }

    listRoutes() {
      var httpRoutes = this.routes.map(function (route) {
        return { method: route.method, path: route.path };
      });
      var wsRoutes = this.wsRoutes.map(function (route) {
        return { method: 'WS', path: route.path };
      });
      return httpRoutes.concat(wsRoutes);
    }

    // ==================== lifecycle ====================

    listen() {
      if (this.ready) return this.ready;
      if (this.closed) {
        return Promise.reject(new SDKError('app is closed', { code: 'APP_CLOSED' }));
      }
      var self = this;
      this.startedAt = now();
      this.ready = new Promise(function (resolve, reject) {
        self._resolveReady = resolve;
        self._rejectReady = reject;
      });
      this._connect();
      return this.ready;
    }

    close() {
      this.closed = true;
      this.connected = false;
      this.registered = false;
      this._closeAllWs(1000, 'app closed');
      this._stopHeartbeat();
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      if (this._rejectReady && !this.listening) {
        try { this._rejectReady(new SDKError('app closed before listening', { code: 'APP_CLOSED' })); } catch (e) { /* ignore */ }
      }
      var ws = this.socket;
      this.socket = null;
      if (ws) {
        try { ws.close(1000, 'sdk app closed'); } catch (error) { /* ignore */ }
      }
      this.emit('close', this.status());
    }

    status() {
      return {
        connected: this.connected,
        registered: this.registered,
        domain: this.domain,
        apiBase: this.apiBase,
        clientId: this.clientId,
        auth: this.token ? 'bearer' : 'url',
        requests: this.requests,
        errors: this.errors,
        reconnects: this.reconnects,
        startedAt: this.startedAt,
        uptimeMs: this.startedAt ? now() - this.startedAt : 0,
        routes: this.routes.length,
        wsRoutes: this.wsRoutes.length,
        websockets: this.wsConnections.size,
        middlewares: this.middlewares.length
      };
    }

    // ==================== tunnel ====================

    _connect() {
      if (this.closed) return;
      var WS = this.WebSocket || (typeof WebSocket !== 'undefined' ? WebSocket : null);
      if (!WS) {
        this._failInitial(new SDKError(
          'WebSocket is not available; pass options.WebSocket (e.g. require("ws"))',
          { code: 'NO_WEBSOCKET' }
        ));
        return;
      }

      var self = this;
      var url = this.wsUrl + (this.wsUrl.indexOf('?') === -1 ? '?' : '&') +
        'clientId=' + encodeURIComponent(this.clientId);
      var ws;
      try { ws = new WS(url); }
      catch (error) {
        this._failInitial(new SDKError('WebSocket constructor failed: ' + error.message, {
          code: 'WS_INIT_FAILED', cause: error
        }));
        return;
      }

      this.socket = ws;
      try { ws.binaryType = 'arraybuffer'; } catch (error) { /* ignore */ }

      ws.onopen = function () {
        if (self.socket !== ws) return;
        self.connected = true;
        self.emit('open', self.status());
        self._sendCapabilities();
        self._sendRegister();
        self._startHeartbeat();
      };

      ws.onmessage = function (event) {
        if (self.socket !== ws) return;
        self._onMessage(event && event.data !== undefined ? event.data : event);
      };

      ws.onerror = function () {
        if (self.socket !== ws) return;
        self.emit('error', new SDKError('WebSocket error', { code: 'WS_ERROR' }));
      };

      ws.onclose = function (event) {
        if (self.socket !== ws) return;
        self.socket = null;
        self._onClose(event || {});
      };
    }

    _onMessage(data) {
      var frame;
      try {
        frame = Protocol.decodeFrame(data);
      } catch (error) {
        this.emit('error', new SDKError('Frame decode failed: ' + error.message, { code: 'FRAME_DECODE_ERROR', cause: error }));
        return;
      }

      var message = Protocol.decodeMessage(frame);
      if (message.type === 'welcome') {
        this.serverVersion = message.protocolVersion || 1;
        return;
      }
      if (message.type === 'registered') {
        this._onRegistered(message);
        return;
      }
      if (message.type === 'http_request') {
        this._handleRequest(message);
        return;
      }
      if (message.type === 'websocket_data' || message.type === 'websocket_data_from_server') {
        var dataConnection = this.wsConnections.get(message.wsRequestId);
        if (dataConnection) dataConnection._handleMessage(message);
        return;
      }
      if (message.type === 'websocket_close' || message.type === 'websocket_close_from_server') {
        var closeConnection = this.wsConnections.get(message.wsRequestId);
        if (closeConnection) closeConnection._onServerClose(message);
        return;
      }
      if (message.type === 'heartbeat_ack') return;
    }

    _onRegistered(message) {
      if (message.success) {
        this.registered = true;
        this.reconnects = 0;
        var first = !this.listening;
        this.listening = true;
        if (first && this._resolveReady) {
          try { this._resolveReady(this); } catch (error) { /* ignore */ }
        }
        this.emit(first ? 'listening' : 'reconnected', this.status());
        return;
      }

      var error = new SDKError(message.error || 'tunnel registration failed', {
        code: 'REGISTER_FAILED'
      });
      if (!this.listening) {
        this._failInitial(error);
        return;
      }
      this.registered = false;
      this.emit('error', error);
      this._scheduleReconnect();
    }

    _onClose(event) {
      this.connected = false;
      this.registered = false;
      this._closeAllWs(1000, 'tunnel disconnected');
      this._stopHeartbeat();
      if (this.closed) return;
      this.emit('disconnected', { code: event.code || 0, reason: event.reason || '' });
      if (this.reconnect) this._scheduleReconnect();
      else this.emit('close', this.status());
    }

    _scheduleReconnect() {
      if (this.closed || !this.reconnect || this.reconnectTimer) return;
      var self = this;
      this.reconnects += 1;
      var delay = Math.min(1500 * Math.pow(1.7, this.reconnects - 1), 20000);
      this.emit('reconnecting', { attempt: this.reconnects, delay: delay });
      this.reconnectTimer = setTimeout(function () {
        self.reconnectTimer = null;
        self._connect();
      }, delay);
    }

    _failInitial(error) {
      this.closed = true;
      this.connected = false;
      this.registered = false;
      this._closeAllWs(1000, 'tunnel failed');
      this._stopHeartbeat();
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      if (this._rejectReady) {
        try { this._rejectReady(error); } catch (e) { /* ignore */ }
      }
      var ws = this.socket;
      this.socket = null;
      if (ws) {
        try { ws.close(4000, 'sdk registration failed'); } catch (e) { /* ignore */ }
      }
      this.emit('error', error);
    }

    _send(frame) {
      if (!this.socket || this.socket.readyState !== 1) return false;
      try { this.socket.send(frame); return true; }
      catch (error) {
        this.emit('error', new SDKError('WebSocket send failed: ' + error.message, { code: 'WS_SEND_FAILED', cause: error }));
        return false;
      }
    }

    _sendCapabilities() {
      this._send(Protocol.encodeCapabilities({
        clientId: this.clientId,
        stream: false,
        multiValueHeaders: true
      }));
    }

    _sendRegister() {
      this._send(Protocol.encodeRegisterTunnel({
        clientId: this.clientId,
        tunnel: {
          id: 'sdk-app',
          domain: this.domain,
          localPort: this.localPort,
          localHost: '127.0.0.1',
          protocol: 'http',
          description: this.description
        }
      }));
    }

    _startHeartbeat() {
      this._stopHeartbeat();
      var self = this;
      this._sendHeartbeat();
      this.heartbeatTimer = setInterval(function () { self._sendHeartbeat(); }, this.heartbeatInterval);
    }

    _stopHeartbeat() {
      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
    }

    _sendHeartbeat() {
      if (!this.socket || this.socket.readyState !== 1) return;
      this._send(Protocol.encodeHeartbeat({
        clientId: this.clientId,
        timestamp: new Date().toISOString(),
        stats: {
          tunnelCount: 1,
          registeredCount: this.registered ? 1 : 0,
          sseConnections: 0,
          totalRequests: this.requests,
          totalErrors: this.errors
        }
      }));
    }

    // ==================== request handling ====================

    _handleRequest(message) {
      var self = this;
      var started = now();
      this.requests += 1;
      var req = new Request(message);
      var res = new Response(this, req, message, function (status) {
        self._after(req, status, started);
      });

      if (message.isWebSocket) {
        this._handleWebSocket(message, req, res);
        return;
      }

      if (message.isSSE) {
        res.status(501).json({
          ok: false,
          error: 'sse_not_supported',
          hint: 'sdk.js app handles plain HTTP requests only.'
        });
        return;
      }

      if (req.method === 'OPTIONS') {
        var optionsMatch = this._match('OPTIONS', req.path);
        if (!optionsMatch.route) {
          res.status(204).end();
          return;
        }
        req.params = optionsMatch.params;
        var optionsStack = [];
        this.middlewares.forEach(function (middleware) {
          if (matchesPrefix(req.path, middleware.path)) {
            optionsStack.push({ fn: middleware.fn, isRoute: false });
          }
        });
        optionsStack.push({ fn: optionsMatch.route.handler, isRoute: true });
        this._runStack(optionsStack, req, res);
        return;
      }

      if (this.token && !this._checkAuth(req)) {
        res.set('www-authenticate', 'Bearer realm="dtns-agent"');
        res.status(401).json({
          ok: false,
          error: 'unauthorized',
          hint: 'Send Authorization: Bearer <token>.'
        });
        return;
      }

      try {
        this._parseBody(req);
      } catch (error) {
        res.status(error.status || 400).json({
          ok: false,
          error: error.code || 'invalid_body'
        });
        return;
      }

      var found = this._match(req.method, req.path);
      if (!found.route) {
        if (found.allowed.length) {
          var allow = this._allowHeader(found.allowed);
          res.set('allow', allow);
          res.status(405).json({
            ok: false,
            error: 'method_not_allowed',
            allow: allow
          });
        } else {
          res.status(404).json({
            ok: false,
            error: 'not_found',
            method: req.method,
            path: req.path
          });
        }
        return;
      }

      req.params = found.params;
      var stack = [];
      this.middlewares.forEach(function (middleware) {
        if (matchesPrefix(req.path, middleware.path)) {
          stack.push({ fn: middleware.fn, isRoute: false });
        }
      });
      stack.push({ fn: found.route.handler, isRoute: true });
      this._runStack(stack, req, res);
    }

    _handleWebSocket(message, req, res) {
      if (!message.wsRequestId) {
        res.status(400).json({ ok: false, error: 'missing_ws_request_id' });
        return;
      }
      if (this.token && !this._checkAuth(req)) {
        res.set('www-authenticate', 'Bearer realm="dtns-agent"');
        res.status(401).json({
          ok: false,
          error: 'unauthorized',
          hint: 'Send Authorization: Bearer <token>, or use ?token= for browser WebSocket.'
        });
        return;
      }
      if (req.method !== 'GET') {
        res.set('allow', 'GET');
        res.status(405).json({ ok: false, error: 'method_not_allowed', allow: 'GET' });
        return;
      }

      var found = this._matchWs(req.path);
      if (!found) {
        res.status(404).json({
          ok: false,
          error: 'websocket_route_not_found',
          path: req.path
        });
        return;
      }

      req.params = found.params;
      var offered = String(req.get('sec-websocket-protocol') || '')
        .split(',').map(function (value) { return value.trim(); }).filter(Boolean);
      var protocol = offered[0] || '';
      var headers = protocol ? { 'sec-websocket-protocol': protocol } : {};

      res.acceptWebSocket(headers);
      var connection = new WsConnection(this, message, req, protocol);
      this.wsConnections.set(message.wsRequestId, connection);
      this.emit('websocket', {
        path: req.path,
        wsRequestId: message.wsRequestId,
        remoteAddress: req.remoteAddress,
        protocol: protocol
      });

      try {
        var result = found.route.handler(connection, req);
        if (isPromise(result)) {
          result.catch(function (error) { connection._fail(error); });
        }
      } catch (error) {
        connection._fail(error);
      }
    }

    _matchWs(path) {
      for (var i = 0; i < this.wsRoutes.length; i++) {
        var route = this.wsRoutes[i];
        var params = matchPath(route.matcher, path);
        if (params) return { route: route, params: params };
      }
      return null;
    }

    _acceptWebSocket(message, headers) {
      return this._sendResponse(message, 101, headers || {}, new Uint8Array(0));
    }

    _closeAllWs(code, reason) {
      var self = this;
      this.wsConnections.forEach(function (connection) {
        connection._finish(code || 1000, reason || '', false);
      });
      this.wsConnections.clear();
    }

    _parseBody(req) {
      var bytes = req.rawBody || new Uint8Array(0);
      if (bytes.length > this.maxBodySize) {
        var tooLarge = new SDKError('payload too large', { code: 'payload_too_large', status: 413 });
        throw tooLarge;
      }
      if (!bytes.length) {
        req.body = undefined;
        return;
      }
      var type = String(req.get('content-type') || '');
      if (/application\/json/i.test(type)) {
        try { req.body = JSON.parse(textOf(bytes)); }
        catch (error) {
          throw new SDKError('invalid JSON body', { code: 'invalid_json', status: 400 });
        }
      } else if (/application\/x-www-form-urlencoded/i.test(type)) {
        req.body = parseQuery('?' + textOf(bytes));
      } else if (/^text\//i.test(type)) {
        req.body = textOf(bytes);
      } else {
        req.body = bytes;
      }
    }

    _checkAuth(req) {
      var authorization = String(req.get('authorization') || '');
      var match = /^Bearer\s+(.+)$/i.exec(authorization);
      if (match && match[1].trim() === this.token) return true;
      if (req.query && req.query.token === this.token) return true;
      return false;
    }

    _match(method, path) {
      var allowed = [];
      for (var i = 0; i < this.routes.length; i++) {
        var route = this.routes[i];
        var params = matchPath(route.matcher, path);
        if (!params) continue;
        var methodOk = route.method === 'ALL' || route.method === method ||
          (method === 'HEAD' && route.method === 'GET');
        if (methodOk) return { route: route, params: params };
        if (route.method !== 'ALL' && allowed.indexOf(route.method) === -1) {
          allowed.push(route.method);
        }
      }
      return { route: null, params: null, allowed: allowed };
    }

    _allowHeader(allowed) {
      var methods = allowed.slice();
      if (methods.indexOf('GET') !== -1 && methods.indexOf('HEAD') === -1) methods.push('HEAD');
      if (methods.indexOf('OPTIONS') === -1) methods.push('OPTIONS');
      return methods.join(', ');
    }

    _runStack(stack, req, res) {
      var self = this;
      var completed = false;

      function finish() { completed = true; }

      function fail(error) {
        if (res.finished) { finish(); return; }
        var status = error && isValidStatus(error.status) ? error.status : 500;
        var code = error && error.code ? String(error.code) : (status === 500 ? 'internal_error' : 'error');
        var body = { ok: false, error: code };
        if (error && error.message && (self.exposeErrors || status !== 500)) {
          body.message = String(error.message);
        }
        res.status(status).json(body);
        finish();
        self.emit('error', error instanceof Error ? error : new SDKError(String(error), {
          code: code, status: status
        }));
      }

      function run(index) {
        if (completed || res.finished) { finish(); return; }
        if (index >= stack.length) {
          if (!res.finished) res.status(204).end();
          finish();
          return;
        }

        var entry = stack[index];
        var called = false;

        function next(error) {
          if (called) return;
          called = true;
          if (res.finished) { finish(); return; }
          if (error) { fail(error); return; }
          run(index + 1);
        }

        try {
          var returned = entry.fn(req, res, next);
          if (isPromise(returned)) {
            returned.then(function (value) {
              if (res.finished) { finish(); return; }
              if (!called) {
                if (entry.isRoute && value !== undefined) {
                  sendAuto(res, value);
                  finish();
                } else {
                  next();
                }
              }
            }, function (error) {
              if (!called) {
                called = true;
                fail(error);
              }
            });
          } else if (!called) {
            if (res.finished) { finish(); return; }
            if (entry.isRoute && returned !== undefined) {
              sendAuto(res, returned);
              finish();
            } else {
              next();
            }
          }
        } catch (error) {
          if (!called) {
            called = true;
            fail(error);
          }
        }
      }

      function sendAuto(response, value) {
        if (response.finished) return;
        if (value === undefined) { response.status(204).end(); return; }
        if (value === null) { response.json(null); return; }
        if (typeof value === 'string') { response.text(value); return; }
        if (value instanceof Uint8Array) { response.send(value); return; }
        response.json(value);
      }

      run(0);
    }

    _sendResponse(message, status, headers, body) {
      if (!this.socket || this.socket.readyState !== 1) {
        this.emit('error', new SDKError('WebSocket is not open', { code: 'WS_NOT_OPEN' }));
        return false;
      }
      if (!isValidStatus(status)) status = 200;

      var clean = {};
      Object.keys(headers || {}).forEach(function (key) {
        if (headers[key] !== undefined && headers[key] !== null) {
          clean[String(key).toLowerCase()] = String(headers[key]);
        }
      });

      var frame = Protocol.encodeHttpResponse({
        requestId: message.requestId,
        domain: message.domain,
        status: status,
        headers: clean,
        body: body || new Uint8Array(0),
        isSSE: false,
        sseRequestId: message.sseRequestId || null,
        isWebSocket: !!message.isWebSocket,
        wsRequestId: message.wsRequestId || null,
        error: null
      }, this.serverVersion);

      if (!this._send(frame)) return false;
      return true;
    }

    _after(req, status, started) {
      if (status >= 500) this.errors += 1;
      this.emit('request', {
        method: req.method,
        path: req.path,
        status: status,
        ms: Math.round(now() - started),
        requestId: req.requestId
      });
    }
  }

  var DTNSAgent = {
    version: VERSION,
    app: function (options) { return new AgentApp(options); },
    createApp: function (options) { return new AgentApp(options); },
    App: AgentApp,
    Error: SDKError
  };

  DTNSAgent.DTNSAgent = DTNSAgent;
  return DTNSAgent;
}

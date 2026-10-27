#!/usr/bin/env node
/**
 * dtns.http-proxy — project site server
 *
 * Zero dependency static server for the introduction site.
 * Also exposes read-only, sanitised metadata:
 *   GET /healthz      liveness probe
 *   GET /api/status   uptime / node version / tunnel count
 *   GET /api/tunnels  enabled tunnels from client/config.js (no local ports)
 *
 * Usage:
 *   node server.js            # 127.0.0.1:3016
 *   PORT=8080 node server.js  # custom port
 *   DTNS_CONFIG=/path/config.js node server.js
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 3016;
const HOST = process.env.HOST || '127.0.0.1';
const STARTED_AT = Date.now();
const CONFIG_PATH = path.resolve(
  process.env.DTNS_CONFIG || path.join(ROOT, '..', 'client', 'config.js')
);
const ASSET_CACHE_LIMIT = 64;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2'
};

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; " +
    "connect-src 'self' wss://res2.dtns.top ws://*.html.dtns.top wss://*.html.dtns.top http://*.html.dtns.top https://*.html.dtns.top; " +
    "font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()'
};

const assetCache = new Map();

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function sendJson(req, res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, Object.assign({}, SECURITY_HEADERS, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store'
  }));
  res.end(req.method === 'HEAD' ? undefined : body);
}

function sendText(req, res, status, text) {
  const body = Buffer.from(text);
  res.writeHead(status, Object.assign({}, SECURITY_HEADERS, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store'
  }));
  res.end(req.method === 'HEAD' ? undefined : body);
}

/**
 * Read client/config.js and return only public-safe fields.
 * Returns null when the config is missing or cannot be evaluated.
 */
function readTunnels() {
  try {
    const resolved = require.resolve(CONFIG_PATH);
    delete require.cache[resolved];
    const config = require(resolved);
    if (!config || !Array.isArray(config.tunnels)) return [];

    return config.tunnels
      .filter((tunnel) => tunnel && tunnel.enabled !== false && tunnel.domain)
      .map((tunnel) => ({
        id: String(tunnel.id || ''),
        domain: String(tunnel.domain),
        description: String(tunnel.description || '')
      }));
  } catch (error) {
    log('[config] cannot read tunnels:', error.message);
    return null;
  }
}

function contentType(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function getAsset(filePath) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (error) {
    return null;
  }
  if (!stat.isFile()) return null;

  const key = filePath + ':' + stat.mtimeMs + ':' + stat.size;
  const cached = assetCache.get(key);
  if (cached) return cached;

  const buffer = fs.readFileSync(filePath);
  const asset = {
    buffer,
    gzip: buffer.length > 1024 ? zlib.gzipSync(buffer, { level: 6 }) : null,
    etag: 'W/"' + stat.size.toString(16) + '-' + Math.floor(stat.mtimeMs).toString(16) + '"',
    lastModified: stat.mtime.toUTCString(),
    type: contentType(filePath),
    cacheControl: path.extname(filePath).toLowerCase() === '.html'
      ? 'no-cache'
      : 'public, max-age=600'
  };

  if (assetCache.size >= ASSET_CACHE_LIMIT) assetCache.clear();
  assetCache.set(key, asset);
  return asset;
}

function serveFile(req, res, filePath, status) {
  const asset = getAsset(filePath);
  if (!asset) return serveNotFound(req, res);

  const headers = Object.assign({}, SECURITY_HEADERS, {
    'Content-Type': asset.type,
    'Cache-Control': status === 200 ? asset.cacheControl : 'no-cache',
    'ETag': asset.etag,
    'Last-Modified': asset.lastModified,
    'Vary': 'Accept-Encoding'
  });

  if (status === 200 && req.headers['if-none-match'] === asset.etag) {
    res.writeHead(304, {
      'ETag': asset.etag,
      'Cache-Control': asset.cacheControl,
      'Vary': 'Accept-Encoding'
    });
    return res.end();
  }

  const acceptsGzip = /\bgzip\b/i.test(String(req.headers['accept-encoding'] || ''));
  const body = acceptsGzip && asset.gzip ? asset.gzip : asset.buffer;
  if (acceptsGzip && asset.gzip) headers['Content-Encoding'] = 'gzip';
  headers['Content-Length'] = body.length;

  res.writeHead(status, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
}

function serveNotFound(req, res) {
  const page = getAsset(path.join(ROOT, '404.html'));
  if (!page) {
    return sendText(req, res, 404, '404 Not Found');
  }

  const headers = Object.assign({}, SECURITY_HEADERS, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': page.buffer.length,
    'Cache-Control': 'no-cache'
  });
  if (/gzip/i.test(String(req.headers['accept-encoding'] || '')) && page.gzip) {
    headers['Content-Encoding'] = 'gzip';
    headers['Content-Length'] = page.gzip.length;
    res.writeHead(404, headers);
    return res.end(req.method === 'HEAD' ? undefined : page.gzip);
  }
  res.writeHead(404, headers);
  res.end(req.method === 'HEAD' ? undefined : page.buffer);
}

function resolveRequestPath(pathname) {
  if (pathname === '/' || pathname === '') return 'index.html';

  let relative = pathname.replace(/^\/+/, '');
  if (relative.includes('\0')) return null;
  if (relative.endsWith('/')) relative += 'index.html';

  const segments = relative.split('/');
  if (segments.some((segment) => segment.startsWith('.'))) return null;

  const resolved = path.resolve(ROOT, relative);
  if (resolved !== ROOT && !resolved.startsWith(ROOT + path.sep)) return null;
  if (resolved === ROOT) return 'index.html';
  return path.relative(ROOT, resolved);
}

const server = http.createServer((req, res) => {
  const started = process.hrtime.bigint();
  const method = req.method || 'GET';
  let pathname = '/';

  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    log(method, pathname, res.statusCode, ms.toFixed(1) + 'ms');
  });

  if (method !== 'GET' && method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return sendText(req, res, 405, 'Method Not Allowed');
  }

  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch (error) {
    return sendText(req, res, 400, 'Bad Request');
  }

  if (pathname === '/healthz') {
    return sendJson(req, res, 200, {
      ok: true,
      service: 'dtns-http-proxy-site',
      uptimeSeconds: Math.floor(process.uptime())
    });
  }

  if (pathname === '/api/status') {
    const tunnels = readTunnels();
    return sendJson(req, res, 200, {
      ok: true,
      site: 'dtns-http-proxy',
      uptimeSeconds: Math.floor(process.uptime()),
      startedAt: new Date(STARTED_AT).toISOString(),
      node: process.version,
      tunnels: tunnels ? tunnels.length : null,
      serverTime: new Date().toISOString()
    });
  }

  if (pathname === '/api/tunnels') {
    const tunnels = readTunnels();
    if (!tunnels) {
      return sendJson(req, res, 503, {
        ok: false,
        error: 'client config unavailable',
        count: 0
      });
    }
    return sendJson(req, res, 200, {
      ok: true,
      count: tunnels.length,
      updatedAt: new Date().toISOString()
    });
  }

  const relative = resolveRequestPath(pathname);
  if (!relative) return serveNotFound(req, res);

  return serveFile(req, res, path.join(ROOT, relative), 200);
});

server.on('clientError', (error, socket) => {
  if (!socket.writable) return;
  socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error('Port ' + PORT + ' is already in use. Set PORT to another value.');
  } else {
    console.error('Server error:', error);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const tunnels = readTunnels();
  console.log('');
  console.log('  DTNS HTTP Proxy — project site');
  console.log('  listening   http://' + HOST + ':' + PORT + '/');
  console.log('  config      ' + CONFIG_PATH);
  console.log('  tunnels     ' + (tunnels ? tunnels.length + ' enabled' : 'unavailable'));
  console.log('');
});

function shutdown(signal) {
  console.log('\n' + signal + ' received, closing server...');
  server.close(() => process.exit(0));
  windowlessExit();
}

function windowlessExit() {
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

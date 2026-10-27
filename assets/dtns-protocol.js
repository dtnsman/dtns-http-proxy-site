/**
 * DTNS protocol — browser-side codec
 *
 * A dependency-free port of client/protocol.js covering the frames needed by
 * a browser tunnel client:
 *   client -> server : register_tunnel, unregister_tunnel, capabilities,
 *                      heartbeat, http_response, websocket_data, websocket_close
 *   server -> client : welcome, registered, heartbeat_ack, http_request,
 *                      websocket_data, websocket_close
 *
 * It works in the browser (window.DTNSProtocol) and in Node (module.exports),
 * so the same implementation can be exercised by the protocol test script.
 *
 * Frame layout (all integers big-endian):
 *   magic 4B "DTNS" | version 1B | type 2B | flags 2B | length 4B | payload
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.DTNSProtocol = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MAGIC = [0x44, 0x54, 0x4e, 0x53]; // "DTNS"
  var VERSION = 1;
  var VERSION_2 = 2;

  var TYPE = {
    REGISTER_TUNNEL: 0x0001,
    UNREGISTER_TUNNEL: 0x0002,
    HEARTBEAT: 0x0003,
    HTTP_RESPONSE: 0x0004,
    TUNNEL_LIST: 0x0005,
    COMMAND_RESPONSE: 0x0006,
    STATS: 0x0007,
    SSE_DATA: 0x0008,
    SSE_END: 0x0009,
    SSE_ERROR: 0x000a,
    SSE_CLOSE: 0x000b,
    WEBSOCKET_UPGRADED: 0x000c,
    WEBSOCKET_DATA: 0x000d,
    WEBSOCKET_END: 0x000e,
    WEBSOCKET_ERROR: 0x000f,
    WEBSOCKET_CLOSE: 0x0010,
    SSE_CONNECTIONS: 0x0011,
    ERROR: 0x0012,
    STREAM_OPEN: 0x0020,
    STREAM_CHUNK: 0x0021,
    STREAM_END: 0x0022,
    STREAM_ACK: 0x0023,
    STREAM_CANCEL: 0x0024,
    CAPABILITIES: 0x0025,
    WELCOME: 0x0101,
    REGISTERED: 0x0102,
    UNREGISTERED: 0x0103,
    HEARTBEAT_ACK: 0x0104,
    HTTP_REQUEST: 0x0105,
    TUNNEL_STATUS: 0x0106,
    COMMAND: 0x0107,
    WEBSOCKET_DATA_FROM_SERVER: 0x0108,
    WEBSOCKET_CLOSE_FROM_SERVER: 0x0109,
    SSE_DATA_FROM_SERVER: 0x010a,
    SSE_END_FROM_SERVER: 0x010b,
    SSE_ERROR_FROM_SERVER: 0x010c,
    SSE_CLOSE_FROM_SERVER: 0x010d
  };

  var TYPE_NAME = {};
  Object.keys(TYPE).forEach(function (name) {
    TYPE_NAME[TYPE[name]] = name.toLowerCase();
  });

  var FLAGS = {
    HAS_BODY: 0x0001,
    HAS_HEADERS: 0x0002,
    IS_SSE: 0x0004,
    IS_WEBSOCKET: 0x0008,
    GZIPPED: 0x0010,
    IS_BINARY: 0x0020
  };

  var encoder = new TextEncoder();
  var decoder = new TextDecoder('utf-8');

  function utf8(text) {
    return encoder.encode(text == null ? '' : String(text));
  }

  function toBytes(input) {
    if (input == null) return new Uint8Array(0);
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) {
      return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    }
    return utf8(input);
  }

  function concat(parts) {
    var length = 0;
    var i;
    for (i = 0; i < parts.length; i++) length += parts[i].length;
    var output = new Uint8Array(length);
    var offset = 0;
    for (i = 0; i < parts.length; i++) {
      output.set(parts[i], offset);
      offset += parts[i].length;
    }
    return output;
  }

  function u8(value) {
    return new Uint8Array([value & 0xff]);
  }

  function u16(value) {
    var bytes = new Uint8Array(2);
    new DataView(bytes.buffer).setUint16(0, value & 0xffff);
    return bytes;
  }

  function u32(value) {
    var bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value >>> 0);
    return bytes;
  }

  function encodeString(value) {
    var bytes = utf8(value);
    return concat([u16(bytes.length), bytes]);
  }

  function encodeBuffer(value) {
    var bytes = toBytes(value);
    return concat([u32(bytes.length), bytes]);
  }

  function encodeHeaders(headers, multiValue) {
    headers = headers || {};
    var keys = Object.keys(headers).filter(function (key) {
      return headers[key] !== undefined && headers[key] !== null;
    });

    var parts = [u16(keys.length)];
    keys.forEach(function (key) {
      var value = headers[key];
      var text = Array.isArray(value)
        ? value.map(String).join(multiValue ? '\n' : ',')
        : String(value);
      parts.push(encodeString(key));
      parts.push(encodeString(text));
    });
    return concat(parts);
  }

  function Reader(bytes) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.offset = 0;
  }

  Reader.prototype.u8 = function () {
    var value = this.view.getUint8(this.offset);
    this.offset += 1;
    return value;
  };

  Reader.prototype.u16 = function () {
    var value = this.view.getUint16(this.offset);
    this.offset += 2;
    return value;
  };

  Reader.prototype.u32 = function () {
    var value = this.view.getUint32(this.offset);
    this.offset += 4;
    return value;
  };

  Reader.prototype.str = function () {
    var length = this.u16();
    var value = decoder.decode(this.bytes.subarray(this.offset, this.offset + length));
    this.offset += length;
    return value;
  };

  Reader.prototype.buf = function () {
    var length = this.u32();
    var value = this.bytes.slice(this.offset, this.offset + length);
    this.offset += length;
    return value;
  };

  Reader.prototype.headers = function () {
    var count = this.u16();
    var output = {};
    for (var i = 0; i < count; i++) {
      var key = this.str();
      var value = this.str();
      output[key] = value.indexOf('\n') >= 0 ? value.split('\n') : value;
    }
    return output;
  };

  Reader.prototype.remaining = function () {
    return this.bytes.length - this.offset;
  };

  function encodeFrame(typeName, payload, version, flags) {
    var typeCode = TYPE[String(typeName).toUpperCase()];
    if (typeCode === undefined) throw new Error('Unknown DTNS frame type: ' + typeName);

    var header = new Uint8Array(13);
    header.set(MAGIC, 0);
    header[4] = version === VERSION_2 ? VERSION_2 : VERSION;
    var view = new DataView(header.buffer);
    view.setUint16(5, typeCode);
    view.setUint16(7, flags || 0);
    view.setUint32(9, payload.length);
    return concat([header, payload]);
  }

  function decodeFrame(input) {
    var bytes = toBytes(input);
    if (bytes.length < 13) throw new Error('DTNS frame too short: ' + bytes.length);

    for (var i = 0; i < 4; i++) {
      if (bytes[i] !== MAGIC[i]) throw new Error('Invalid DTNS magic');
    }

    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var version = bytes[4];
    var typeCode = view.getUint16(5);
    var flags = view.getUint16(7);
    var length = view.getUint32(9);

    if (bytes.length < 13 + length) {
      throw new Error('DTNS frame truncated: need ' + (13 + length) + ', got ' + bytes.length);
    }

    return {
      version: version,
      typeCode: typeCode,
      type: TYPE_NAME[typeCode] || 'unknown_0x' + typeCode.toString(16),
      flags: flags,
      payload: bytes.slice(13, 13 + length),
      byteLength: bytes.length
    };
  }

  // ==================== client -> server ====================

  function encodeRegisterTunnel(fields) {
    var tunnel = fields.tunnel || fields;
    var payload = concat([
      encodeString(fields.clientId || ''),
      encodeString(tunnel.id || ''),
      encodeString(tunnel.domain || ''),
      u8((tunnel.localPort || 80) & 0xff),
      encodeString(tunnel.localHost || '127.0.0.1'),
      encodeString(tunnel.protocol || 'http'),
      encodeString(tunnel.description || '')
    ]);
    return encodeFrame('register_tunnel', payload, VERSION, 0);
  }

  function encodeUnregisterTunnel(fields) {
    var payload = concat([
      encodeString(fields.clientId || ''),
      encodeString(fields.domain || '')
    ]);
    return encodeFrame('unregister_tunnel', payload, VERSION, 0);
  }

  function encodeCapabilities(fields) {
    var flags = 0;
    if (fields.stream) flags |= 0x01;
    if (fields.multiValueHeaders) flags |= 0x02;
    var payload = concat([encodeString(fields.clientId || ''), u8(flags)]);
    return encodeFrame('capabilities', payload, VERSION, 0);
  }

  function encodeHeartbeat(fields) {
    var stats = fields.stats || {};
    var payload = concat([
      encodeString(fields.clientId || ''),
      encodeString(fields.timestamp || new Date().toISOString()),
      u32(stats.tunnelCount || 0),
      u32(stats.registeredCount || 0),
      u32(stats.sseConnections || 0),
      u32(stats.totalRequests || 0),
      u32(stats.totalErrors || 0)
    ]);
    return encodeFrame('heartbeat', payload, VERSION, 0);
  }

  function encodeHttpResponse(fields, version) {
    var v = version >= VERSION_2 ? VERSION_2 : VERSION;
    var status = Number(fields.status);
    if (!(status >= 100 && status <= 599)) status = 200;

    var body = toBytes(fields.body);
    var headers = fields.headers || {};
    var payloadFlags = 0;
    if (fields.isSSE) payloadFlags |= 0x01;
    if (fields.isWebSocket) payloadFlags |= 0x02;
    if (fields.error) payloadFlags |= 0x04;

    var payload = concat([
      encodeString(fields.requestId || ''),
      encodeString(fields.domain || ''),
      v >= VERSION_2 ? u16(status) : u8(status),
      encodeHeaders(headers, true),
      encodeBuffer(body),
      u8(payloadFlags),
      encodeString(fields.sseRequestId || ''),
      encodeString(fields.wsRequestId || ''),
      encodeString(fields.error || '')
    ]);

    var frameFlags = 0;
    if (body.length) frameFlags |= FLAGS.HAS_BODY;
    if (Object.keys(headers).length) frameFlags |= FLAGS.HAS_HEADERS;
    if (fields.isSSE) frameFlags |= FLAGS.IS_SSE;
    if (fields.isWebSocket) frameFlags |= FLAGS.IS_WEBSOCKET;

    return encodeFrame('http_response', payload, v, frameFlags);
  }

  function encodeWebSocketData(fields) {
    var data = toBytes(fields.data);
    var payload = concat([
      encodeString(fields.wsRequestId || ''),
      encodeBuffer(data),
      encodeString(fields.timestamp || new Date().toISOString())
    ]);
    var flags = fields.binary ? FLAGS.IS_BINARY : 0;
    return encodeFrame('websocket_data', payload, VERSION, flags);
  }

  function encodeWebSocketClose(fields) {
    var code = fields.code === undefined ? 1000 : Number(fields.code);
    if (!isFinite(code)) code = 1000;
    var payload = concat([
      encodeString(fields.wsRequestId || ''),
      u8(code & 0xff),
      encodeString(fields.reason || ''),
      encodeString(fields.timestamp || new Date().toISOString())
    ]);
    return encodeFrame('websocket_close', payload, VERSION, 0);
  }

  // ==================== server -> client ====================

  function decodeWelcome(payload) {
    var reader = new Reader(payload);
    var clientId = reader.str();
    var timestamp = reader.str();
    var message = reader.str();
    var protocolVersion = reader.remaining() > 0 ? reader.u8() : VERSION;
    return {
      type: 'welcome',
      clientId: clientId,
      timestamp: timestamp,
      message: message,
      protocolVersion: protocolVersion
    };
  }

  function decodeRegistered(payload) {
    var reader = new Reader(payload);
    var domain = reader.str();
    var success = reader.u8() === 1;
    var error = reader.str();
    var message = reader.str();
    return {
      type: 'registered',
      domain: domain,
      success: success,
      error: error || null,
      message: message
    };
  }

  function decodeHttpRequest(payload) {
    var reader = new Reader(payload);
    var requestId = reader.str();
    var domain = reader.str();
    var method = reader.str();
    var url = reader.str();
    var headers = reader.headers();
    var body = reader.buf();
    var remoteAddress = reader.str();
    var timestamp = reader.str();
    var flags = reader.u8();
    var sseRequestId = reader.str();
    var wsRequestId = reader.str();

    return {
      type: 'http_request',
      requestId: requestId,
      domain: domain,
      method: method,
      url: url,
      headers: headers,
      body: body,
      remoteAddress: remoteAddress,
      timestamp: timestamp,
      isSSE: !!(flags & 0x01),
      isWebSocket: !!(flags & 0x02),
      sseRequestId: sseRequestId || null,
      wsRequestId: wsRequestId || null
    };
  }

  function decodeWebSocketData(payload, flags) {
    var reader = new Reader(payload);
    var wsRequestId = reader.str();
    var data = reader.buf();
    var timestamp = reader.str();
    return {
      type: 'websocket_data',
      wsRequestId: wsRequestId,
      data: data,
      isBinary: !!(flags & FLAGS.IS_BINARY),
      timestamp: timestamp
    };
  }

  function decodeWebSocketClose(payload) {
    var reader = new Reader(payload);
    var wsRequestId = reader.str();
    var code = reader.u8();
    var reason = reader.str();
    var timestamp = reader.str();
    return {
      type: 'websocket_close',
      wsRequestId: wsRequestId,
      code: code,
      reason: reason,
      timestamp: timestamp
    };
  }

  function decodeMessage(frame) {
    switch (frame.type) {
      case 'welcome':
        return decodeWelcome(frame.payload);
      case 'registered':
        return decodeRegistered(frame.payload);
      case 'http_request':
        return decodeHttpRequest(frame.payload);
      case 'heartbeat_ack':
        return { type: 'heartbeat_ack' };
      case 'websocket_data':
      case 'websocket_data_from_server':
        return decodeWebSocketData(frame.payload, frame.flags);
      case 'websocket_close':
      case 'websocket_close_from_server':
        return decodeWebSocketClose(frame.payload);
      default:
        return { type: frame.type, payload: frame.payload };
    }
  }

  return {
    MAGIC: MAGIC,
    VERSION: VERSION,
    VERSION_2: VERSION_2,
    TYPE: TYPE,
    TYPE_NAME: TYPE_NAME,
    FLAGS: FLAGS,
    utf8: utf8,
    toBytes: toBytes,
    encodeFrame: encodeFrame,
    decodeFrame: decodeFrame,
    decodeMessage: decodeMessage,
    encodeRegisterTunnel: encodeRegisterTunnel,
    encodeUnregisterTunnel: encodeUnregisterTunnel,
    encodeCapabilities: encodeCapabilities,
    encodeHeartbeat: encodeHeartbeat,
    encodeHttpResponse: encodeHttpResponse,
    encodeWebSocketData: encodeWebSocketData,
    encodeWebSocketClose: encodeWebSocketClose,
    decodeWebSocketData: decodeWebSocketData,
    decodeWebSocketClose: decodeWebSocketClose,
    decodeWelcome: decodeWelcome,
    decodeRegistered: decodeRegistered,
    decodeHttpRequest: decodeHttpRequest
  };
});

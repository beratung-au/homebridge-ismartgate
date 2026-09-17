'use strict';

// Local, read-only iSmartGate "info" protocol. See THIRD_PARTY_NOTICES.md.
const crypto = require('crypto');
const http = require('http');
const net = require('net');
const sax = require('sax');
const {URL, URLSearchParams} = require('url');

const MAX_RESPONSE_BYTES = 65536;
const TIMEOUT_MS = 5000;
const FIELDS = new Set(['model', 'firmwareversion', 'remoteaccess']);

function credentials(username, password) {
  if (typeof username !== 'string' || !username || typeof password !== 'string' || !password) {
    throw new Error('Device information requires the existing device login.');
  }
  const sha1 = value => crypto.createHash('sha1').update(value, 'utf8').digest('hex');
  const digest = sha1(username.toLowerCase() + password);
  return {
    key: Buffer.from(digest.slice(32, 36) + 'a' + digest.slice(7, 10) + '!' +
      digest.slice(18, 21) + '*#' + digest.slice(24, 26), 'utf8'),
    token: sha1(username.toLowerCase() + '@ismartgate')
  };
}

function encrypt(content, key, iv = crypto.randomBytes(8).toString('hex')) {
  const cipher = crypto.createCipheriv('aes-128-cbc', key, Buffer.from(iv, 'ascii'));
  return iv + Buffer.concat([cipher.update(content, 'utf8'), cipher.final()]).toString('base64');
}

function decrypt(content, key) {
  const iv = content.slice(0, 16);
  const encoded = content.slice(16);
  if (iv.length !== 16 || !/^[\x20-\x7e]{16}$/.test(iv) ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new Error('Invalid device information response.');
  }
  const encrypted = Buffer.from(encoded, 'base64');
  if (!encrypted.length || encrypted.length % 16 !== 0) throw new Error('Invalid encrypted response.');
  const cipher = crypto.createDecipheriv('aes-128-cbc', key, Buffer.from(iv, 'ascii'));
  return Buffer.concat([cipher.update(encrypted), cipher.final()]).toString('utf8');
}

function safeText(value) {
  if (typeof value !== 'string') return undefined;
  value = value.trim();
  return value && Buffer.byteLength(value, 'utf8') <= 64 &&
    !/[\x00-\x1f\x7f\ufffd]/.test(value) ? value : undefined;
}

function udiFromRemoteAccess(value) {
  if (!value) return undefined;
  try {
    const url = new URL(value.includes('://') ? value : 'https://' + value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) return undefined;
    const match = /^([a-f0-9]{10})\.isgaccess\.com$/i.exec(url.hostname);
    return match ? match[1].toLowerCase() : undefined;
  } catch (_) { return undefined; }
}

function parseInfo(xml) {
  if (typeof xml !== 'string' || Buffer.byteLength(xml, 'utf8') > MAX_RESPONSE_BYTES) {
    throw new Error('Invalid device information response.');
  }
  const parser = sax.parser(true, {trim: false, strictEntities: true});
  const stack = [], values = Object.create(null), seen = new Set();
  let rootSeen = false;
  parser.ondoctype = () => { throw new Error('Document types are not accepted.'); };
  parser.onopentag = node => {
    stack.push(node.name);
    if (stack.length > 32) throw new Error('Excessive XML nesting.');
    if (stack.length === 1) {
      if (rootSeen || node.name !== 'response') throw new Error('Unexpected response root.');
      rootSeen = true;
    }
    if (node.name === 'error') throw new Error('Device information request was rejected.');
    if (stack.length === 2 && FIELDS.has(node.name)) {
      if (seen.has(node.name)) throw new Error('Duplicate device information field.');
      seen.add(node.name);
      values[node.name] = '';
    }
    if (stack.length > 2 && FIELDS.has(stack[1])) throw new Error('Invalid device information field.');
  };
  const append = text => {
    if (stack.length === 2 && FIELDS.has(stack[1])) values[stack[1]] += text;
  };
  parser.ontext = append;
  parser.oncdata = append;
  parser.onclosetag = () => stack.pop();
  parser.write(xml).close();
  if (!rootSeen) throw new Error('Empty device information response.');
  const result = {};
  const model = safeText(values.model);
  const firmware = safeText(values.firmwareversion);
  const udi = udiFromRemoteAccess(values.remoteaccess);
  if (model) result.model = model;
  // Preserve numeric device revisions (including those reported without dots).
  if (firmware && /^\d+(?:\.\d+){0,2}(?:[-+][A-Za-z0-9.-]+)?$/.test(firmware)) result.firmware = firmware;
  if (udi) result.udi = udi;
  if (!Object.keys(result).length) throw new Error('No usable device information returned.');
  return result;
}

function fetchInfo(host, username, password, options = {}) {
  return new Promise((resolve, reject) => {
    let request, response, timer, finished = false;
    function finish(error, value) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (error) {
        // Do not propagate request URLs, credentials, tokens or raw responses.
        if (response) response.destroy();
        if (request) request.destroy();
        reject(new Error('Device information unavailable; sensor polling is unchanged.'));
      } else resolve(value);
    }
    try {
      if (!net.isIP(host)) throw new Error('A discovered IP address is required.');
      const auth = credentials(username, password);
      const query = new URLSearchParams({
        data: encrypt(JSON.stringify([username, password, 'info', '', '']), auth.key),
        token: auth.token,
        t: String(crypto.randomBytes(4).readUInt32BE(0) % 100000000 + 1)
      });
      timer = setTimeout(() => finish(new Error('Timeout')), options.timeoutMs || TIMEOUT_MS);
      // Core HTTP deliberately does not follow redirects, use a proxy or share login cookies.
      request = (options.get || http.get)({
        hostname: host, port: 80, method: 'GET', path: '/api.php?' + query,
        agent: false, headers: {Accept: 'text/plain, application/xml', 'Accept-Encoding': 'identity'}
      }, incoming => {
        response = incoming;
        if (finished) { incoming.destroy(); return; }
        if (incoming.statusCode !== 200) { finish(new Error('HTTP failure')); return; }
        let size = 0;
        const chunks = [];
        incoming.on('data', chunk => {
          if (finished) return;
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += buffer.length;
          if (size > MAX_RESPONSE_BYTES) { finish(new Error('Response too large')); return; }
          chunks.push(buffer);
        });
        incoming.on('error', finish);
        incoming.on('aborted', () => finish(new Error('Response aborted')));
        incoming.on('end', () => {
          if (finished) return;
          try {
            const body = Buffer.concat(chunks).toString('utf8').trim();
            // Success responses are encrypted. Plaintext API error messages are rejected.
            finish(null, parseInfo(decrypt(body, auth.key)));
          } catch (_) { finish(new Error('Invalid response')); }
        });
      });
      request.on('error', finish);
    } catch (_) { finish(new Error('Information lookup failed')); }
  });
}

module.exports = {fetchInfo, parseInfo, credentials, encrypt, decrypt, udiFromRemoteAccess};

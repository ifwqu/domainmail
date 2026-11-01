// MIME 解析与生成：纯 Buffer 操作，支持 multipart / RFC2047 / RFC2231 / 各类 transfer-encoding

const CRLF = '\r\n';

function splitHeaderBody(buf) {
  const s = buf.toString('latin1');
  let idx = s.indexOf('\r\n\r\n');
  let sepLen = 4;
  if (idx === -1) {
    idx = s.indexOf('\n\n');
    sepLen = 2;
  }
  if (idx === -1) return { headerText: s, body: Buffer.alloc(0) };
  return {
    headerText: s.slice(0, idx),
    body: Buffer.from(s.slice(idx + sepLen), 'latin1'),
  };
}

function unfold(text) {
  // 头部折行：以空白开头的续行合并到上一行
  return text.replace(/\r?\n[ \t]+/g, ' ');
}

export function parseHeaderLines(headerText) {
  const headers = [];
  for (const line of unfold(headerText).split(/\r?\n/)) {
    if (!line) continue;
    const i = line.indexOf(':');
    if (i <= 0) continue;
    headers.push({
      name: line.slice(0, i).trim(),
      value: line.slice(i + 1).trim(),
    });
  }
  return headers;
}

export function headerMap(headers) {
  const map = new Map();
  for (const h of headers) {
    const k = h.name.toLowerCase();
    if (map.has(k)) map.set(k, `${map.get(k)}, ${h.value}`);
    else map.set(k, h.value);
  }
  return map;
}

// ---- 头部值解码 ----
function decodeCharset(buf, charset) {
  const cs = (charset || 'utf-8').toLowerCase().replace(/^"|"$/g, '');
  const aliases = {
    'gb2312': 'gbk', 'gb_2312-80': 'gbk', 'x-gbk': 'gbk', 'cp936': 'gbk',
    'utf8': 'utf-8', 'latin1': 'iso-8859-1', 'us-ascii': 'iso-8859-1',
    'big5-hkscs': 'big5', 'ks_c_5601-1987': 'euc-kr',
  };
  const name = aliases[cs] || cs;
  try {
    return new TextDecoder(name, { fatal: false }).decode(buf);
  } catch {
    try {
      return new TextDecoder('utf-8', { fatal: false }).decode(buf);
    } catch {
      return buf.toString('latin1');
    }
  }
}

function decodeQuotedPrintableToBuffer(input) {
  const bytes = [];
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === '=') {
      const rest = input.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(rest)) {
        bytes.push(parseInt(rest, 16));
        i += 2;
        continue;
      }
      // 软换行 = CRLF 或 LF
      if (input[i + 1] === '\r' && input[i + 2] === '\n') { i += 2; continue; }
      if (input[i + 1] === '\n') { i += 1; continue; }
      bytes.push(0x3d);
      continue;
    }
    bytes.push(input.charCodeAt(i) & 0xff);
  }
  return Buffer.from(bytes);
}

function qpDecode(buf) {
  return decodeQuotedPrintableToBuffer(buf.toString('latin1'));
}

// RFC2047 encoded-word
export function decodeWords(value) {
  if (!value) return '';
  const str = String(value);
  if (!/=\?/.test(str)) {
    if (/[\u0080-\u00ff]/.test(str)) {
      // 可能是未编码的 8bit UTF-8（此前按 latin1 读出）
      const buf = Buffer.from(str, 'latin1');
      const utf8 = buf.toString('utf8');
      if (!utf8.includes('\uFFFD')) return utf8;
    }
    return str;
  }
  // 相邻 encoded-word 之间的空白要忽略
  const joined = str.replace(/\?=\s+=\?/g, '?==?');
  return joined.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (m, charset, enc, text) => {
    try {
      if (enc.toUpperCase() === 'B') {
        const buf = Buffer.from(text, 'base64');
        return decodeCharset(buf, charset);
      }
      const raw = text.replace(/_/g, ' ');
      const buf = decodeQuotedPrintableToBuffer(raw);
      return decodeCharset(buf, charset);
    } catch {
      return m;
    }
  });
}

// ---- Content-Type / Disposition 参数解析 ----
export function parseParams(value) {
  const out = {};
  const parts = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '"') { inQuote = !inQuote; cur += ch; continue; }
    if (ch === ';' && !inQuote) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur) parts.push(cur);
  const main = (parts.shift() || '').trim();
  for (const p of parts) {
    const i = p.indexOf('=');
    if (i < 0) continue;
    let k = p.slice(0, i).trim().toLowerCase();
    let v = p.slice(i + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1).replace(/\\(.)/g, '$1');
    // RFC2231: filename*=UTF-8''%E4%B8%AD
    if (k.endsWith('*')) {
      k = k.slice(0, -1);
      const m = /^([^']*)'[^']*'(.*)$/.exec(v);
      if (m) {
        try { v = decodeURIComponent(m[2]); } catch { v = m[2]; }
        out[k] = v;
        out[`${k}_charset`] = m[1];
        continue;
      }
    }
    if (out[k] === undefined) out[k] = v;
  }
  return { value: main, params: out };
}

export function parseContentType(value) {
  if (!value) return { type: 'text', subtype: 'plain', params: {} };
  const { value: main, params } = parseParams(value);
  const [type, subtype = 'plain'] = main.toLowerCase().split('/');
  return { type, subtype, params };
}

// ---- 地址解析 ----
export function parseAddressList(value) {
  if (!value) return [];
  const s = decodeWords(value);
  const out = [];
  let cur = '';
  let inQuote = false;
  let angle = 0;
  const push = (chunk) => {
    const t = chunk.trim();
    if (!t) return;
    const m = /^(.*?)<([^>]+)>\s*$/.exec(t);
    if (m) {
      let name = m[1].trim().replace(/^"|"$/g, '').trim();
      out.push({ name, address: m[2].trim().toLowerCase() });
    } else {
      const bare = t.replace(/^"|"$/g, '').trim();
      if (bare.includes('@')) out.push({ name: '', address: bare.toLowerCase() });
    }
  };
  for (const ch of s) {
    if (ch === '"') inQuote = !inQuote;
    if (ch === '<' && !inQuote) angle++;
    if (ch === '>' && !inQuote) angle = Math.max(0, angle - 1);
    if ((ch === ',' || ch === ';') && !inQuote && angle === 0) { push(cur); cur = ''; continue; }
    cur += ch;
  }
  push(cur);
  return out;
}

export function formatAddress({ name, address }) {
  if (!name) return address;
  const needsQuote = /[",;<>@\\]/.test(name);
  const enc = /^[\x20-\x7e]*$/.test(name) ? name : encodeWords(name);
  return needsQuote && enc === name ? `"${name.replace(/(["\\])/g, '\\$1')}" <${address}>` : `${enc} <${address}>`;
}

export function encodeWords(text) {
  if (/^[\x20-\x7e]*$/.test(text)) return text;
  const buf = Buffer.from(text, 'utf8');
  const chunks = [];
  for (let i = 0; i < buf.length; i += 45) {
    chunks.push(`=?UTF-8?B?${buf.subarray(i, i + 45).toString('base64')}?=`);
  }
  return chunks.join(' ');
}

function decodeTransfer(body, encoding) {
  const enc = (encoding || '7bit').toLowerCase().trim();
  if (enc === 'base64') {
    const s = body.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, '');
    try { return Buffer.from(s, 'base64'); } catch { return body; }
  }
  if (enc === 'quoted-printable') return qpDecode(body);
  return body;
}

function splitMultipart(body, boundary) {
  const s = body.toString('latin1');
  const parts = [];
  const marker = `--${boundary}`;
  let pos = 0;
  const positions = [];
  while (true) {
    const i = s.indexOf(marker, pos);
    if (i === -1) break;
    // 必须位于行首
    if (i === 0 || s[i - 1] === '\n') positions.push(i);
    pos = i + marker.length;
  }
  for (let k = 0; k < positions.length; k++) {
    const start = positions[k] + marker.length;
    const tail = s.slice(start, start + 2);
    if (tail.startsWith('--')) break; // 结束标记
    const nextStart = k + 1 < positions.length ? positions[k + 1] : s.length;
    let chunk = s.slice(start, nextStart);
    chunk = chunk.replace(/^[ \t]*\r?\n/, '');
    chunk = chunk.replace(/\r?\n$/, '');
    parts.push(Buffer.from(chunk, 'latin1'));
  }
  return parts;
}

function parseEntity(buf, depth = 0, out = { text: [], html: [], attachments: [] }) {
  if (depth > 12) return out;
  const { headerText, body } = splitHeaderBody(buf);
  const headers = parseHeaderLines(headerText);
  const map = headerMap(headers);

  const ctRaw = map.get('content-type') || 'text/plain; charset=utf-8';
  const ct = parseContentType(ctRaw);
  const dispRaw = map.get('content-disposition') || '';
  const disp = dispRaw ? parseParams(dispRaw) : { value: '', params: {} };
  const dispType = (disp.value || '').toLowerCase();
  const cte = map.get('content-transfer-encoding') || '7bit';
  const filename = decodeWords(disp.params.filename || ct.params.name || '');
  const contentId = (map.get('content-id') || '').replace(/^<|>$/g, '').trim();

  if (ct.type === 'multipart') {
    const boundary = ct.params.boundary;
    if (!boundary) return out;
    for (const part of splitMultipart(body, boundary)) parseEntity(part, depth + 1, out);
    return out;
  }

  if (ct.type === 'message' && ct.subtype === 'rfc822') {
    const decoded = decodeTransfer(body, cte);
    out.attachments.push({
      filename: filename || 'message.eml',
      mime: 'message/rfc822',
      content: decoded,
      contentId,
      inline: false,
    });
    return out;
  }

  const decoded = decodeTransfer(body, cte);
  const isText = ct.type === 'text';
  const charset = ct.params.charset || 'utf-8';

  if (isText && (ct.subtype === 'plain' || ct.subtype === 'html')) {
    const str = decodeCharset(decoded, charset);
    if (dispType === 'attachment' || (dispType === 'inline' && filename)) {
      out.attachments.push({
        filename: filename || `part.${ct.subtype}`,
        mime: `${ct.type}/${ct.subtype}`,
        content: decoded,
        contentId,
        inline: dispType === 'inline',
      });
    } else if (ct.subtype === 'plain') {
      out.text.push(str);
    } else {
      out.html.push(str);
    }
    return out;
  }

  if (isText) {
    // text/calendar 等
    const str = decodeCharset(decoded, charset);
    out.text.push(str);
    return out;
  }

  out.attachments.push({
    filename: filename || (contentId ? 'inline' : 'attachment.bin'),
    mime: `${ct.type}/${ct.subtype}`,
    content: decoded,
    contentId,
    inline: dispType === 'inline' || (!!contentId && !filename),
  });
  return out;
}

export function htmlToText(html) {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function parseMessage(rawBuf) {
  const buf = Buffer.isBuffer(rawBuf) ? rawBuf : Buffer.from(String(rawBuf), 'utf8');
  const { headerText, body } = splitHeaderBody(buf);
  const headers = parseHeaderLines(headerText);
  const map = headerMap(headers);
  const ct = parseContentType(map.get('content-type'));

  const collected = { text: [], html: [], attachments: [] };
  if (ct.type === 'multipart') {
    const boundary = ct.params.boundary;
    if (boundary) for (const part of splitMultipart(body, boundary)) parseEntity(part, 1, collected);
  } else {
    // 单部分：把整个原始邮件当实体解析
    parseEntity(buf, 0, collected);
  }

  const fromList = parseAddressList(map.get('from'));
  const from = fromList[0] || { name: '', address: '' };
  const to = parseAddressList(map.get('to'));
  const cc = parseAddressList(map.get('cc'));
  const replyTo = parseAddressList(map.get('reply-to'))[0] || null;

  let text = collected.text.join('\n').trim();
  let html = collected.html.join('\n').trim();
  if (!text && html) text = htmlToText(html);
  if (!html && text) html = '';

  const dateHeader = map.get('date');
  let date = Date.now();
  if (dateHeader) {
    const t = Date.parse(dateHeader);
    if (!Number.isNaN(t)) date = t;
  }

  return {
    headers,
    headerMap: map,
    subject: decodeWords(map.get('subject') || ''),
    from,
    to,
    cc,
    replyTo,
    date,
    messageId: (map.get('message-id') || '').replace(/^<|>$/g, '').trim(),
    inReplyTo: (map.get('in-reply-to') || '').replace(/^<|>$/g, '').trim(),
    references: map.get('references') || '',
    text,
    html,
    attachments: collected.attachments,
    size: buf.length,
  };
}

// ---- 生成 ----
function qpEncode(text, { softLimit = 76 } = {}) {
  const buf = Buffer.from(String(text).replace(/\r\n/g, '\n'), 'utf8');
  let out = '';
  let lineLen = 0;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    let token;
    if (b === 0x0a) {
      out += CRLF;
      lineLen = 0;
      continue;
    }
    if (b === 0x0d) continue;
    if ((b >= 33 && b <= 126 && b !== 61) || b === 32 || b === 9) {
      token = String.fromCharCode(b);
    } else {
      token = '=' + b.toString(16).toUpperCase().padStart(2, '0');
    }
    if (lineLen + token.length > softLimit - 1) {
      out += '=' + CRLF;
      lineLen = 0;
    }
    out += token;
    lineLen += token.length;
  }
  return out;
}

function base64Wrap(buf) {
  const b64 = Buffer.isBuffer(buf) ? buf.toString('base64') : Buffer.from(String(buf)).toString('base64');
  return b64.replace(/(.{76})/g, `$1${CRLF}`);
}

export function generateMessageId(domain) {
  const rand = Math.random().toString(36).slice(2, 12);
  const ts = Date.now().toString(36);
  return `<${ts}.${rand}@${domain || 'localhost'}>`;
}

export function buildMime({
  from, to, cc = [], bcc = [], subject = '', text = '', html = '',
  attachments = [], inReplyTo = '', references = '', extraHeaders = {},
  date = new Date(), messageId,
}) {
  const fromDomain = (from.address.split('@')[1] || 'localhost').toLowerCase();
  const mid = messageId || generateMessageId(fromDomain);
  const boundaryMixed = `----=_Mixed_${Math.random().toString(36).slice(2)}`;
  const boundaryAlt = `----=_Alt_${Math.random().toString(36).slice(2)}`;

  const head = [];
  head.push(`From: ${formatAddress(from)}`);
  head.push(`To: ${to.map(formatAddress).join(', ')}`);
  if (cc.length) head.push(`Cc: ${cc.map(formatAddress).join(', ')}`);
  head.push(`Subject: ${encodeWords(subject)}`);
  head.push(`Date: ${date.toUTCString().replace('GMT', '+0000')}`);
  head.push(`Message-ID: ${mid}`);
  if (inReplyTo) head.push(`In-Reply-To: <${inReplyTo.replace(/^<|>$/g, '')}>`);
  if (references) head.push(`References: ${references}`);
  head.push('MIME-Version: 1.0');
  for (const [k, v] of Object.entries(extraHeaders)) {
    if (v === undefined || v === null || v === '') continue;
    head.push(`${k}: ${v}`);
  }

  const hasHtml = !!html;
  const hasAtt = attachments.length > 0;

  let bodyParts = [];
  if (hasHtml) {
    bodyParts.push(
      `--${boundaryAlt}${CRLF}Content-Type: text/plain; charset=UTF-8${CRLF}Content-Transfer-Encoding: quoted-printable${CRLF}${CRLF}${qpEncode(text || htmlToText(html))}`
    );
    bodyParts.push(
      `--${boundaryAlt}${CRLF}Content-Type: text/html; charset=UTF-8${CRLF}Content-Transfer-Encoding: quoted-printable${CRLF}${CRLF}${qpEncode(html)}`
    );
    bodyParts.push(`--${boundaryAlt}--`);
  }

  let contentSection;
  if (!hasAtt) {
    if (hasHtml) {
      head.push(`Content-Type: multipart/alternative; boundary="${boundaryAlt}"`);
      contentSection = bodyParts.join(CRLF);
    } else {
      head.push('Content-Type: text/plain; charset=UTF-8');
      head.push('Content-Transfer-Encoding: quoted-printable');
      contentSection = qpEncode(text);
    }
  } else {
    head.push(`Content-Type: multipart/mixed; boundary="${boundaryMixed}"`);
    const inner = hasHtml
      ? `--${boundaryMixed}${CRLF}Content-Type: multipart/alternative; boundary="${boundaryAlt}"${CRLF}${CRLF}${bodyParts.join(CRLF)}`
      : `--${boundaryMixed}${CRLF}Content-Type: text/plain; charset=UTF-8${CRLF}Content-Transfer-Encoding: quoted-printable${CRLF}${CRLF}${qpEncode(text)}`;
    const attParts = attachments.map((a) => {
      const name = encodeWords(a.filename || 'attachment.bin');
      const disp = a.inline && a.contentId ? 'inline' : 'attachment';
      const cid = a.contentId ? `${CRLF}Content-ID: <${a.contentId}>` : '';
      return `--${boundaryMixed}${CRLF}Content-Type: ${a.mime || 'application/octet-stream'}; name="${name}"${CRLF}Content-Transfer-Encoding: base64${CRLF}Content-Disposition: ${disp}; filename="${name}"${cid}${CRLF}${CRLF}${base64Wrap(a.content)}`;
    });
    contentSection = [inner, ...attParts, `--${boundaryMixed}--`].join(CRLF);
  }

  const raw = head.join(CRLF) + CRLF + CRLF + contentSection + CRLF;
  return { raw, messageId: mid };
}

export function parseHeadersOnly(rawBuf) {
  const { headerText } = splitHeaderBody(Buffer.isBuffer(rawBuf) ? rawBuf : Buffer.from(rawBuf));
  return headerMap(parseHeaderLines(headerText));
}

// Minimal HTTP/1.1 client over Cloudflare TCP sockets, for the hosts Workers' fetch()
// refuses: bare IP addresses (error 1003) and non-standard ports (e.g. :25461). Xtream
// panels commonly redirect live streams to exactly those.
//
// It supports GET with Content-Length, chunked, or read-until-close bodies, and http or https.

import { connect } from 'cloudflare:sockets';

const CRLF = [13, 10];

export async function socketFetch(url, headers = {}) {
  const tls = url.protocol === 'https:';
  const socket = connect(
    { hostname: url.hostname.replace(/^\[|\]$/g, ''), port: +url.port || (tls ? 443 : 80) },
    { secureTransport: tls ? 'on' : 'off' },
  );

  const request = [
    `GET ${url.pathname}${url.search} HTTP/1.1`,
    `Host: ${url.host}`,
    'Connection: close',
    'Accept-Encoding: identity',
    ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
    '', '',
  ].join('\r\n');
  const writer = socket.writable.getWriter();
  await writer.write(new TextEncoder().encode(request));
  writer.releaseLock();

  // Read up to the end of the response headers.
  const reader = socket.readable.getReader();
  let buf = new Uint8Array(0);
  let end;
  while ((end = indexOf(buf, [13, 10, 13, 10])) < 0) {
    const { value, done } = await reader.read();
    if (done) throw new Error('connection closed before response headers');
    buf = concat(buf, value);
    if (buf.length > 64 * 1024) throw new Error('response headers too large');
  }
  const [statusLine, ...lines] = new TextDecoder().decode(buf.subarray(0, end)).split('\r\n');
  const status = +statusLine.split(' ')[1];
  if (!(status >= 200 && status <= 599)) throw new Error(`bad status line: ${statusLine.slice(0, 60)}`);
  const resHeaders = new Headers();
  for (const line of lines) {
    const i = line.indexOf(':');
    if (i > 0) resHeaders.append(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }

  const close = () => { reader.cancel().catch(() => {}); socket.close().catch(() => {}); };
  const leftover = buf.subarray(end + 4);
  let body = new ReadableStream({
    start(c) { if (leftover.length) c.enqueue(leftover); },
    async pull(c) {
      try {
        const { value, done } = await reader.read();
        if (done) { c.close(); close(); } else c.enqueue(value);
      } catch (err) { c.error(err); close(); }
    },
    cancel: close,
  });

  if (/chunked/i.test(resHeaders.get('transfer-encoding') || '')) {
    body = body.pipeThrough(dechunk());
    resHeaders.delete('transfer-encoding');
  } else if (resHeaders.has('content-length')) {
    body = body.pipeThrough(limit(+resHeaders.get('content-length')));
  }
  const empty = status === 204 || status === 304 || (status >= 300 && status < 400);
  if (empty) body.cancel().catch(() => {});
  return new Response(empty ? null : body, { status, headers: resHeaders });
}

// Decodes Transfer-Encoding: chunked.
function dechunk() {
  let buf = new Uint8Array(0);
  let remaining = -1; // -1 while reading a chunk-size line
  return new TransformStream({
    transform(chunk, ctl) {
      buf = concat(buf, chunk);
      for (;;) {
        if (remaining < 0) {
          const i = indexOf(buf, CRLF);
          if (i < 0) return;
          const size = parseInt(new TextDecoder().decode(buf.subarray(0, i)).split(';')[0].trim(), 16);
          buf = buf.subarray(i + 2);
          if (Number.isNaN(size)) throw new Error('bad chunk size');
          if (size === 0) { ctl.terminate(); return; }
          remaining = size;
        }
        if (remaining > 0) {
          if (!buf.length) return;
          const n = Math.min(remaining, buf.length);
          ctl.enqueue(buf.slice(0, n));
          buf = buf.subarray(n);
          remaining -= n;
        }
        if (remaining === 0) {
          if (buf.length < 2) return;
          buf = buf.subarray(2); // CRLF after the chunk data
          remaining = -1;
        }
      }
    },
  });
}

// Ends the body after Content-Length bytes, in case the server keeps the connection open.
function limit(total) {
  let seen = 0;
  return new TransformStream({
    transform(chunk, ctl) {
      const take = chunk.subarray(0, Math.max(0, total - seen));
      seen += take.length;
      if (take.length) ctl.enqueue(take);
      if (seen >= total) ctl.terminate();
    },
  });
}

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

function indexOf(buf, seq) {
  outer: for (let i = 0; i + seq.length <= buf.length; i++) {
    for (let j = 0; j < seq.length; j++) if (buf[i + j] !== seq[j]) continue outer;
    return i;
  }
  return -1;
}

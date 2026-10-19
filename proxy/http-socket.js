// Minimal HTTP/1.1 client over Cloudflare TCP sockets, for the hosts Workers' fetch()
// refuses: bare IP addresses (error 1003) and non-standard ports (e.g. :25461). Xtream
// panels commonly redirect live streams to exactly those.
//
// It speaks HTTP/1.0 so servers send plain bodies (no chunked encoding) and close when done.
// Long live streams then pass from the socket to the client natively, without JavaScript
// touching each chunk: that matters because Workers limit CPU time per request, and a live
// stream is one request that can run for hours. Chunked responses still work (decoded in JS).

import { connect } from 'cloudflare:sockets';

const CRLF = [13, 10];

export async function socketFetch(url, headers = {}) {
  const tls = url.protocol === 'https:';
  const socket = connect(
    { hostname: url.hostname.replace(/^\[|\]$/g, ''), port: +url.port || (tls ? 443 : 80) },
    { secureTransport: tls ? 'on' : 'off' },
  );

  const request = [
    `GET ${url.pathname}${url.search} HTTP/1.0`,
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

  const leftover = buf.subarray(end + 4);
  const chunked = /chunked/i.test(resHeaders.get('transfer-encoding') || '');
  const length = resHeaders.has('content-length') ? +resHeaders.get('content-length') : null;
  const empty = status === 204 || status === 304 || (status >= 300 && status < 400);
  if (empty) {
    reader.cancel().catch(() => {});
    socket.close().catch(() => {});
    return new Response(null, { status, headers: resHeaders });
  }

  // Plain body: hand the socket to the runtime and let it stream natively. That includes
  // big sized bodies (films): HTTP/1.0 means the server closes when the body ends, and a
  // per-chunk JS stream would run into the Worker's CPU limit over a two-hour movie.
  if (!chunked && (length == null || length > 2 * 1048576) && typeof IdentityTransformStream !== 'undefined') {
    reader.releaseLock();
    const { readable, writable } = new IdentityTransformStream();
    (async () => {
      if (leftover.length) {
        const w = writable.getWriter();
        await w.write(leftover);
        w.releaseLock();
      }
      await socket.readable.pipeTo(writable);
    })().catch(() => socket.close().catch(() => {}));
    return new Response(readable, { status, headers: resHeaders });
  }

  // Short bodies (playlists, segments) and chunked ones go through a small JS stream.
  const close = () => { reader.cancel().catch(() => {}); socket.close().catch(() => {}); };
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

  if (chunked) {
    body = body.pipeThrough(dechunk());
    resHeaders.delete('transfer-encoding');
  } else if (length != null) {
    body = body.pipeThrough(limit(length));
  }
  return new Response(body, { status, headers: resHeaders });
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

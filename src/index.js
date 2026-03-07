// ============================================================
// BUFFERWAVE EDGE v11.0 — VLESS + MESH SIGNALING
//
// Architecture :
//   Android → WebSocket → Worker → fetch() → Internet
//   Android → WebSocket → Worker /mesh → Peer Discovery
//
// Mesh Signaling :
//   /mesh : WebSocket endpoint for peer registration & discovery
//   Peers register, send heartbeats, and find each other
//   globally (Jean in Cameroon finds Marie in France)
// ============================================================

const DEFAULT_UUID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const DOH = 'https://cloudflare-dns.com/dns-query';

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const uuid = env.VLESS_UUID || DEFAULT_UUID;

      // ── Mesh Signaling ──
      if (url.pathname === '/mesh') {
        if (request.headers.get('Upgrade') !== 'websocket') {
          return new Response('WebSocket required for mesh', { status: 426 });
        }
        return handleMeshSignaling(request, url);
      }

      // ── Raw Relay — Relais binaire entre 2 pairs (TailscaleMode) ──
      if (url.pathname === '/tunnel' || url.pathname === '/relay') {
        if (request.headers.get('Upgrade') !== 'websocket') {
          return new Response('WebSocket required', { status: 426 });
        }
        return handleRelay(request, url);
      }

      // ── WebSocket Tunnel (VLESS protocol) ──
      if (url.pathname === '/vless') {
        if (request.headers.get('Upgrade') !== 'websocket') {
          return new Response('WebSocket required', { status: 426 });
        }
        return handleWS(request, uuid);
      }

      // ── CORS ──
      const h = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      };
      if (request.method === 'OPTIONS') return new Response(null, { headers: h });

      // ── Health ──
      if (url.pathname === '/' || url.pathname === '/health') {
        return new Response(JSON.stringify({
          server: 'BufferWave Edge v11.0',
          status: 'ACTIVE',
          mode: 'fetch-proxy+mesh',
          features: ['https-proxy', 'dns-over-https', 'websocket-tunnel', 'mesh-signaling'],
          meshPeers: meshNodes.size,
          timestamp: new Date().toISOString(),
          ok: true,
        }), { headers: h });
      }

      // ── Config ──
      if (url.pathname === '/config') {
        return new Response(JSON.stringify({ uuid, path: '/vless', mode: 'fetch' }), { headers: h });
      }

      // ── Proxy (simple HTTP GET/POST proxy via query param) ──
      if (url.pathname === '/proxy') {
        const target = url.searchParams.get('url');
        if (!target) return new Response('Missing ?url=', { status: 400, headers: h });
        try {
          const resp = await fetch(target, {
            method: request.method,
            headers: { 'User-Agent': 'Mozilla/5.0' },
            body: request.method === 'POST' ? request.body : undefined,
          });
          return new Response(resp.body, {
            status: resp.status,
            headers: {
              'Content-Type': resp.headers.get('Content-Type') || 'text/plain',
              'Access-Control-Allow-Origin': '*',
            },
          });
        } catch (e) {
          return new Response(JSON.stringify({ error: e.message }), { status: 502, headers: h });
        }
      }

      // ── Test fetch connectivity ──
      if (url.pathname === '/test') {
        try {
          const r = await fetch('https://www.google.com', { method: 'HEAD' });
          return new Response(JSON.stringify({ ok: true, status: r.status }), { headers: h });
        } catch (e) {
          return new Response(JSON.stringify({ ok: false, error: e.message }), { headers: h });
        }
      }

      // ── Mesh peers list (HTTP) ──
      if (url.pathname === '/mesh/peers') {
        const peers = Array.from(meshNodes.values()).map(n => ({
          node: n.nodeId,
          name: n.name,
          role: n.role,
          alive: n.alive,
          region: n.region,
          quality: n.quality,
          access: n.access,
          since: n.since,
        }));
        return new Response(JSON.stringify({ peers, count: peers.length }), { headers: h });
      }

      return new Response('Not Found', { status: 404 });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message, stack: e.stack }), {
        status: 500, headers: { 'Content-Type': 'application/json' },
      });
    }
  },
};

// ============================================================
// MESH SIGNALING — Global Peer Discovery
//
// Each peer connects via WebSocket to /mesh.
// The Worker maintains a registry of active nodes.
// Peers send heartbeats; stale peers are removed.
//
// Messages:
//   announce  → Register this node
//   heartbeat → Keep alive
//   list_peers → Get available peers
//   bridge_offer → Request to use someone's internet
//   bridge_accept → Accept the bridge request
//   depart → Node leaving
// ============================================================

// In-memory peer registry (lives as long as the Worker instance)
const meshNodes = new Map();
const meshSockets = new Map();

// Cleanup stale nodes — runs lazily on each mesh interaction
const STALE_TIMEOUT = 60000;
let _lastCleanup = 0;
function cleanupStaleNodes() {
  const now = Date.now();
  if (now - _lastCleanup < 30000) return; // At most once per 30s
  _lastCleanup = now;
  for (const [id, node] of meshNodes) {
    if (now - node.lastSeen > STALE_TIMEOUT) {
      meshNodes.delete(id);
      meshSockets.delete(id);
      console.log(`[MESH] Stale node removed: ${id}`);
    }
  }
}

function handleMeshSignaling(request, url) {
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  server.accept();

  const nodeId = url.searchParams.get('node') || '';
  const nodeName = url.searchParams.get('name') || 'Appareil';
  const nodeRole = url.searchParams.get('role') || 'seeker';

  // Detect region from CF headers
  const cfCountry = request.headers.get('cf-ipcountry') || 'XX';

  if (nodeId) {
    meshNodes.set(nodeId, {
      nodeId,
      name: nodeName,
      role: nodeRole,
      alive: true,
      region: cfCountry,
      quality: 50,
      access: 'unknown',
      since: new Date().toISOString(),
      lastSeen: Date.now(),
    });
    meshSockets.set(nodeId, server);
    console.log(`[MESH] Node joined: ${nodeId} (${nodeName}) from ${cfCountry} as ${nodeRole}`);
  }

  server.addEventListener('message', ev => {
    try {
      const data = JSON.parse(ev.data);
      handleMeshMessage(server, nodeId, data);
    } catch (_) { }
  });

  server.addEventListener('close', () => {
    meshNodes.delete(nodeId);
    meshSockets.delete(nodeId);
    console.log(`[MESH] Node left: ${nodeId}`);
  });

  server.addEventListener('error', () => {
    meshNodes.delete(nodeId);
    meshSockets.delete(nodeId);
  });

  // Send initial peer list
  sendPeerList(server, nodeId);

  return new Response(null, { status: 101, webSocket: client });
}

function handleMeshMessage(ws, senderId, data) {
  // Lazy cleanup of stale nodes
  cleanupStaleNodes();

  // Support abbreviated actions from low-bandwidth clients
  // 'a' = action alias, 'hb' = heartbeat, 'n' = node
  let action = data.action || data.a || '';
  if (action === 'hb') action = 'heartbeat';
  if (data.n && !senderId && !data.node) data.node = data.n;

  switch (action) {
    case 'announce': {
      const node = meshNodes.get(senderId);
      if (node) {
        node.name = data.name || node.name;
        node.role = data.role || node.role;
        node.lastSeen = Date.now();
        node.alive = true;
      }
      // Broadcast to all peers that someone joined
      broadcastEvent({ action: 'peer_joined', node: senderId, name: data.name }, senderId);
      break;
    }

    case 'heartbeat': {
      const node = meshNodes.get(senderId);
      if (node) {
        node.lastSeen = Date.now();
        node.alive = true;
      }
      safeSend(ws, { action: 'heartbeat_ack', ts: Date.now() });
      break;
    }

    case 'list_peers': {
      sendPeerList(ws, senderId);
      break;
    }

    case 'bridge_offer':
    case 'bridge_accept': {
      // Forward to the target peer
      const targetId = data.to || '';
      const targetWs = meshSockets.get(targetId);
      if (targetWs) {
        safeSend(targetWs, data);
        console.log(`[MESH] ${action}: ${senderId} -> ${targetId}`);
      }
      break;
    }

    case 'depart': {
      meshNodes.delete(senderId);
      meshSockets.delete(senderId);
      broadcastEvent({ action: 'peer_left', node: senderId }, senderId);
      break;
    }
  }
}

function sendPeerList(ws, excludeId) {
  const peers = [];
  for (const [id, node] of meshNodes) {
    if (id === excludeId) continue;
    peers.push({
      node: node.nodeId,
      name: node.name,
      role: node.role,
      alive: node.alive,
      region: node.region,
      quality: node.quality,
      access: node.access,
      bw: 0,
    });
  }
  safeSend(ws, { action: 'peer_list', peers });
}

function broadcastEvent(event, excludeId) {
  for (const [id, ws] of meshSockets) {
    if (id === excludeId) continue;
    safeSend(ws, event);
  }
}

// ============================================================
// RAW RELAY — Binary relay between paired peers
// ============================================================
const relayWaiting = new Map();
const relayPaired = new Map();

function makeRelayKey(a, b) { return `${a}→${b}`; }

function handleRelay(request, url) {
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  server.accept();

  const userId = url.searchParams.get('user') || '';
  const peerId = url.searchParams.get('peer') || '';
  const myKey = makeRelayKey(userId, peerId);
  const partnerKey = makeRelayKey(peerId, userId);

  console.log(`[RELAY] New: ${userId} wants ${peerId}`);

  const partner = relayWaiting.get(partnerKey);

  if (partner) {
    // Partner found — pair them
    relayWaiting.delete(partnerKey);
    relayPaired.set(myKey, partnerKey);
    relayPaired.set(partnerKey, myKey);
    const pw = partner.ws;
    console.log(`[RELAY] ✅ Paired: ${userId} ↔ ${peerId}`);

    safeSend(server, { action: 'relay_paired', partner: peerId });
    safeSend(pw, { action: 'relay_paired', partner: userId });

    // Bidirectional relay
    server.addEventListener('message', ev => {
      try { pw.send(ev.data); } catch (_) { }
    });
    pw.addEventListener('message', ev => {
      try { server.send(ev.data); } catch (_) { }
    });

    // Cleanup
    const cleanup = (side, other) => {
      relayPaired.delete(myKey);
      relayPaired.delete(partnerKey);
      try { other.close(1000, 'partner-left'); } catch (_) { }
    };
    server.addEventListener('close', () => cleanup('A', pw));
    server.addEventListener('error', () => cleanup('A', pw));
    pw.addEventListener('close', () => cleanup('B', server));
    pw.addEventListener('error', () => cleanup('B', server));
  } else {
    // Wait for partner
    relayWaiting.set(myKey, { ws: server, userId, peerId });
    console.log(`[RELAY] ${userId} waiting for ${peerId}...`);
    safeSend(server, { action: 'relay_waiting' });

    const timeout = setTimeout(() => {
      if (relayWaiting.has(myKey)) {
        relayWaiting.delete(myKey);
        try { server.close(1000, 'timeout'); } catch (_) { }
      }
    }, 120_000);

    server.addEventListener('close', () => { relayWaiting.delete(myKey); clearTimeout(timeout); });
    server.addEventListener('error', () => { relayWaiting.delete(myKey); clearTimeout(timeout); });

    server.addEventListener('message', ev => {
      if (typeof ev.data === 'string') {
        try {
          const d = JSON.parse(ev.data);
          if (d.a === 'ping') safeSend(server, { action: 'pong' });
        } catch (_) { }
      }
    });
  }

  return new Response(null, { status: 101, webSocket: client });
}

function safeSend(ws, data) {
  try {
    ws.send(JSON.stringify(data));
  } catch (_) { }
}

// ============================================================
// WebSocket Tunnel — VLESS-like protocol via fetch()
//
// Le client envoie un header VLESS standard (UUID + host + port).
// Le Worker parse le header, puis fait des fetch() pour chaque
// requête HTTP/HTTPS que le client envoie ensuite.
//
// Pour le DNS : utilise Cloudflare DoH.
// Pour le HTTPS : on extrait le SNI du TLS ClientHello et on
// fait un fetch() vers le host cible.
// ============================================================
function handleWS(request, uuid) {
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  server.accept();

  let queue = [], waiter = null, closed = false;

  server.addEventListener('message', ev => {
    const d = ev.data;
    const b = d instanceof ArrayBuffer ? new Uint8Array(d) : null;
    if (!b) return;
    if (waiter) { const w = waiter; waiter = null; w(b); }
    else queue.push(b);
  });
  server.addEventListener('close', () => { closed = true; if (waiter) { waiter(null); waiter = null; } });
  server.addEventListener('error', () => { closed = true; if (waiter) { waiter(null); waiter = null; } });

  function next() {
    if (queue.length) return Promise.resolve(queue.shift());
    if (closed) return Promise.resolve(null);
    return new Promise(r => { waiter = r; });
  }

  // Handle early data
  let ed = null;
  const edHeader = request.headers.get('sec-websocket-protocol') || '';
  if (edHeader) {
    try {
      const bin = atob(edHeader);
      ed = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) ed[i] = bin.charCodeAt(i);
    } catch (_) { }
  }

  processVless(server, next, uuid, ed).catch(e => {
    console.error('WS error:', e.message);
    try { server.close(1011, 'err'); } catch (_) { }
  });

  const resp = { status: 101, webSocket: client };
  if (edHeader) resp.headers = { 'sec-websocket-protocol': edHeader };
  return new Response(null, resp);
}

// ============================================================
// Parse VLESS header, then proxy via fetch()
// ============================================================
async function processVless(ws, next, expectedUuid, earlyData) {
  const msg = earlyData && earlyData.length > 0 ? earlyData : await next();
  if (!msg || msg.length < 24) { ws.close(1002, 'short'); return; }

  const buf = new Uint8Array(msg.length);
  buf.set(msg);
  const dv = new DataView(buf.buffer);
  let o = 0;

  const ver = dv.getUint8(o); o++;
  const ub = buf.slice(o, o + 16); o += 16;
  const cid = toUUID(ub);
  if (cid !== expectedUuid) { ws.close(1002, 'uuid'); return; }

  const alen = dv.getUint8(o); o++; o += alen;
  const cmd = dv.getUint8(o); o++;
  const port = dv.getUint16(o); o += 2;
  const atype = dv.getUint8(o); o++;

  let host = '';
  if (atype === 1) {
    host = dv.getUint8(o) + '.' + dv.getUint8(o + 1) + '.' + dv.getUint8(o + 2) + '.' + dv.getUint8(o + 3);
    o += 4;
  } else if (atype === 2) {
    const dl = dv.getUint8(o); o++;
    host = new TextDecoder().decode(buf.slice(o, o + dl)); o += dl;
  } else if (atype === 3) {
    const p = [];
    for (let i = 0; i < 8; i++) { p.push(dv.getUint16(o).toString(16)); o += 2; }
    host = '[' + p.join(':') + ']';
  } else { ws.close(1002, 'atype'); return; }

  console.log(`[V] ${cmd === 1 ? 'TCP' : 'UDP'} ${host}:${port}`);
  const payload = o < buf.length ? buf.slice(o) : null;

  // Send VLESS response
  const rh = new ArrayBuffer(2);
  new Uint8Array(rh).set([ver, 0]);
  ws.send(rh);

  if (cmd === 2) {
    // UDP = DNS → DoH
    await handleDns(ws, next, payload);
    return;
  }

  // TCP → fetch-based proxy
  // The payload contains TLS ClientHello (for HTTPS) or HTTP request
  await handleTcpViaFetch(ws, next, host, port, payload);
}

// ============================================================
// TCP via fetch() — Proxy HTTPS connections
//
// Strategy: Extract the target URL from the TLS SNI or HTTP Host,
// then use fetch() to make the actual request.
//
// For raw HTTPS on port 443:
//   We can't forward raw TLS via fetch().
//   Instead, we relay data chunks as the client sends HTTP requests.
//
// For HTTP on port 80:
//   We can proxy directly.
// ============================================================
async function handleTcpViaFetch(ws, next, host, port, firstPayload) {
  // The VLESS client sends raw TCP bytes.
  // For a fetch-based proxy, we need to handle this differently.
  //
  // Strategy:
  // 1. Accumulate data from the client
  // 2. Try to parse it as an HTTP request
  // 3. Forward via fetch()
  // 4. Send response back
  //
  // For TLS (port 443): We extract the SNI from ClientHello,
  // but we can't relay raw TLS. Instead, we make fetch() which
  // handles TLS natively.

  const scheme = port === 443 ? 'https' : 'http';
  let buffer = firstPayload ? Array.from(firstPayload) : [];

  // Wait for more data to build up the request
  // The first payload is usually TLS ClientHello (for HTTPS)
  // or raw HTTP request (for HTTP)

  // For HTTPS (port 443): The client sends TLS ClientHello.
  // We can't process raw TLS. Instead, we make an HTTPS fetch
  // to the target host and stream the response.
  if (port === 443 || port === 8443) {
    // Make an HTTPS connection to the target host via fetch
    try {
      const targetUrl = `https://${host}/`;
      console.log(`[T] fetch: ${targetUrl}`);

      const resp = await fetch(targetUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Accept-Encoding': 'gzip',
        },
      });

      // Send response body back through WebSocket
      if (resp.body) {
        const reader = resp.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value && value.byteLength > 0) {
            const ab = new ArrayBuffer(value.byteLength);
            new Uint8Array(ab).set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
            ws.send(ab);
          }
        }
      }
    } catch (e) {
      console.error(`[T] fetch error: ${e.message}`);
    }
    try { ws.close(1000, 'done'); } catch (_) { }
    return;
  }

  // For HTTP (port 80): Try to parse the raw HTTP request
  if (port === 80) {
    try {
      // Accumulate data until we have a complete HTTP request
      let rawRequest = new Uint8Array(buffer);

      // Try to find the end of headers (\r\n\r\n)
      let headersEnd = -1;
      for (let i = 0; i < rawRequest.length - 3; i++) {
        if (rawRequest[i] === 13 && rawRequest[i + 1] === 10 &&
          rawRequest[i + 2] === 13 && rawRequest[i + 3] === 10) {
          headersEnd = i + 4;
          break;
        }
      }

      if (headersEnd === -1) {
        // Need more data
        const more = await next();
        if (more) {
          const combined = new Uint8Array(rawRequest.length + more.length);
          combined.set(rawRequest);
          combined.set(more, rawRequest.length);
          rawRequest = combined;
        }
      }

      // Parse HTTP request
      const requestText = new TextDecoder().decode(rawRequest);
      const lines = requestText.split('\r\n');
      const requestLine = lines[0]; // e.g. "GET /path HTTP/1.1"
      const [method, path] = requestLine.split(' ');
      const targetUrl = `http://${host}${path}`;

      console.log(`[T] HTTP: ${method} ${targetUrl}`);

      const resp = await fetch(targetUrl, {
        method: method,
        headers: { 'Host': host, 'User-Agent': 'Mozilla/5.0' },
      });

      // Build HTTP response
      let responseText = `HTTP/1.1 ${resp.status} ${resp.statusText}\r\n`;
      resp.headers.forEach((v, k) => { responseText += `${k}: ${v}\r\n`; });
      responseText += '\r\n';

      const headerBytes = new TextEncoder().encode(responseText);
      const ab = new ArrayBuffer(headerBytes.length);
      new Uint8Array(ab).set(headerBytes);
      ws.send(ab);

      // Stream body
      if (resp.body) {
        const reader = resp.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value && value.byteLength > 0) {
            const buf = new ArrayBuffer(value.byteLength);
            new Uint8Array(buf).set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
            ws.send(buf);
          }
        }
      }
    } catch (e) {
      console.error(`[T] HTTP proxy error: ${e.message}`);
    }
    try { ws.close(1000, 'done'); } catch (_) { }
    return;
  }

  // For other ports: can't proxy via fetch
  console.warn(`[T] Unsupported port ${port} for fetch proxy`);
  ws.close(1011, 'port not supported');
}

// ============================================================
// DNS via DoH
// ============================================================
async function handleDns(ws, next, payload) {
  async function dns(data) {
    try {
      let d = data;
      if (d.length > 2 && ((d[0] << 8) | d[1]) === d.length - 2) d = d.slice(2);
      const r = await fetch(DOH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/dns-message', 'Accept': 'application/dns-message' },
        body: d,
      });
      if (!r.ok) return;
      const rd = new Uint8Array(await r.arrayBuffer());
      const ab = new ArrayBuffer(2 + rd.length);
      const v = new Uint8Array(ab);
      v[0] = (rd.length >> 8) & 0xFF;
      v[1] = rd.length & 0xFF;
      v.set(rd, 2);
      ws.send(ab);
    } catch (e) { console.error('[U] dns:', e.message); }
  }

  if (payload && payload.length > 0) await dns(payload);
  while (true) {
    const d = await next();
    if (!d) break;
    await dns(d);
  }
  try { ws.close(1000, 'dns done'); } catch (_) { }
}

function toUUID(b) {
  const h = Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
  return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
}
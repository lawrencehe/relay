// Self-hosted Paseo relay for Node.js.
//
// Derived from packages/relay/src/cloudflare-adapter.ts of Paseo
// (https://github.com/getpaseo/paseo, @getpaseo/relay v0.11.2),
// Copyright (c) 2025-present Mohamed Boudra, licensed under the Apache License 2.0.
// Modifications: Cloudflare Durable Object / hibernation APIs replaced with
// node:http + ws; per-serverId sessions kept in memory; protocol-level ping
// added to reap half-open sockets. See NOTICE.
//
// Protocol: GET /ws?serverId=..&role=server|client&v=1|2[&connectionId=..]
// The relay only forwards opaque frames; payloads are E2EE between daemon and client.
import http from "node:http";
import crypto from "node:crypto";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || "0.0.0.0";
const PING_INTERVAL_MS = 30_000;
const MAX_PENDING_FRAMES = 200;

const log = (...a) => console.log(new Date().toISOString(), ...a);

/** session key "v<version>:<serverId>" -> Session */
const sessions = new Map();

class Session {
  constructor(key) {
    this.key = key;
    this.sockets = new Set(); // ws with ws._tags (Set) and ws._att (object)
    this.pendingFrames = new Map(); // connectionId -> [{data,isBinary}]
  }
  get(tag) {
    const out = [];
    for (const ws of this.sockets) if (ws._tags.has(tag)) out.push(ws);
    return out;
  }
  bufferFrame(connectionId, frame) {
    const list = this.pendingFrames.get(connectionId) ?? [];
    list.push(frame);
    if (list.length > MAX_PENDING_FRAMES) list.splice(0, list.length - MAX_PENDING_FRAMES);
    this.pendingFrames.set(connectionId, list);
  }
  flushFrames(connectionId, serverWs) {
    const frames = this.pendingFrames.get(connectionId);
    if (!frames || frames.length === 0) return;
    this.pendingFrames.delete(connectionId);
    for (let i = 0; i < frames.length; i++) {
      try {
        serverWs.send(frames[i].data, { binary: frames[i].isBinary });
      } catch {
        for (const f of frames.slice(i)) this.bufferFrame(connectionId, f);
        break;
      }
    }
  }
  listConnectedConnectionIds() {
    const out = new Set();
    for (const ws of this.get("client")) if (ws._att.connectionId) out.add(ws._att.connectionId);
    return [...out];
  }
  notifyControls(msg) {
    const text = JSON.stringify(msg);
    for (const ws of this.get("server-control")) {
      try { ws.send(text); } catch { safeClose(ws, 1011, "Control send failed"); }
    }
  }
  nudgeOrResetControlForConnection(connectionId) {
    setTimeout(() => {
      if (this.get(`client:${connectionId}`).length === 0) return;
      if (this.get(`server:${connectionId}`).length > 0) return;
      this.notifyControls({ type: "sync", connectionIds: this.listConnectedConnectionIds() });
      setTimeout(() => {
        if (this.get(`client:${connectionId}`).length === 0) return;
        if (this.get(`server:${connectionId}`).length > 0) return;
        for (const ws of this.get("server-control")) safeClose(ws, 1011, "Control unresponsive");
      }, 5_000);
    }, 10_000);
  }
}

function safeClose(ws, code, reason) {
  try { ws.close(code, reason); } catch { /* ignore */ }
}

function getSession(key) {
  let s = sessions.get(key);
  if (!s) { s = new Session(key); sessions.set(key, s); }
  return s;
}

function resolveVersion(raw) {
  if (raw == null) return "1";
  const v = raw.trim();
  if (!v) return "1";
  return v === "1" || v === "2" ? v : null;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/health") {
    let sockets = 0;
    for (const s of sessions.values()) sockets += s.sockets.size;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", sessions: sessions.size, sockets }));
    return;
  }
  if (url.pathname === "/ws") {
    res.writeHead(426, { "Content-Type": "text/plain" });
    res.end("Expected WebSocket upgrade");
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });

function reject(socket, status, text) {
  socket.write(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n${text}`);
  socket.destroy();
}

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname !== "/ws") return reject(socket, 404, "Not found");
  const roleRaw = url.searchParams.get("role");
  const role = roleRaw === "server" || roleRaw === "client" ? roleRaw : null;
  const serverId = url.searchParams.get("serverId");
  const connectionId = (url.searchParams.get("connectionId") ?? "").trim();
  const version = resolveVersion(url.searchParams.get("v"));
  if (!serverId) return reject(socket, 400, "Missing serverId parameter");
  if (!version) return reject(socket, 400, "Invalid v parameter (expected 1 or 2)");
  if (!role) return reject(socket, 400, "Missing or invalid role parameter");

  wss.handleUpgrade(req, socket, head, (ws) => {
    const session = getSession(`relay-v${version}:${serverId}`);
    if (version === "1") acceptV1(session, ws, role, serverId);
    else acceptV2(session, ws, role, serverId, connectionId);
  });
});

function attach(session, ws, tags, att) {
  ws._tags = new Set(tags);
  ws._att = att;
  ws._alive = true;
  session.sockets.add(ws);
  ws.on("pong", () => { ws._alive = true; });
  ws.on("message", (data, isBinary) => onMessage(session, ws, data, isBinary));
  ws.on("close", (code, reason) => onClose(session, ws, code, reason.toString()));
  ws.on("error", (err) => log(`[relay] ws error ${att.role}:`, err.message));
}

function acceptV1(session, ws, role, serverId) {
  for (const old of session.get(role)) safeClose(old, 1008, "Replaced by new connection");
  attach(session, ws, [role], { serverId, role, version: "1", connectionId: null });
  log(`[relay] v1:${role} connected to session ${serverId}`);
}

function acceptV2(session, ws, role, serverId, connectionId) {
  const resolved = role === "client" && !connectionId
    ? `conn_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`
    : connectionId;
  const isControl = role === "server" && !resolved;
  const isData = role === "server" && !!resolved;

  if (isControl) for (const old of session.get("server-control")) safeClose(old, 1008, "Replaced by new connection");
  else if (isData) for (const old of session.get(`server:${resolved}`)) safeClose(old, 1008, "Replaced by new connection");

  const tags = role === "client" ? ["client", `client:${resolved}`]
    : isControl ? ["server-control"] : ["server", `server:${resolved}`];
  attach(session, ws, tags, { serverId, role, version: "2", connectionId: resolved || null });

  const suffix = isControl ? "(control)" : isData ? `(data:${resolved})` : `(${resolved})`;
  log(`[relay] v2:${role}${suffix} connected to session ${serverId}`);

  if (role === "client") {
    session.notifyControls({ type: "connected", connectionId: resolved });
    session.nudgeOrResetControlForConnection(resolved);
  }
  if (isControl) {
    try { ws.send(JSON.stringify({ type: "sync", connectionIds: session.listConnectedConnectionIds() })); } catch { /* ignore */ }
  }
  if (isData) session.flushFrames(resolved, ws);
}

function forward(targets, data, isBinary, label) {
  for (const t of targets) {
    try { t.send(data, { binary: isBinary }); } catch (e) { log(`[relay] forward ${label} failed:`, e.message); }
  }
}

function onMessage(session, ws, data, isBinary) {
  const { version, role, connectionId } = ws._att;
  if (version === "1") {
    forward(session.get(role === "server" ? "client" : "server"), data, isBinary, "v1");
    return;
  }
  if (!connectionId) {
    // Control channel: legacy JSON keepalive.
    if (!isBinary) {
      try {
        const p = JSON.parse(data.toString());
        if (p && p.type === "ping") ws.send(JSON.stringify({ type: "pong", ts: Date.now() }));
      } catch { /* ignore */ }
    }
    return;
  }
  if (role === "client") {
    const servers = session.get(`server:${connectionId}`);
    if (servers.length === 0) { session.bufferFrame(connectionId, { data, isBinary }); return; }
    forward(servers, data, isBinary, `client->server(${connectionId})`);
    return;
  }
  forward(session.get(`client:${connectionId}`), data, isBinary, `server->client(${connectionId})`);
}

function onClose(session, ws, code, reason) {
  session.sockets.delete(ws);
  const { version, role, connectionId, serverId } = ws._att;
  log(`[relay] v${version}:${role}${connectionId ? `(${connectionId})` : ""} disconnected from session ${serverId} (${code}: ${reason})`);
  if (version === "2") {
    if (role === "client" && connectionId) {
      if (session.get(`client:${connectionId}`).length === 0) {
        session.pendingFrames.delete(connectionId);
        for (const s of session.get(`server:${connectionId}`)) safeClose(s, 1001, "Client disconnected");
        session.notifyControls({ type: "disconnected", connectionId });
      }
    } else if (role === "server" && connectionId) {
      for (const c of session.get(`client:${connectionId}`)) safeClose(c, 1012, "Server disconnected");
    }
  }
  if (session.sockets.size === 0 && session.pendingFrames.size === 0) sessions.delete(session.key);
}

// Detect half-open sockets (Cloudflare edge does this implicitly).
setInterval(() => {
  for (const s of sessions.values()) {
    for (const ws of s.sockets) {
      if (!ws._alive) { ws.terminate(); continue; }
      ws._alive = false;
      try { ws.ping(); } catch { /* ignore */ }
    }
  }
}, PING_INTERVAL_MS).unref();

server.listen(PORT, HOST, () => log(`[relay] listening on ${HOST}:${PORT}`));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { log(`[relay] ${sig}, exiting`); process.exit(0); });

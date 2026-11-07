/**
 * Walkie Lagos — servidor push-to-talk para restaurantes.
 *
 * Un solo proceso Node: sirve la web (public/) y gestiona el audio en tiempo
 * real por WebSocket (binario = fragmentos de audio, JSON = control).
 *
 * Protocolo (cliente -> servidor)
 *   {type:"join", name, pin, room}    entra a un canal
 *   {type:"switch", room}             cambia de canal (cuelga el PTT abierto)
 *   {type:"talk", on:true|false}      pide empezar / terminar de hablar
 *   {type:"chat", text}               mensaje de texto al canal
 *   {type:"ping"}                     keep-alive
 *   <binario>                         chunk de audio (solo si eres el que habla)
 *
 * Protocolo (servidor -> cliente)
 *   {type:"welcome", you, rooms, users, ...}
 *   {type:"roster", users}            quién está en mi canal
 *   {type:"presence", ...}            quién hay conectado en total
 *   {type:"talkAccept", from}         te han dado el turno de palabra
 *   {type:"talkDeny", reason, by}     alguien más está hablando
 *   {type:"talkStart", from}          empieza a llegar audio de alguien
 *   {type:"talkEnd", from}
 *   {type:"chat", from, text, ts}
 *   {type:"rooms", rooms}
 *   {type:"error", message}
 *   <binario>                         audio del que habla
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const express = require('express');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const ROOMS = new Map(config.rooms.map((r) => [r.id, r]));
const DEFAULT_ROOM = config.rooms[0]?.id || 'general';
const MAX_TALK_MS = Number(config.maxTalkSeconds || 45) * 1000;
const PIN = String(config.pin ?? '').trim();

// ---------------------------------------------------------------------------
// Estado en memoria
// ---------------------------------------------------------------------------

/** @type {Map<string, Client>} */
const clients = new Map();
/** roomId -> Set<clientId> de quién está en ese canal */
const roomMembers = new Map();
/** roomId -> {clientId, name, since, timer} del que tiene el turno */
const talking = new Map();
/** roomId -> [{from, text, ts}] últimos mensajes */
const history = new Map();

const HISTORY_SIZE = 60;

function roomSet(roomId) {
  if (!roomMembers.has(roomId)) roomMembers.set(roomId, new Set());
  return roomMembers.get(roomId);
}

function publicRooms() {
  return config.rooms.map((r) => ({
    ...r,
    count: roomSet(r.id).size,
    talking: talking.get(r.id)?.name || null,
  }));
}

function rosterOf(roomId) {
  const ids = roomSet(roomId);
  return [...ids]
    .map((id) => clients.get(id))
    .filter(Boolean)
    .map((c) => ({ id: c.id, name: c.name, talking: talking.get(roomId)?.clientId === c.id }))
    .sort((a, b) => a.name.localeCompare(b.name, 'es'));
}

function broadcast(roomId, payload, exceptId) {
  const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
  for (const id of roomSet(roomId)) {
    if (id === exceptId) continue;
    const c = clients.get(id);
    if (c?.ws.readyState === c.ws.OPEN) c.ws.send(data);
  }
}

function broadcastAll(payload) {
  const data = JSON.stringify(payload);
  for (const c of clients.values()) if (c.ws.readyState === c.ws.OPEN) c.ws.send(data);
}

function pushRooms() {
  broadcastAll({ type: 'rooms', rooms: publicRooms() });
}

function pushRoster(roomId) {
  broadcast(roomId, { type: 'roster', room: roomId, users: rosterOf(roomId) });
}

function stopTalking(roomId, reason) {
  const t = talking.get(roomId);
  if (!t) return;
  clearTimeout(t.timer);
  talking.delete(roomId);
  broadcast(roomId, { type: 'talkEnd', from: t.name, reason: reason || 'released' });
  pushRooms();
  pushRoster(roomId);
}

function leaveRoom(client) {
  const set = roomSet(client.room);
  set.delete(client.id);
  if (talking.get(client.room)?.clientId === client.id) stopTalking(client.room, 'disconnected');
  pushRoster(client.room);
  pushRooms();
}

function sanitizeName(raw) {
  const name = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 24);
  return name || null;
}

function sanitizeText(raw) {
  const text = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);
  return text || null;
}

function hashPin(pin) {
  return crypto.createHash('sha256').update(String(pin)).digest();
}

function pinOk(pin) {
  if (!PIN) return true;
  const a = hashPin(pin);
  const b = hashPin(PIN);
  return crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const app = express();
app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h', index: 'index.html' }));

app.get('/api/config', (_req, res) => {
  res.json({
    appName: config.appName,
    tagline: config.tagline,
    requiresPin: Boolean(PIN),
    maxTalkSeconds: config.maxTalkSeconds,
    rooms: publicRooms(),
    online: clients.size,
  });
});

app.get('/healthz', (_req, res) => res.json({ ok: true, online: clients.size }));

let server;
if (process.argv.includes('--https')) {
  const keyPath = process.env.TLS_KEY || path.join(__dirname, 'certs', 'key.pem');
  const certPath = process.env.TLS_CERT || path.join(__dirname, 'certs', 'cert.pem');
  if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
    console.error(`\n[fatal] Faltan los certificados TLS (${keyPath}).`);
    console.error('        Genera uno autofirmado con:  npm run cert\n');
    process.exit(1);
  }
  server = https.createServer(
    { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) },
    app
  );
} else {
  server = http.createServer(app);
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 256 * 1024 });

wss.on('connection', (ws, req) => {
  const client = {
    id: crypto.randomUUID(),
    name: null,
    room: null,
    joined: false,
    ws,
    joinedAt: Date.now(),
    ip: req.socket.remoteAddress,
  };
  clients.set(client.id, client);

  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  const fail = (message) => {
    ws.send(JSON.stringify({ type: 'error', message }));
  };

  ws.on('message', (raw, isBinary) => {
    if (isBinary) {
      // Audio: solo se retransmite si este cliente tiene el turno en su canal.
      const t = talking.get(client.room);
      if (!t || t.clientId !== client.id) return;
      for (const id of roomSet(client.room)) {
        if (id === client.id) continue;
        const peer = clients.get(id);
        if (peer?.ws.readyState === peer.ws.OPEN) peer.ws.send(raw, { binary: true });
      }
      client.bytes = (client.bytes || 0) + raw.length;
      return;
    }

    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return fail('Mensaje no válido.');
    }

    switch (msg.type) {
      case 'join': {
        if (client.joined) return fail('Ya estás dentro.');
        const name = sanitizeName(msg.name);
        if (!name) return fail('Necesito un nombre para identificarte.');
        if (!pinOk(msg.pin)) return fail('PIN incorrecto.');
        const roomId = ROOMS.has(msg.room) ? msg.room : DEFAULT_ROOM;

        client.name = name;
        client.room = roomId;
        client.joined = true;
        roomSet(roomId).add(client.id);

        ws.send(
          JSON.stringify({
            type: 'welcome',
            you: { id: client.id, name, room: roomId },
            rooms: publicRooms(),
            users: rosterOf(roomId),
            history: history.get(roomId) || [],
            maxTalkSeconds: config.maxTalkSeconds,
          })
        );
        broadcast(
          roomId,
          { type: 'system', text: `${name} se ha conectado`, ts: Date.now() },
          client.id
        );
        pushRoster(roomId);
        pushRooms();
        broadcastAll({ type: 'presence', online: clients.size });
        break;
      }

      case 'switch': {
        if (!client.joined) return fail('Entra primero.');
        const roomId = String(msg.room || '');
        if (!ROOMS.has(roomId)) return fail('Ese canal no existe.');
        if (roomId === client.room) break;
        leaveRoom(client);
        broadcast(client.room, { type: 'system', text: `${client.name} ha salido`, ts: Date.now() });
        client.room = roomId;
        roomSet(roomId).add(client.id);
        ws.send(
          JSON.stringify({
            type: 'switched',
            room: roomId,
            users: rosterOf(roomId),
            history: history.get(roomId) || [],
          })
        );
        broadcast(roomId, { type: 'system', text: `${client.name} se ha conectado`, ts: Date.now() }, client.id);
        pushRoster(roomId);
        pushRooms();
        break;
      }

      case 'talk': {
        if (!client.joined) return fail('Entra primero.');
        if (!msg.on) {
          if (talking.get(client.room)?.clientId === client.id) stopTalking(client.room, 'released');
          break;
        }
        const current = talking.get(client.room);
        if (current && current.clientId !== client.id) {
          ws.send(JSON.stringify({ type: 'talkDeny', reason: 'busy', by: current.name }));
          break;
        }
        if (current) break; // ya tienes el turno
        const rate = Number(msg.rate) > 0 ? Math.round(Number(msg.rate)) : 16000;
        const entry = { clientId: client.id, name: client.name, since: Date.now(), rate };
        entry.timer = setTimeout(() => {
          if (talking.get(client.room) === entry) stopTalking(client.room, 'timeout');
        }, MAX_TALK_MS);
        talking.set(client.room, entry);
        ws.send(JSON.stringify({ type: 'talkAccept', maxSeconds: config.maxTalkSeconds }));
        broadcast(
          client.room,
          {
            type: 'talkStart',
            from: client.name,
            fromId: client.id,
            since: entry.since,
            rate: entry.rate,
          },
          client.id
        );
        pushRooms();
        pushRoster(client.room);
        break;
      }

      case 'chat': {
        if (!client.joined) return fail('Entra primero.');
        const text = sanitizeText(msg.text);
        if (!text) break;
        const entry = { from: client.name, text, ts: Date.now() };
        const list = history.get(client.room) || [];
        list.push(entry);
        history.set(client.room, list.slice(-HISTORY_SIZE));
        broadcast(client.room, { type: 'chat', ...entry });
        break;
      }

      case 'ping':
        ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
        break;

      default:
        break;
    }
  });

  ws.on('close', () => {
    if (client.joined) {
      leaveRoom(client);
      broadcast(client.room, { type: 'system', text: `${client.name} se ha desconectado`, ts: Date.now() });
    }
    clients.delete(client.id);
    broadcastAll({ type: 'presence', online: clients.size });
    pushRooms();
  });

  ws.on('error', () => {});
});

// Limpieza de conexiones zombis (esto es justo lo que a Zello le cuesta).
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {}
  }
}, 20000);
wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, HOST, () => {
  const scheme = process.argv.includes('--https') ? 'https' : 'http';
  console.log(`\n  ${config.appName} — ${config.tagline}`);
  console.log(`  Escuchando en ${scheme}://${HOST}:${PORT}`);
  if (PIN) console.log(`  PIN de acceso: ${PIN === 'lagos' ? 'lagos (cámbialo en config.json)' : '(definido en config.json)'}`);
  console.log(`  Canales: ${config.rooms.map((r) => r.emoji + ' ' + r.name).join('  ')}\n`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`\n${sig} recibido, cerrando…`);
    clearInterval(heartbeat);
    for (const c of clients.values()) c.ws.close(1001, 'server shutdown');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000);
  });
}

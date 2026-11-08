/**
 * Walkie Lagos — servidor de radio para el restaurante.
 *
 * Un solo proceso Node: sirve la web (public/) y gestiona el audio en tiempo
 * real por WebSocket (binario = trozos de audio, JSON = control).
 *
 * Del cliente:
 *   {type:"join", name, pin, room}    entra
 *   {type:"switch", room}             cambia de canal
 *   {type:"talk", on:true|false}      pide / suelta el turno de palabra
 *   {type:"chat", text}               mensaje escrito al canal
 *   {type:"ping"}                     mantener viva la conexión
 *   <binario>                         audio (solo si tienes el turno)
 *
 * Al cliente:
 *   welcome, rooms, roster, presence, talkAccept, talkDeny, talkStart, talkEnd,
 *   chat, system, error y los mensajes binarios de audio.
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
// 0 = sin límite: se habla todo lo que se quiera y se suelta al terminar.
const MAX_TALK_MS = Math.max(0, Number(config.maxTalkSeconds ?? 0)) * 1000;
const PIN = String(process.env.PIN ?? config.pin ?? '').trim();

/** clientId -> cliente */
const clients = new Map();
/** roomId -> Set<clientId> */
const roomMembers = new Map();
/** roomId -> {clientId, name, timer} de quien tiene la palabra */
const talking = new Map();
/** roomId -> últimos mensajes */
const history = new Map();

const HISTORY_SIZE = 200;

// El historial se guarda en disco para que no se pierda al reiniciar. Si no hay
// permiso de escritura, se sigue funcionando solo en memoria.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');

function loadHistory() {
  try {
    const raw = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    for (const [roomId, entries] of Object.entries(raw)) {
      if (Array.isArray(entries)) history.set(roomId, entries.slice(-HISTORY_SIZE));
    }
  } catch {}
}

let saveTimer = null;

function writeHistoryNow() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const out = {};
    for (const [roomId, entries] of history) out[roomId] = entries.slice(-HISTORY_SIZE);
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(out));
  } catch {}
}

function saveHistory() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeHistoryNow, 800);
}

loadHistory();

const roomSet = (roomId) => {
  if (!roomMembers.has(roomId)) roomMembers.set(roomId, new Set());
  return roomMembers.get(roomId);
};

const publicRooms = () =>
  config.rooms.map((r) => ({
    id: r.id,
    name: r.name,
    emoji: r.emoji,
    count: roomSet(r.id).size,
    talking: talking.get(r.id)?.name || null,
  }));

const rosterOf = (roomId) =>
  [...roomSet(roomId)]
    .map((id) => clients.get(id))
    .filter(Boolean)
    .map((c) => ({ id: c.id, name: c.name, talking: talking.get(roomId)?.clientId === c.id }))
    .sort((a, b) => a.name.localeCompare(b.name, 'es'));

function sendTo(client, payload) {
  if (client?.ws.readyState === client.ws.OPEN) client.ws.send(JSON.stringify(payload));
}

function broadcast(roomId, payload, exceptId) {
  const data = JSON.stringify(payload);
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
  const slot = talking.get(roomId);
  if (!slot) return;
  clearTimeout(slot.timer);
  talking.delete(roomId);
  broadcast(roomId, { type: 'talkEnd', from: slot.name, reason: reason || 'released' });
  pushRooms();
  pushRoster(roomId);
}

const cleanName = (raw) => String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 24) || null;
const cleanText = (raw) => String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 500) || null;

function pinOk(pin) {
  if (!PIN) return true;
  const a = crypto.createHash('sha256').update(String(pin)).digest();
  const b = crypto.createHash('sha256').update(PIN).digest();
  return crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------- web

const app = express();
app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));

app.get('/api/config', (_req, res) => {
  res.json({
    appName: config.appName,
    tagline: config.tagline,
    requiresPin: Boolean(PIN),
    maxTalkSeconds: MAX_TALK_MS / 1000,
    rooms: publicRooms(),
  });
});

let server;
if (process.argv.includes('--https')) {
  const key = process.env.TLS_KEY || path.join(__dirname, 'certs', 'key.pem');
  const cert = process.env.TLS_CERT || path.join(__dirname, 'certs', 'cert.pem');
  if (!fs.existsSync(key) || !fs.existsSync(cert)) {
    console.error(`\n[fatal] Faltan los certificados (${key}).`);
    console.error('        Genera uno autofirmado con:  npm run cert\n');
    process.exit(1);
  }
  server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, app);
} else {
  server = http.createServer(app);
}

// ----------------------------------------------------------------- websocket

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 256 * 1024 });

wss.on('connection', (ws) => {
  const client = { id: crypto.randomUUID(), name: null, room: null, joined: false, ws };
  clients.set(client.id, client);
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  const fail = (message) => sendTo(client, { type: 'error', message });

  ws.on('message', (raw, isBinary) => {
    // Audio: solo se reparte si este cliente tiene la palabra en su canal.
    if (isBinary) {
      if (talking.get(client.room)?.clientId !== client.id) return;
      for (const id of roomSet(client.room)) {
        if (id === client.id) continue;
        const peer = clients.get(id);
        if (peer?.ws.readyState === peer.ws.OPEN) peer.ws.send(raw, { binary: true });
      }
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
        const name = cleanName(msg.name);
        if (!name) return fail('Necesito tu nombre.');
        if (!pinOk(msg.pin)) return fail('PIN incorrecto.');

        client.name = name;
        client.room = ROOMS.has(msg.room) ? msg.room : DEFAULT_ROOM;
        client.joined = true;
        roomSet(client.room).add(client.id);

        sendTo(client, {
          type: 'welcome',
          you: { id: client.id, name, room: client.room },
          rooms: publicRooms(),
          users: rosterOf(client.room),
          history: history.get(client.room) || [],
          maxTalkSeconds: MAX_TALK_MS / 1000,
        });
        broadcast(client.room, { type: 'system', text: `${name} ha entrado`, ts: Date.now() }, client.id);
        pushRoster(client.room);
        pushRooms();
        broadcastAll({ type: 'presence', online: clients.size });
        break;
      }

      case 'switch': {
        if (!client.joined) return fail('Entra primero.');
        const roomId = String(msg.room || '');
        if (!ROOMS.has(roomId)) return fail('Ese canal no existe.');
        if (roomId === client.room) break;
        if (talking.get(client.room)?.clientId === client.id) stopTalking(client.room, 'changed');

        roomSet(client.room).delete(client.id);
        pushRoster(client.room);
        client.room = roomId;
        roomSet(roomId).add(client.id);

        sendTo(client, {
          type: 'switched',
          room: roomId,
          users: rosterOf(roomId),
          history: history.get(roomId) || [],
        });
        broadcast(roomId, { type: 'system', text: `${client.name} ha entrado`, ts: Date.now() }, client.id);
        pushRoster(roomId);
        pushRooms();
        break;
      }

      case 'talk': {
        if (!client.joined) return fail('Entra primero.');
        const slot = talking.get(client.room);

        if (!msg.on) {
          if (slot?.clientId === client.id) stopTalking(client.room, 'released');
          break;
        }
        if (slot && slot.clientId !== client.id) {
          sendTo(client, { type: 'talkDeny', by: slot.name });
          break;
        }
        if (slot) break; // ya tienes la palabra

        const entry = { clientId: client.id, name: client.name, timer: null };
        if (MAX_TALK_MS > 0) {
          entry.timer = setTimeout(() => stopTalking(client.room, 'timeout'), MAX_TALK_MS);
        }
        talking.set(client.room, entry);

        sendTo(client, { type: 'talkAccept', maxSeconds: MAX_TALK_MS / 1000 });
        broadcast(client.room, { type: 'talkStart', from: client.name }, client.id);
        pushRooms();
        pushRoster(client.room);
        break;
      }

      case 'chat': {
        if (!client.joined) return fail('Entra primero.');
        const text = cleanText(msg.text);
        if (!text) break;
        const entry = { from: client.name, text, ts: Date.now() };
        const list = history.get(client.room) || [];
        list.push(entry);
        history.set(client.room, list.slice(-HISTORY_SIZE));
        saveHistory();
        broadcast(client.room, { type: 'chat', ...entry });
        break;
      }

      case 'ping':
        sendTo(client, { type: 'pong' });
        break;

      default:
        break;
    }
  });

  ws.on('close', () => {
    if (client.joined) {
      if (talking.get(client.room)?.clientId === client.id) stopTalking(client.room, 'disconnected');
      roomSet(client.room).delete(client.id);
      broadcast(client.room, {
        type: 'system',
        text: `${client.name} ha salido`,
        ts: Date.now(),
      });
      pushRoster(client.room);
    }
    clients.delete(client.id);
    broadcastAll({ type: 'presence', online: clients.size });
    pushRooms();
  });

  ws.on('error', () => {});
});

// Corta conexiones zombis (mensajes que ya no llegan nunca).
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
  console.log(`\n  ${config.appName}`);
  console.log(`  ${scheme}://${HOST}:${PORT}`);
  console.log(`  PIN: ${PIN || 'sin PIN'}`);
  console.log(`  Canales: ${config.rooms.map((r) => `${r.emoji} ${r.name}`).join('  ')}\n`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    clearInterval(heartbeat);
    writeHistoryNow();
    for (const c of clients.values()) c.ws.close(1001, 'cerrando');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000);
  });
}

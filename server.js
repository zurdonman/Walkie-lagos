/**
 * Walkie Lagos — servidor push-to-talk para restaurantes.
 *
 * Un solo proceso Node: sirve la web (public/) y gestiona el audio en tiempo
 * real por WebSocket (binario = fragmentos de audio, JSON = control).
 *
 * Concepto de "turno" (talk slot): todo el audio se organiza alrededor de una
 * clave de conversación. Hay tres tipos:
 *
 *   canal:<roomId>       todo el que está en ese canal
 *   dm:<idA>|:<idB>      conversación privada entre dos personas (ids ordenados)
 *   alert                aviso prioritario, lo oye TODO el restaurante
 *
 * Protocolo (cliente -> servidor)
 *   {type:"join", name, pin, room}          entra al restaurante (y a un canal)
 *   {type:"switch", room}                   cambia de canal
 *   {type:"talk", on, scope, rate}          pide/entrega el turno
 *        scope: {kind:"room"} (por defecto) | {kind:"dm", to:<clientId>}
 *               | {kind:"alert"}
 *   {type:"chat", text, to?}                mensaje al canal o privado (to=clientId)
 *   {type:"alert", text}                    aviso prioritario a todos
 *   {type:"ping"}                           keep-alive
 *   <binario>                               chunk de audio (solo si tienes turno)
 *
 * Protocolo (servidor -> cliente)
 *   {type:"welcome", you, rooms, users, ...}
 *   {type:"roster", users}                  quién está en mi canal
 *   {type:"presence", online}
 *   {type:"talkAccept", scope, maxSeconds}
 *   {type:"talkDeny", reason, by, scope}
 *   {type:"talkStart", from, fromId, rate, alert?, dm?}
 *   {type:"talkEnd", from, reason}
 *   {type:"chat", from, text, ts, dm?}
 *   {type:"alert", from, text, ts}          aviso prioritario
 *   {type:"dmOffer", from, fromId}          alguien quiere hablar contigo a solas
 *   {type:"rooms", rooms}
 *   {type:"error", message}
 *   <binario>                               audio
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const express = require('express');
const { WebSocketServer } = require('ws');
const { loadConfig } = require('./lib/config');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

const { config, warnings: configWarnings } = loadConfig();
const ROOMS = new Map(config.rooms.map((r) => [r.id, r]));
const DEFAULT_ROOM = config.rooms[0]?.id || 'general';
const MAX_TALK_MS = Number(config.maxTalkSeconds || 45) * 1000;
const MAX_ALERT_MS = Number(config.maxAlertSeconds || 25) * 1000;
const PIN = String(config.pin ?? '').trim();
const ALERTS_ENABLED = config.alertsEnabled !== false;

// ---------------------------------------------------------------------------
// Estado en memoria
// ---------------------------------------------------------------------------

/** @type {Map<string, Client>} */
const clients = new Map();
/** roomId -> Set<clientId> de quién está en ese canal */
const roomMembers = new Map();
/** slotKey -> {key, kind, clientId, name, since, timer, rate, fromName?} */
const talking = new Map();
/** roomId -> [{from, text, ts}] últimos mensajes */
const history = new Map();
/** "idA|idB" ordenado -> [{from, text, ts}] últimos mensajes privados */
const dmHistory = new Map();

const HISTORY_SIZE = 60;
const DM_HISTORY_SIZE = 30;

function roomSet(roomId) {
  if (!roomMembers.has(roomId)) roomMembers.set(roomId, new Set());
  return roomMembers.get(roomId);
}

function roomKey(roomId) {
  return `room:${roomId}`;
}

function dmKey(a, b) {
  return `dm:${[a, b].sort().join('|')}`;
}

function dmParticipants(key) {
  return key.slice(3).split('|');
}

function parseScope(raw, client) {
  const kind = raw && typeof raw === 'object' ? raw.kind : undefined;
  if (kind === 'alert') {
    if (!ALERTS_ENABLED) return { error: 'Los avisos prioritarios están desactivados.' };
    return { key: 'alert', kind: 'alert' };
  }
  if (kind === 'dm') {
    const to = String(raw.to || '');
    const peer = clients.get(to);
    if (!peer || !peer.joined) return { error: 'Esa persona ya no está conectada.' };
    if (peer.id === client.id) return { error: 'No puedes hablar contigo mismo.' };
    return { key: dmKey(client.id, peer.id), kind: 'dm', peer };
  }
  return { key: roomKey(client.room), kind: 'room' };
}

/** A quién le llega el audio de este turno. */
function targetsFor(slot) {
  if (slot.kind === 'alert') return [...clients.values()].filter((c) => c.joined);
  if (slot.kind === 'dm') {
    return dmParticipants(slot.key)
      .map((id) => clients.get(id))
      .filter((c) => c && c.joined);
  }
  return [...roomSet(slot.key.slice(5))]
    .map((id) => clients.get(id))
    .filter((c) => c && c.joined);
}

function sendTo(client, payload) {
  if (client?.ws.readyState === client.ws.OPEN) client.ws.send(JSON.stringify(payload));
}

function publicRooms() {
  return config.rooms.map((r) => ({
    ...r,
    count: roomSet(r.id).size,
    talking: talking.get(roomKey(r.id))?.name || null,
  }));
}

function rosterOf(roomId) {
  const ids = roomSet(roomId);
  return [...ids]
    .map((id) => clients.get(id))
    .filter(Boolean)
    .map((c) => ({
      id: c.id,
      name: c.name,
      talking: talking.get(roomKey(roomId))?.clientId === c.id,
    }))
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

function stopTalking(slot, reason) {
  if (!slot) return;
  clearTimeout(slot.timer);
  if (talking.get(slot.key) !== slot) return;
  talking.delete(slot.key);
  const payload = { type: 'talkEnd', from: slot.name, reason: reason || 'released', scope: slot.kind };
  for (const peer of targetsFor(slot)) {
    if (peer.id !== slot.clientId) sendTo(peer, payload);
  }
  if (slot.kind === 'room') {
    pushRooms();
    pushRoster(slot.key.slice(5));
  } else if (slot.kind === 'alert') {
    pushRooms();
  }
}

function leaveRoom(client) {
  const set = roomSet(client.room);
  set.delete(client.id);
  const slot = talking.get(roomKey(client.room));
  if (slot?.clientId === client.id) stopTalking(slot, 'disconnected');
  pushRoster(client.room);
  pushRooms();
}

/** Cierra cualquier turno que tuviera este cliente (al salir o desconectarse). */
function dropOwnSlots(client) {
  for (const slot of [...talking.values()]) {
    if (slot.clientId === client.id) stopTalking(slot, 'disconnected');
    else if (slot.kind === 'dm' && slot.key.includes(client.id)) stopTalking(slot, 'disconnected');
  }
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
    maxAlertSeconds: config.maxAlertSeconds,
    alertsEnabled: ALERTS_ENABLED,
    rooms: publicRooms(),
    online: clients.size,
  });
});

app.get('/healthz', (_req, res) =>
  res.json({
    ok: true,
    online: clients.size,
    rooms: config.rooms.length,
    uptimeSeconds: Math.round(process.uptime()),
    version: require('./package.json').version,
  })
);

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

  const fail = (message) => sendTo(client, { type: 'error', message });

  /** Envía el audio de este turno a todos los destinatarios menos al emisor. */
  function relayAudio(slot, raw) {
    for (const peer of targetsFor(slot)) {
      if (peer.id === slot.clientId) continue;
      if (peer.ws.readyState === peer.ws.OPEN) peer.ws.send(raw, { binary: true });
    }
    client.bytes = (client.bytes || 0) + raw.length;
  }

  function currentSlotFor(key) {
    return talking.get(key) || null;
  }

  ws.on('message', (raw, isBinary) => {
    if (isBinary) {
      // Un cliente puede tener a la vez: su canal + un directo + un aviso.
      // Averiguamos cuál de sus turnos está activo por el último que pidió.
      const key = client.activeSlotKey;
      const slot = key ? talking.get(key) : null;
      if (!slot || slot.clientId !== client.id) return;
      relayAudio(slot, raw);
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
            maxAlertSeconds: MAX_ALERT_MS / 1000,
            alertsEnabled: ALERTS_ENABLED,
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
        const previous = talking.get(roomKey(client.room));
        if (previous?.clientId === client.id) stopTalking(previous, 'changed');
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
        broadcast(
          roomId,
          { type: 'system', text: `${client.name} se ha conectado`, ts: Date.now() },
          client.id
        );
        pushRoster(roomId);
        pushRooms();
        break;
      }

      case 'talk': {
        if (!client.joined) return fail('Entra primero.');

        // --- entregar el turno
        if (!msg.on) {
          if (client.activeSlotKey) {
            const slot = talking.get(client.activeSlotKey);
            if (slot?.clientId === client.id) stopTalking(slot, 'released');
            client.activeSlotKey = null;
          }
          break;
        }

        const scope = parseScope(msg.scope, client);
        if (scope.error) return fail(scope.error);

        // Si ya tenía otro turno abierto (canal/distinto directo), lo cerramos.
        if (client.activeSlotKey && client.activeSlotKey !== scope.key) {
          const previous = talking.get(client.activeSlotKey);
          if (previous?.clientId === client.id) stopTalking(previous, 'switched');
          client.activeSlotKey = null;
        }

        const current = currentSlotFor(scope.key);
        if (current && current.clientId !== client.id) {
          sendTo(client, {
            type: 'talkDeny',
            reason: 'busy',
            by: current.name,
            scope: scope.kind,
          });
          break;
        }

        if (scope.kind === 'dm') {
          // Avisamos al destinatario de quién le va a hablar (para que vea el aviso
          // aunque el audio llegue después).
          sendTo(scope.peer, {
            type: 'dmOffer',
            from: client.name,
            fromId: client.id,
          });
        }

        if (current) {
          client.activeSlotKey = scope.key;
          break; // ya tienes el turno
        }

        const rate = Number(msg.rate) > 0 ? Math.round(Number(msg.rate)) : 16000;
        const limit = scope.kind === 'alert' ? MAX_ALERT_MS : MAX_TALK_MS;
        const entry = {
          key: scope.key,
          kind: scope.kind,
          clientId: client.id,
          name: client.name,
          since: Date.now(),
          rate,
        };
        entry.timer = setTimeout(() => stopTalking(entry, 'timeout'), limit);
        talking.set(scope.key, entry);
        client.activeSlotKey = scope.key;

        sendTo(client, {
          type: 'talkAccept',
          scope: scope.kind,
          to: scope.peer?.id,
          toName: scope.peer?.name,
          maxSeconds: limit / 1000,
        });

        const start = {
          type: 'talkStart',
          from: client.name,
          fromId: client.id,
          since: entry.since,
          rate: entry.rate,
          alert: scope.kind === 'alert',
          dm: scope.kind === 'dm',
          scope: scope.kind,
        };
        for (const peer of targetsFor(entry)) {
          if (peer.id !== client.id) sendTo(peer, start);
        }
        pushRooms();
        if (scope.kind === 'room') pushRoster(client.room);
        break;
      }

      case 'chat': {
        if (!client.joined) return fail('Entra primero.');
        const text = sanitizeText(msg.text);
        if (!text) break;
        const entry = { from: client.name, text, ts: Date.now() };

        if (msg.to) {
          const peer = clients.get(String(msg.to));
          if (!peer || !peer.joined) return fail('Esa persona ya no está conectada.');
          const key = dmKey(client.id, peer.id);
          const list = dmHistory.get(key) || [];
          list.push(entry);
          dmHistory.set(key, list.slice(-DM_HISTORY_SIZE));
          sendTo(peer, { type: 'chat', ...entry, dm: true, fromId: client.id });
          sendTo(client, { type: 'chat', ...entry, dm: true, fromId: client.id, self: true });
          break;
        }

        const list = history.get(client.room) || [];
        list.push(entry);
        history.set(client.room, list.slice(-HISTORY_SIZE));
        broadcast(client.room, { type: 'chat', ...entry });
        break;
      }

      case 'alert': {
        if (!client.joined) return fail('Entra primero.');
        if (!ALERTS_ENABLED) return fail('Los avisos prioritarios están desactivados.');
        const text = sanitizeText(msg.text);
        if (!text) break;
        const entry = { from: client.name, text, ts: Date.now() };
        for (const room of config.rooms) {
          const list = history.get(room.id) || [];
          list.push({ ...entry, alert: true });
          history.set(room.id, list.slice(-HISTORY_SIZE));
        }
        broadcastAll({ type: 'alert', ...entry });
        break;
      }

      case 'ping':
        sendTo(client, { type: 'pong', ts: Date.now() });
        break;

      default:
        break;
    }
  });

  ws.on('close', () => {
    if (client.joined) {
      dropOwnSlots(client);
      leaveRoom(client);
      broadcast(client.room, {
        type: 'system',
        text: `${client.name} se ha desconectado`,
        ts: Date.now(),
      });
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
  console.log(`  Canales: ${config.rooms.map((r) => r.emoji + ' ' + r.name).join('  ')}`);
  console.log(`  Avisos prioritarios: ${ALERTS_ENABLED ? 'sí' : 'no'}`);
  if (configWarnings.length) {
    console.log('');
    for (const warning of configWarnings) console.log(`  ⚠️  ${warning}`);
  }
  console.log('');
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

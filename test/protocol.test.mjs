/**
 * Prueba de integración del protocolo: tres clientes, canales, directos y avisos.
 * Arranca su propio servidor en un puerto libre y lo para al terminar.
 *
 *   node test/protocol.test.mjs
 */
import { spawn } from 'node:child_process';
import WebSocket from 'ws';

const PORT = 3299 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(cond, msg) {
  console.log(`  ${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) failures += 1;
}

const server = spawn('node', ['server.js'], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (d) => process.stderr.write(d));

await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('el servidor no arranca')), 8000);
  server.stdout.on('data', (d) => {
    if (String(d).includes('Escuchando')) {
      clearTimeout(t);
      resolve();
    }
  });
});

function mk(name, room) {
  return new Promise((resolve, reject) => {
    const c = { name, msgs: [], audio: 0, ws: new WebSocket(`ws://127.0.0.1:${PORT}/ws`) };
    c.ws.binaryType = 'nodebuffer';
    c.ws.on('open', () => c.ws.send(JSON.stringify({ type: 'join', name, pin: 'lagos', room })));
    c.ws.on('message', (data, isBinary) => {
      if (isBinary) {
        c.audio += 1;
        return;
      }
      const m = JSON.parse(data.toString());
      c.msgs.push(m);
      if (m.type === 'welcome') {
        c.id = m.you.id;
        resolve(c);
      }
      if (m.type === 'error') reject(new Error(m.message));
    });
    c.ws.on('error', reject);
    setTimeout(() => reject(new Error(`timeout ${name}`)), 4000);
  });
}

const got = (c, type) => c.msgs.filter((m) => m.type === type);
const last = (c, type) => got(c, type).at(-1);
const send = (c, payload) => c.ws.send(JSON.stringify(payload));

try {
  console.log('\nCONFIGURACIÓN');
  const cfg = await (await fetch(`${BASE}/api/config`)).json();
  check(cfg.rooms.length >= 2, 'la API pública los canales');
  check(cfg.requiresPin === true, 'la API indica que hace falta PIN');
  check(cfg.alertsEnabled === true, 'los avisos prioritarios están activos');
  const health = await (await fetch(`${BASE}/healthz`)).json();
  check(health.ok === true, 'healthz responde');

  const marta = await mk('Marta', 'cocina');
  const luis = await mk('Luis', 'cocina');
  const ana = await mk('Ana', 'sala');
  await wait(150);
  const roomsUpdate = last(marta, 'rooms');
  check(roomsUpdate?.rooms.find((r) => r.id === 'cocina').count === 2, 'el canal cuenta 2 personas');

  console.log('\nPIN Y VALIDACIONES');
  const bad = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const badMsg = await new Promise((resolve) => {
    bad.on('open', () => bad.send(JSON.stringify({ type: 'join', name: 'X', pin: 'malo', room: 'cocina' })));
    bad.on('message', (d) => resolve(JSON.parse(d.toString())));
  });
  check(badMsg.message === 'PIN incorrecto.', 'rechaza PIN incorrecto');
  bad.close();

  console.log('\nHABLAR AL CANAL');
  send(marta, { type: 'talk', on: true, scope: { kind: 'room' }, rate: 16000 });
  await wait(120);
  for (let i = 0; i < 3; i++) marta.ws.send(Buffer.alloc(640));
  await wait(200);
  check(last(marta, 'talkAccept')?.scope === 'room', 'Marta obtiene el turno del canal');
  check(luis.audio === 3, 'Luis recibe los 3 paquetes de audio');
  check(ana.audio === 0, 'Ana (otra sala) no oye nada');
  check(last(luis, 'talkStart')?.from === 'Marta', 'Luis ve quién habla');

  send(luis, { type: 'talk', on: true, scope: { kind: 'room' } });
  await wait(120);
  check(last(luis, 'talkDeny')?.by === 'Marta', 'a Luis se le deniega el turno ocupado');

  marta.ws.close();
  await wait(200);
  check(Boolean(last(luis, 'talkEnd')), 'al desconectarse se libera el turno');
  check(last(luis, 'roster')?.users.length === 1, 'el roster se actualiza');
  luis.ws.send(JSON.stringify({ type: 'talk', on: true, scope: { kind: 'room' } }));
  await wait(120);
  check(Boolean(last(luis, 'talkAccept')), 'Luis ya puede hablar');
  send(luis, { type: 'talk', on: false });
  await wait(80);

  console.log('\nHABLAR A UNA SOLA PERSONA');
  const marta2 = await mk('Marta', 'cocina');
  await wait(100);
  send(marta2, { type: 'talk', on: true, scope: { kind: 'dm', to: ana.id } });
  await wait(120);
  const beforeLuis = luis.audio;
  for (let i = 0; i < 2; i++) marta2.ws.send(Buffer.alloc(640));
  await wait(180);
  check(last(marta2, 'talkAccept')?.scope === 'dm', 'Marta obtiene un turno privado');
  check(last(ana, 'dmOffer')?.from === 'Marta', 'Ana recibe el aviso de conversación privada');
  check(ana.audio === 2, 'Ana oye el audio privado');
  check(luis.audio === beforeLuis, 'Luis no oye la conversación privada');
  send(marta2, { type: 'talk', on: false });

  send(marta2, { type: 'talk', on: true, scope: { kind: 'dm', to: 'no-existe' } });
  send(marta2, { type: 'talk', on: true, scope: { kind: 'dm', to: marta2.id } });
  await wait(150);
  const errs = got(marta2, 'error').map((e) => e.message);
  check(errs.includes('Esa persona ya no está conectada.'), 'valida destinatario inexistente');
  check(errs.includes('No puedes hablar contigo mismo.'), 'valida hablar contigo mismo');

  console.log('\nAVISO PRIORITARIO');
  const anaBefore = ana.audio;
  send(luis, { type: 'talk', on: true, scope: { kind: 'alert' } });
  await wait(140);
  luis.ws.send(Buffer.alloc(640));
  luis.ws.send(Buffer.alloc(640));
  await wait(180);
  check(last(luis, 'talkAccept')?.scope === 'alert', 'Luis obtiene el turno de aviso');
  check(last(ana, 'talkStart')?.alert === true, 'Ana ve que es un aviso prioritario');
  check(ana.audio === anaBefore + 2, 'el aviso se oye en OTRO canal (sala)');
  check(Boolean(last(marta2, 'talkStart')?.alert), 'y también en cocina');
  send(luis, { type: 'talk', on: false });
  await wait(80);

  console.log('\nAVISO ESCRITO Y CHAT');
  send(luis, { type: 'alert', text: 'Se ha ido la luz en cocina' });
  await wait(150);
  check(last(ana, 'alert')?.text === 'Se ha ido la luz en cocina', 'el aviso escrito llega a todos');
  check(last(marta2, 'alert')?.text === 'Se ha ido la luz en cocina', 'también a los de cocina');

  send(marta2, { type: 'chat', to: ana.id, text: '¿Queda flan?' });
  await wait(150);
  check(last(ana, 'chat')?.text === '¿Queda flan?', 'el chat privado llega al destinatario');
  check(!got(luis, 'chat').some((m) => m.text === '¿Queda flan?'), 'y no lo ve el resto');

  send(marta2, { type: 'chat', text: 'Mesa 3 lista' });
  await wait(150);
  check(got(luis, 'chat').some((m) => m.text === 'Mesa 3 lista'), 'el chat de canal llega a los del canal');

  console.log('\nCAMBIOS DE CANAL');
  send(ana, { type: 'switch', room: 'cocina' });
  await wait(150);
  check(last(ana, 'switched')?.room === 'cocina', 'Ana cambia de canal');
  check(last(luis, 'roster')?.users.some((u) => u.name === 'Ana'), 'y aparece en el roster de cocina');
  send(ana, { type: 'switch', room: 'no-existe' });
  await wait(100);
  check(got(ana, 'error').some((e) => e.message === 'Ese canal no existe.'), 'rechaza canales inexistentes');

  for (const c of [marta2, luis, ana]) c.ws.close();
  await wait(250);
  const finalCfg = await (await fetch(`${BASE}/api/config`)).json();
  check(finalCfg.online === 0, 'al cerrar todos, el servidor queda limpio');
} catch (error) {
  console.error('\nError inesperado:', error);
  failures += 1;
}

server.kill('SIGTERM');
await wait(200);
console.log(failures === 0 ? '\nTODO OK\n' : `\n${failures} FALLOS\n`);
process.exit(failures === 0 ? 0 : 1);

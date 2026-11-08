/**
 * Prueba del servidor con dos clientes: entrar, hablar, chat y cambio de canal.
 * Uso: node test/protocol.test.mjs
 */
import { spawn } from 'node:child_process';
import WebSocket from 'ws';

const PORT = 3300 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(cond, msg) {
  console.log(`  ${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) failures += 1;
}

const server = spawn('node', ['server.js'], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', (d) => (log += d));
server.stderr.on('data', (d) => (log += d));
for (let i = 0; i < 60 && !log.includes('PIN:'); i++) await wait(100);

function join(name, room, pin = 'lagos') {
  return new Promise((resolve, reject) => {
    const client = { name, msgs: [], audio: 0, ws: new WebSocket(`ws://127.0.0.1:${PORT}/ws`) };
    client.ws.binaryType = 'nodebuffer';
    client.ws.on('open', () => client.ws.send(JSON.stringify({ type: 'join', name, pin, room })));
    client.ws.on('message', (data, binary) => {
      if (binary) {
        client.audio += 1;
        return;
      }
      const msg = JSON.parse(data.toString());
      client.msgs.push(msg);
      if (msg.type === 'welcome') {
        client.id = msg.you.id;
        resolve(client);
      }
      if (msg.type === 'error' && !client.id) reject(new Error(msg.message));
    });
    client.ws.on('error', reject);
    setTimeout(() => reject(new Error(`timeout ${name}`)), 4000);
  });
}

const last = (client, type) => client.msgs.filter((m) => m.type === type).at(-1);
const say = (client, payload) => client.ws.send(JSON.stringify(payload));

try {
  console.log('\nENTRAR');
  const cfg = await (await fetch(`${BASE}/api/config`)).json();
  check(cfg.rooms.length === 4 && cfg.requiresPin === true, 'la API da canales y pide PIN');

  const marta = await join('Marta', 'cocina');
  const luis = await join('Luis', 'cocina');
  const ana = await join('Ana', 'sala');
  await wait(150);
  check(last(marta, 'rooms').rooms.find((r) => r.id === 'cocina').count === 2, 'el canal cuenta a los dos');
  check(last(marta, 'presence').online === 3, 'hay 3 personas conectadas');

  const bad = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const denied = await new Promise((resolve) => {
    bad.on('open', () => bad.send(JSON.stringify({ type: 'join', name: 'X', pin: 'malo', room: 'cocina' })));
    bad.on('message', (d) => resolve(JSON.parse(d.toString())));
  });
  bad.close();
  check(denied.message === 'PIN incorrecto.', 'rechaza un PIN incorrecto');

  console.log('\nHABLAR');
  say(marta, { type: 'talk', on: true });
  await wait(120);
  for (let i = 0; i < 3; i++) marta.ws.send(Buffer.alloc(640));
  await wait(200);
  check(Boolean(last(marta, 'talkAccept')), 'Marta recibe el turno');
  check(luis.audio === 3, 'Luis oye los 3 paquetes');
  check(ana.audio === 0, 'Ana, en otro canal, no oye nada');

  say(luis, { type: 'talk', on: true });
  await wait(120);
  check(last(luis, 'talkDeny')?.by === 'Marta', 'a Luis se le avisa de que está ocupado');

  marta.ws.close();
  await wait(200);
  check(Boolean(last(luis, 'talkEnd')), 'al irse Marta se libera el canal');
  say(luis, { type: 'talk', on: true });
  await wait(120);
  check(Boolean(last(luis, 'talkAccept')), 'Luis ya puede hablar');
  say(luis, { type: 'talk', on: false });

  console.log('\nCHAT');
  const marta2 = await join('Marta', 'cocina');
  await wait(100);
  say(marta2, { type: 'chat', text: 'Mesa 3 lista' });
  await wait(150);
  check(last(luis, 'chat')?.text === 'Mesa 3 lista', 'el mensaje llega al canal');
  check(last(ana, 'chat') === undefined, 'y no sale de él');
  check(last(marta2, 'chat')?.text === 'Mesa 3 lista', 'quien escribe también lo ve');

  console.log('\nCANALES');
  say(ana, { type: 'switch', room: 'cocina' });
  await wait(150);
  check(last(ana, 'switched')?.room === 'cocina', 'Ana cambia de canal');
  check(last(luis, 'roster').users.some((u) => u.name === 'Ana'), 'y aparece en la lista');
  say(ana, { type: 'switch', room: 'no-existe' });
  await wait(100);
  check(last(ana, 'error')?.message === 'Ese canal no existe.', 'rechaza canales que no existen');

  for (const c of [luis, ana, marta2]) c.ws.close();
  await wait(250);
  const finalCfg = await (await fetch(`${BASE}/api/config`)).json();
  check(finalCfg.rooms.every((r) => r.count === 0), 'al irse todos los canales quedan vacíos');
} catch (error) {
  console.error('\nError:', error);
  failures += 1;
}

server.kill('SIGTERM');
await wait(300);
console.log(failures === 0 ? '\nTODO OK\n' : `\n${failures} FALLOS\n`);
process.exit(failures === 0 ? 0 : 1);

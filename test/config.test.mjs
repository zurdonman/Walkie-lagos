/**
 * Pruebas de la carga de configuración (config.json + variables de entorno)
 * y del servidor arrancado con esas variables.
 *
 *   node test/config.test.mjs
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { loadConfig } = require('../lib/config');

let failures = 0;
function check(cond, msg) {
  console.log(`  ${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) failures += 1;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('\nCARGA DE CONFIGURACIÓN');

const base = loadConfig({ env: {} });
check(base.config.rooms.length === 4, 'lee los 4 canales de config.json');
check(base.config.pin === 'lagos', 'lee el PIN del archivo');
check(
  base.warnings.some((w) => w.includes('PIN de ejemplo')),
  'avisa si sigue el PIN de ejemplo'
);

const env = loadConfig({
  env: {
    PIN: 'cocina-2026',
    APP_NAME: 'Radio Lagos',
    MAX_TALK_SECONDS: '30',
    MAX_ALERT_SECONDS: '15',
    ALERTS_ENABLED: 'false',
    ROOMS: JSON.stringify([
      { id: 'Cocina Fría', name: 'Cocina fría', emoji: '🧊' },
      { id: 'sala', name: 'Sala', emoji: '🍽️' },
    ]),
  },
});
check(env.config.pin === 'cocina-2026', 'el PIN del entorno manda sobre el archivo');
check(env.config.appName === 'Radio Lagos', 'el nombre del entorno manda');
check(env.config.maxTalkSeconds === 30 && env.config.maxAlertSeconds === 15, 'lee límites numéricos');
check(env.config.alertsEnabled === false, 'interpreta ALERTS_ENABLED=false');
check(env.config.rooms[0].id === 'cocina-fria', 'normaliza identificadores de canal ("Cocina Fría")');
check(env.config.rooms.length === 2, 'usa los canales del entorno');
check(env.source.envKeys.length >= 6, 'informa de qué variables se han aplicado');
check(!env.warnings.some((w) => w.includes('PIN de ejemplo')), 'sin aviso de PIN de ejemplo al cambiarlo');

const raros = loadConfig({
  env: { MAX_TALK_SECONDS: 'muchos', ALERTS_ENABLED: 'quizá', ROOMS: 'no-json' },
});
check(raros.config.maxTalkSeconds === 45, 'ignora un límite no numérico y usa el valor por defecto');
check(raros.config.alertsEnabled === true, 'ignora un booleano inválido');
check(raros.config.rooms.length === 4, 'si ROOMS es inválido, vuelve a config.json');
check(raros.warnings.length >= 2, 'explica qué variables ha ignorado');

const duplicados = loadConfig({
  env: {
    ROOMS: JSON.stringify([
      { id: 'barra', name: 'Barra' },
      { id: 'BARRA', name: 'Barra 2' },
      { id: '!!!', name: 'Canal raro' },
      { id: 'cocina', name: 'Cocina', emoji: '🍳', color: '#f00' },
    ]),
  },
});
check(duplicados.config.rooms.length === 2, 'descarta canales duplicados e inválidos');
check(
  duplicados.warnings.some((w) => w.includes('duplicado')) &&
    duplicados.warnings.some((w) => w.includes('no vale')),
  'explica por qué descarta cada canal'
);
check(duplicados.config.rooms[1].color === '#f00', 'conserva el color del canal');

const vacios = loadConfig({ env: { ROOMS: '[]' } });
check(vacios.config.rooms[0].id === 'general', 'sin canales, crea uno "General"');

const sinPin = loadConfig({ env: { PIN: '' } });
check(
  sinPin.warnings.some((w) => w.includes('No hay PIN')),
  'avisa si no hay PIN (acceso libre)'
);

// Archivo temporal ilegible
const tmp = path.join(os.tmpdir(), `walkie-${Date.now()}.json`);
fs.writeFileSync(tmp, '{ esto no es json }');
let threw = false;
try {
  loadConfig({ env: {}, configPath: tmp });
} catch (error) {
  threw = error.message.includes('config.json no es JSON válido');
}
check(threw, 'da un error claro si config.json está corrupto');
fs.unlinkSync(tmp);

const sinArchivo = loadConfig({ env: {}, configPath: path.join(os.tmpdir(), 'no-existe-walkie.json') });
check(sinArchivo.config.rooms.length === 1, 'arranca con valores por defecto si no hay archivo');

console.log('\nSERVIDOR CON VARIABLES DE ENTORNO');
const PORT = 3499 + Math.floor(Math.random() * 300);
const child = spawn('node', ['server.js'], {
  env: {
    ...process.env,
    PORT: String(PORT),
    PIN: 'entorno-99',
    APP_NAME: 'Bar Lagos',
    TAGLINE: 'Cocina y sala conectadas',
    MAX_ALERT_SECONDS: '12',
    ALERTS_ENABLED: 'false',
    ROOMS: JSON.stringify([{ id: 'cocina', name: 'Cocina', emoji: '🍳' }]),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', (d) => (output += d));
child.stderr.on('data', (d) => (output += d));

let ready = false;
for (let i = 0; i < 60 && !ready; i++) {
  await wait(100);
  ready = output.includes('Escuchando');
}
check(ready, 'el servidor arranca con variables de entorno');
check(output.includes('Avisos prioritarios: no'), 'respeta ALERTS_ENABLED=false');
check(!output.includes('⚠️'), 'no avisa de nada cuando la configuración del entorno es correcta');

const cfg = await (await fetch(`http://127.0.0.1:${PORT}/api/config`)).json();
check(cfg.appName === 'Bar Lagos', 'la API devuelve el nombre del entorno');
check(cfg.requiresPin === true, 'exige el PIN configurado');
check(cfg.alertsEnabled === false, 'desactiva los avisos también en la API');
check(cfg.maxAlertSeconds === 12, 'devuelve el límite de aviso configurado');
check(cfg.rooms.length === 1 && cfg.rooms[0].emoji === '🍳', 'usa los canales del entorno');

const health = await (await fetch(`http://127.0.0.1:${PORT}/healthz`)).json();
check(health.ok === true && typeof health.uptimeSeconds === 'number', 'healthz informa de estado y uptime');
check(typeof health.version === 'string', 'healthz informa de la versión');

child.kill('SIGTERM');
await wait(300);
check(child.exitCode === 0 || child.signalCode === 'SIGTERM', 'se cierra limpiamente con SIGTERM');

console.log('\nAVISOS AL ARRANCAR CON EL PIN DE EJEMPLO');
const PORT2 = PORT + 1;
const child2 = spawn('node', ['server.js'], {
  env: { ...process.env, PORT: String(PORT2), PIN: 'lagos' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out2 = '';
child2.stdout.on('data', (d) => (out2 += d));
let ready2 = false;
for (let i = 0; i < 60 && !ready2; i++) {
  await wait(100);
  ready2 = out2.includes('Escuchando');
}
check(out2.includes('⚠️') && out2.includes('PIN de ejemplo'), 'el servidor avisa del PIN de ejemplo al arrancar');
child2.kill('SIGTERM');
await wait(250);

console.log(failures === 0 ? '\nTODO OK\n' : `\n${failures} FALLOS\n`);
process.exit(failures === 0 ? 0 : 1);

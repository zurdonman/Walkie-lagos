#!/usr/bin/env node
/**
 * Revisa la configuración antes de abrir el restaurante.
 *
 *   npm run check
 *
 * Lee config.json + variables de entorno (igual que el servidor) y avisa de lo
 * que suele dar problemas en el local: PIN de ejemplo, canales repetidos, etc.
 */
'use strict';

const { loadConfig } = require('../lib/config');

const { config, warnings, source } = loadConfig();

const ok = (label, value) => console.log(`  ✓ ${label}: ${value}`);
const bad = (label, value) => console.log(`  ✗ ${label}: ${value}`);

console.log('\nWalkie Lagos — comprobación de configuración\n');
console.log(`  Archivo: ${source.file}`);
console.log(`  Variables de entorno aplicadas: ${source.envKeys.length ? source.envKeys.join(', ') : 'ninguna'}\n`);

console.log('  APLICACIÓN');
ok('Nombre', config.appName);
ok('Lema', config.tagline);
ok('PIN', config.pin ? 'definido' : 'SIN PIN (acceso libre)');
ok('Máximo por intervención', `${config.maxTalkSeconds} s`);
ok('Avisos prioritarios', config.alertsEnabled ? `sí (máx. ${config.maxAlertSeconds} s)` : 'desactivados');

console.log('\n  CANALES');
for (const room of config.rooms) {
  console.log(`    ${room.emoji}  ${room.name.padEnd(14)} (id: ${room.id})`);
}

if (warnings.length) {
  console.log('\n  AVISOS');
  for (const warning of warnings) bad('atención', warning);
} else {
  console.log('\n  Sin avisos: la configuración parece correcta.');
}

const blocking = !config.rooms.length;
console.log(
  blocking
    ? '\n  Hay errores que impiden arrancar.\n'
    : '\n  Listo. Arranca con:  npm start   (o  docker compose up -d  en el local)\n'
);
process.exit(blocking ? 1 : 0);

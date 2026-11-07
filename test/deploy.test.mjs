/**
 * Coherencia del kit de despliegue: Dockerfile, docker-compose, Caddyfile,
 * .env.example y .dockerignore. No necesita Docker instalado.
 *
 *   node test/deploy.test.mjs
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const YAML = require('yaml');

let failures = 0;
function check(cond, msg) {
  console.log(`  ${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) failures += 1;
}
const read = (file) => fs.readFileSync(file, 'utf8');

console.log('\nDOCKERFILE');
const dockerfile = read('Dockerfile');
check(/^FROM node:\d+-alpine/m.test(dockerfile), 'usa una imagen oficial de Node en Alpine');
check(dockerfile.includes('npm ci --omit=dev'), 'instala solo dependencias de producción');
check(dockerfile.includes('USER walkie'), 'no corre como root');
check(dockerfile.includes('HEALTHCHECK'), 'define healthcheck');
check(dockerfile.includes('EXPOSE 3000'), 'expone el puerto 3000');

const copies = dockerfile
  .split('\n')
  .filter((line) => line.startsWith('COPY '))
  .map((line) => line.replace(/--chown=\S+ /, '').split(/\s+/).slice(1, -1));
const needed = [...new Set(['server.js', 'package.json', 'public', 'lib', 'config.json'])];
for (const item of needed) {
  check(copies.some((sources) => sources.includes(item) || sources.includes(`./${item}`)), `copia ${item} a la imagen`);
}
check(copies.some((sources) => sources.includes('server.js')), 'copia el servidor');
check(copies.some((sources) => sources.includes('config.json')), 'copia la configuración por defecto');
check(dockerfile.includes('package-lock.json'), 'usa el lockfile');
check(!/COPY[^\n]*test/.test(dockerfile), 'no mete las pruebas en la imagen');

console.log('\nDOCKER-COMPOSE');
const compose = YAML.parse(read('docker-compose.yml'));
check(Object.keys(compose.services).join(',') === 'walkie,caddy', 'define la app y Caddy');
const app = compose.services.walkie;
const env = app.environment;
check(String(env.PIN).includes(':?'), 'el PIN es obligatorio (no arranca sin él)');
check(env.PORT === '3000', 'la app escucha en el puerto interno 3000');
check(app.expose?.includes('3000'), 'expone el puerto solo a la red interna');
check(!app.ports, 'no publica la app directamente (todo pasa por Caddy)');
check(compose.services.caddy.ports.includes('443:443'), 'Caddy publica HTTPS');
check(compose.services.caddy.ports.includes('80:80'), 'Caddy publica HTTP para el desafío de Let\'s Encrypt');
check(compose.services.caddy.depends_on.includes('walkie'), 'Caddy espera a la app');
check(Boolean(compose.services.caddy.volumes.some((v) => v.includes('Caddyfile'))), 'monta el Caddyfile');
check(fs.existsSync('deploy/Caddyfile'), 'el Caddyfile existe de verdad');
check(app.restart === 'unless-stopped' && compose.services.caddy.restart === 'unless-stopped', 'se reinician solos');

const envExample = Object.fromEntries(
  read('.env.example')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])
);
check(envExample.DOMAIN, '.env.example define DOMAIN');
check(envExample.PIN && envExample.PIN !== 'lagos', '.env.example no trae el PIN por defecto');
for (const key of ['APP_NAME', 'MAX_TALK_SECONDS', 'ALERTS_ENABLED']) {
  check(key in envExample, `.env.example documenta ${key}`);
}
check(
  Object.keys(env).every((key) => key === 'PORT' || key === 'ROOMS' || key in envExample),
  'todas las variables del compose están en .env.example'
);

console.log('\nCADDY');
const caddy = read('deploy/Caddyfile');
check(caddy.includes('{$DOMAIN}'), 'usa el dominio del entorno');
check(caddy.includes('reverse_proxy walkie:3000'), 'apunta al servicio de la app');
check(caddy.includes('Permissions-Policy') && caddy.includes('microphone=(self)'), 'permite el micrófono');
check(caddy.includes('Strict-Transport-Security'), 'activa HSTS');

console.log('\nDOCKERIGNORE');
const dockerignore = read('.dockerignore');
check(dockerignore.includes('node_modules'), 'no copia node_modules del host');
check(dockerignore.includes('.env'), 'no copia secretos (.env)');
check(dockerignore.includes('.git'), 'no copia el historial');

console.log('\nPAQUETE');
const pkg = require('../package.json');
check(pkg.scripts.check, 'existe el script de comprobación');
check(pkg.scripts.test.includes('deploy'), 'las pruebas incluyen este archivo');
check(!/test/.test(JSON.stringify(pkg.dependencies)), 'las dependencias de producción no incluyen pruebas');

console.log(failures === 0 ? '\nTODO OK\n' : `\n${failures} FALLOS\n`);
process.exit(failures === 0 ? 0 : 1);

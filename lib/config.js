/**
 * Carga y validación de configuración.
 *
 * Orden de prioridad: variables de entorno > config.json > valores por defecto.
 * Así el mismo repo sirve para probar en casa y para desplegar en el local
 * (por ejemplo con docker-compose y un archivo .env) sin tocar el JSON.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  appName: 'Walkie Lagos',
  tagline: 'Radio interna del restaurante',
  pin: '',
  maxTalkSeconds: 45,
  maxAlertSeconds: 25,
  alertsEnabled: true,
  rooms: [{ id: 'general', name: 'General', emoji: '📢' }],
};

const MAX_ROOMS = 12;

/** "Cocina Fría" -> "cocina-fria" */
function slugify(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
const ROOM_ID_RE = /^[a-z0-9][a-z0-9_-]{0,23}$/;

function toBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'si', 'sí', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function toPositiveInt(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.round(number);
}

function readConfigFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error(`config.json no es JSON válido: ${error.message}`);
  }
}

function normalizeRooms(raw, warnings) {
  if (!Array.isArray(raw) || raw.length === 0) {
    warnings.push('No hay canales definidos: se usará uno llamado "General".');
    return DEFAULTS.rooms.map((room) => ({ ...room }));
  }
  const seen = new Set();
  const rooms = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    // Los identificadores los solemos escribir a mano ("Cocina Fría"): se
    // normalizan. Si no se pueden normalizar, se descarta el canal.
    let id = String(entry.id ?? '').trim() ? slugify(entry.id) : slugify(entry.name ?? '');
    if (!ROOM_ID_RE.test(id)) {
      warnings.push(`Canal ignorado: el identificador "${entry.id ?? ''}" no vale (usa minúsculas, números y guiones).`);
      continue;
    }
    if (seen.has(id)) {
      warnings.push(`Canal duplicado ignorado: "${id}".`);
      continue;
    }
    seen.add(id);
    rooms.push({
      id,
      name: String(entry.name ?? id).trim().slice(0, 24) || id,
      emoji: String(entry.emoji ?? '📻').slice(0, 8) || '📻',
      color: typeof entry.color === 'string' ? entry.color : undefined,
    });
    if (rooms.length >= MAX_ROOMS) {
      warnings.push(`Solo se usan los primeros ${MAX_ROOMS} canales.`);
      break;
    }
  }
  if (!rooms.length) {
    warnings.push('Ningún canal válido: se usará uno llamado "General".');
    return DEFAULTS.rooms.map((room) => ({ ...room }));
  }
  return rooms;
}

/**
 * @param {{ env?: NodeJS.ProcessEnv, configPath?: string }} options
 * @returns {{ config: object, warnings: string[], source: {file: string, envKeys: string[]} }}
 */
function loadConfig(options = {}) {
  const env = options.env || process.env;
  const configPath = options.configPath || path.join(__dirname, '..', 'config.json');
  const fileConfig = readConfigFile(configPath);
  const warnings = [];
  const envKeys = [];

  const trackEnv = (envName) => {
    if (env[envName] !== undefined && !envKeys.includes(envName)) envKeys.push(envName);
  };

  const pick = (envName, fallback) => {
    const value = env[envName];
    if (value === undefined || value === '') return fallback;
    envKeys.push(envName);
    return value;
  };

  let roomsRaw = fileConfig.rooms;
  const roomsEnv = pick('ROOMS', undefined);
  if (roomsEnv !== undefined) {
    try {
      roomsRaw = JSON.parse(roomsEnv);
    } catch {
      warnings.push('La variable ROOMS no es JSON válido: se ignoran los canales del entorno.');
      roomsRaw = fileConfig.rooms;
    }
  }

  const config = {
    appName: String(pick('APP_NAME', fileConfig.appName ?? DEFAULTS.appName)).slice(0, 40),
    tagline: String(pick('TAGLINE', fileConfig.tagline ?? DEFAULTS.tagline)).slice(0, 80),
    pin: String((trackEnv('PIN'), env.PIN !== undefined) ? env.PIN : fileConfig.pin ?? DEFAULTS.pin).trim(),
    maxTalkSeconds: Math.min(
      300,
      toPositiveInt(pick('MAX_TALK_SECONDS', fileConfig.maxTalkSeconds), DEFAULTS.maxTalkSeconds)
    ),
    maxAlertSeconds: Math.min(
      120,
      toPositiveInt(pick('MAX_ALERT_SECONDS', fileConfig.maxAlertSeconds), DEFAULTS.maxAlertSeconds)
    ),
    alertsEnabled: toBool(pick('ALERTS_ENABLED', fileConfig.alertsEnabled), DEFAULTS.alertsEnabled),
    rooms: normalizeRooms(roomsRaw, warnings),
  };

  if (!config.pin) {
    warnings.push('No hay PIN: cualquiera que llegue a la URL puede entrar. Define "pin" en config.json o la variable PIN.');
  } else if (config.pin.length < 4) {
    warnings.push('El PIN es muy corto (menos de 4 caracteres).');
  } else if (config.pin === 'lagos') {
    warnings.push('Estás usando el PIN de ejemplo ("lagos"). Cámbialo antes de dejarlo en el local.');
  }

  return {
    config,
    warnings,
    source: { file: configPath, envKeys },
  };
}

module.exports = { loadConfig, DEFAULTS, MAX_ROOMS };

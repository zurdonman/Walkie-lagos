/**
 * Walkie Lagos — protocolo de radio local (sin servidor).
 *
 * Cada móvil manda y recibe paquetes UDP a un grupo multicast de la wifi:
 * el único "host" es el router. La app Android implementa exactamente este
 * formato (ver android/.../LanRadio.kt y LanPacket.kt).
 *
 * Paquete (big endian en todos los números):
 *   0..3    "WLK1"            magic
 *   4       versión (1)
 *   5       tipo              0x41 audio | 0x54 texto | 0x43 empiezo a hablar
 *                             0x45 termino | 0x48 latido | 0x4C salgo
 *   6       canal             índice en ROOMS
 *   7       longitud del nombre (n, 0..16)
 *   8..15   nodeId            8 bytes aleatorios, fijos por instalación
 *   16..    nombre            UTF-8, n bytes
 *   ...     payload           audio PCM16 LE | texto UTF-8 | vacío
 *
 * Tamaños: audio 640 B (20 ms a 16 kHz) + cabecera ≈ 670 B, por debajo del MTU.
 */
import crypto from 'node:crypto';

export const GROUP = '239.255.43.43';
export const PORT = 45454;
export const MAGIC = Buffer.from('WLK1');
export const VERSION = 1;
export const MAX_NAME = 16;
// Texto por paquete: 16 cabecera + 16 nombre + 1200 payload < 1400 (no se fragmenta).
export const MAX_TEXT_BYTES = 1200;
export const SAMPLE_RATE = 16000;
export const FRAME_SAMPLES = SAMPLE_RATE / 50; // 640 bytes

// El índice es lo que viaja en el paquete (byte 6): no reordenar sin subir la versión.
export const ROOMS = [
  { id: 'general', name: 'General', emoji: '📢' },
  { id: 'cocina', name: 'Cocina', emoji: '🍳' },
  { id: 'comedor', name: 'Comedor', emoji: '🍽️' },
  { id: 'barra', name: 'Barra', emoji: '🍺' },
  { id: 'terraza', name: 'Terraza', emoji: '☀️' },
];

export const TYPE = {
  audio: 0x41,
  chat: 0x54,
  claim: 0x43,
  end: 0x45,
  heartbeat: 0x48,
  leave: 0x4c,
};

export function encode({ type, room, nodeId, name, payload = Buffer.alloc(0) }) {
  const nameBytes = Buffer.from(String(name ?? '').slice(0, MAX_NAME), 'utf8');
  const header = Buffer.alloc(16);
  MAGIC.copy(header, 0);
  header[4] = VERSION;
  header[5] = type;
  header[6] = roomIndex(room);
  header[7] = nameBytes.length;
  Buffer.from(nodeId, 'hex').copy(header, 8, 0, 8);
  return Buffer.concat([header, nameBytes, payload]);
}

export function decode(buffer) {
  if (buffer.length < 16) return null;
  if (!buffer.subarray(0, 4).equals(MAGIC)) return null;
  if (buffer[4] !== VERSION) return null;
  const nameLength = Math.min(buffer[7], MAX_NAME);
  if (16 + nameLength > buffer.length) return null;
  return {
    type: buffer[5],
    room: ROOMS[buffer[6]]?.id ?? ROOMS[0].id,
    nodeId: buffer.subarray(8, 16).toString('hex'),
    name: buffer.subarray(16, 16 + nameLength).toString('utf8'),
    payload: buffer.subarray(16 + nameLength),
  };
}

export function roomIndex(roomId) {
  const index = ROOMS.findIndex((r) => r.id === roomId || r.name.toLowerCase() === String(roomId).toLowerCase());
  return index < 0 ? 0 : index;
}

export function newNodeId() {
  return crypto.randomBytes(8).toString('hex');
}

/** Quién gana cuando dos empiezan a hablar a la vez: nodeId menor. */
export function hasPriority(mine, theirs) {
  return String(mine) < String(theirs);
}

/** Trocea PCM de un bloque en paquetes de 20 ms. */
export function splitAudio(pcm) {
  const packets = [];
  for (let offset = 0; offset + FRAME_SAMPLES * 2 <= pcm.length; offset += FRAME_SAMPLES * 2) {
    packets.push(pcm.subarray(offset, offset + FRAME_SAMPLES * 2));
  }
  return packets;
}

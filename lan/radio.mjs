/**
 * Walkie Lagos sin servidor: radio por multicast sobre la wifi.
 *
 * No hay host central. Cada nodo:
 *   - escucha el grupo multicast,
 *   - reclama el turno de palabra con un paquete "claim" y lo defiende con "latido",
 *   - si dos reclaman a la vez, gana el nodeId menor (regla determinista),
 *   - manda el audio en paquetes de 20 ms y el texto como paquete propio.
 *
 * Este archivo es la implementación de referencia del protocolo (la usa la
 * versión de escritorio y las pruebas). La app Android hace lo mismo en Kotlin.
 */
import dgram from 'node:dgram';
import os from 'node:os';
import {
  GROUP,
  MAX_TEXT_BYTES,
  PORT,
  ROOMS,
  TYPE,
  decode,
  encode,
  hasPriority,
  newNodeId,
  splitAudio,
} from './protocol.mjs';

export class LanRadio {
  /**
   * @param {object} options
   * @param {string} options.name        nombre visible (máx. 16)
   * @param {string} options.room        canal inicial
   * @param {string} [options.nodeId]    identidad fija (8 bytes hex)
   * @param {(event:object)=>void} [options.onEvent]
   */
  constructor({ name, room = 'general', nodeId = newNodeId(), onEvent = () => {} }) {
    this.nodeId = nodeId;
    this.name = name;
    this.room = room;
    this.onEvent = onEvent;
    this.talking = false;
    this.speaker = null; // { nodeId, name, at }
    this.peers = new Map(); // nodeId -> { name, at, room }
    this.socket = null;
    this.heartbeat = null;
    this.watchdog = null;
    this.lastClaimAt = 0;
  }

  /** Abre los dos sockets: escucha y envío. */
  start({ interfaceName } = {}) {
    this.interfaceName = interfaceName;
    this.rx = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.tx = dgram.createSocket({ type: 'udp4' });
    this.tx.bind(() => {
      try {
        this.tx.setMulticastInterface(interfaceName);
      } catch {}
      try {
        this.tx.setMulticastTTL(1);
        // El loopback permite probar dos nodos en la misma máquina y que la app
        // se oiga a sí misma en un mismo móvil; entre móviles no cambia nada.
        this.tx.setMulticastLoopback(true);
      } catch {}
    });

    this.rx.on('message', (message, remote) => this.receive(message, remote));
    this.rx.on('error', (error) => this.onEvent({ type: 'error', message: error.message }));
    return new Promise((resolve, reject) => {
      this.rx.once('error', reject);
      this.rx.bind(PORT, () => {
        try {
          this.rx.addMembership(GROUP, interfaceName);
          this.rx.setMulticastLoopback(true);
        } catch (error) {
          return reject(new Error(`No se puede unir al grupo multicast: ${error.message}`));
        }
        this.heartbeat = setInterval(() => this.sendHeartbeat(), 2000);
        this.watchdog = setInterval(() => this.sweep(), 1000);
        this.sendHeartbeat();
        resolve(this);
      });
    });
  }

  /**
   * Se despide y cierra. El "adiós" se manda dos veces (UDP puede perderlo) y
   * se espera un poco antes de cerrar el socket: cerrar en el acto descarta el
   * paquete que aún no había salido.
   */
  async stop({ waitMs = 120 } = {}) {
    clearInterval(this.heartbeat);
    clearInterval(this.watchdog);
    if (this.talking) {
      this.talking = false;
      this.send(TYPE.end);
    }
    this.send(TYPE.leave);
    this.send(TYPE.leave);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    try {
      this.rx?.dropMembership(GROUP, this.interfaceName);
    } catch {}
    try {
      this.rx?.close();
      this.tx?.close();
    } catch {}
  }

  // ------------------------------------------------------------------ envío

  send(type, payload = Buffer.alloc(0)) {
    const packet = encode({ type, room: this.room, nodeId: this.nodeId, name: this.name, payload });
    this.tx?.send(packet, 0, packet.length, PORT, GROUP);
  }

  sendHeartbeat() {
    this.send(TYPE.heartbeat);
    if (this.talking) this.send(TYPE.claim);
  }

  /** Manda audio PCM16 (640 bytes por paquete). */
  sendAudio(pcm) {
    if (!this.talking) return;
    for (const frame of splitAudio(pcm)) this.send(TYPE.audio, frame);
  }

  sendChat(text) {
    // Antes se recortaba a 200 caracteres sin avisar. Ahora cabe un mensaje entero.
    const bytes = Buffer.from(String(text), 'utf8');
    this.send(TYPE.chat, bytes.subarray(0, MAX_TEXT_BYTES));
  }

  setRoom(room) {
    this.room = room;
    this.speaker = null;
    this.send(TYPE.leave); // los demás dejan de contar con nosotros en el canal viejo
    this.sendHeartbeat();
    this.onEvent({ type: 'room', room });
  }

  // ---------------------------------------------------------------- turno

  /** Pide la palabra. Devuelve true si la tiene (puede perder contra un nodeId menor). */
  claimTalk() {
    this.lastClaimAt = Date.now();
    this.talking = true;
    this.send(TYPE.claim);
    return true;
  }

  releaseTalk() {
    if (!this.talking) return;
    this.talking = false;
    this.send(TYPE.end);
  }

  // --------------------------------------------------------------- escucha

  receive(message, remote) {
    const packet = decode(message);
    if (!packet) return;
    if (packet.nodeId === this.nodeId) return; // lo nuestro, ignorar
    if (packet.room !== this.room) return;

    const peer = this.peers.get(packet.nodeId) ?? { name: packet.name, at: Date.now(), room: packet.room };
    peer.name = packet.name || peer.name;
    peer.at = Date.now();
    this.peers.set(packet.nodeId, peer);

    switch (packet.type) {
      case TYPE.claim: {
        // Dos a la vez: el nodeId menor manda; el otro cede.
        if (this.talking && !hasPriority(this.nodeId, packet.nodeId)) {
          this.talking = false;
          this.onEvent({ type: 'preempted', by: peer.name });
        }
        if (!this.talking) {
          this.speaker = { nodeId: packet.nodeId, name: peer.name, at: Date.now() };
          this.onEvent({ type: 'speakerStart', from: peer.name, nodeId: packet.nodeId });
        }
        break;
      }
      case TYPE.audio: {
        if (this.talking) break; // nosotros tenemos la palabra
        this.speaker = { nodeId: packet.nodeId, name: peer.name, at: Date.now() };
        this.onEvent({ type: 'audio', from: peer.name, data: packet.payload });
        break;
      }
      case TYPE.end: {
        if (this.speaker?.nodeId === packet.nodeId) {
          this.speaker = null;
          this.onEvent({ type: 'speakerEnd', from: peer.name });
        }
        break;
      }
      case TYPE.chat: {
        this.onEvent({ type: 'chat', from: peer.name, text: packet.payload.toString('utf8') });
        break;
      }
      case TYPE.heartbeat: {
        this.onEvent({ type: 'peer', from: peer.name, count: this.peers.size + 1 });
        break;
      }
      case TYPE.leave: {
        this.peers.delete(packet.nodeId);
        if (this.speaker?.nodeId === packet.nodeId) {
          this.speaker = null;
          this.onEvent({ type: 'speakerEnd', from: peer.name });
        }
        break;
      }
      default:
        break;
    }
  }

  /** Quien deja de latir durante 7 s desaparece de la lista. */
  sweep() {
    const now = Date.now();
    let changed = false;
    for (const [nodeId, peer] of this.peers) {
      if (now - peer.at > 7000) {
        this.peers.delete(nodeId);
        changed = true;
        if (this.speaker?.nodeId === nodeId) {
          this.speaker = null;
          this.onEvent({ type: 'speakerEnd', from: peer.name });
        }
      }
    }
    if (this.speaker && now - this.speaker.at > 4000) {
      this.speaker = null;
      this.onEvent({ type: 'speakerEnd', from: 'silencio' });
    }
    if (changed) this.onEvent({ type: 'peer', count: this.peers.size + 1 });
  }

  get onlineCount() {
    return this.peers.size + 1;
  }
}

/** Interfaces de red útiles para elegir la wifi. */
export function networkInterfaces() {
  return Object.entries(os.networkInterfaces())
    .flatMap(([name, addresses]) =>
      (addresses ?? []).map((address) => ({
        name,
        address: address.address,
        family: address.family,
        internal: address.internal,
      }))
    )
    .filter((i) => i.family === 'IPv4' && !i.internal);
}

export { GROUP, PORT, ROOMS };

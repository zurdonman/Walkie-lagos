/**
 * Prueba de la interfaz sin navegador (jsdom), con WebSocket y audio simulados.
 * Uso: node test/ui.test.mjs
 */
import { JSDOM } from 'jsdom';
import fs from 'node:fs';

const dom = new JSDOM(fs.readFileSync('public/index.html', 'utf8'), {
  url: 'http://127.0.0.1:3333/',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
});
const { window } = dom;
const doc = window.document;

let failures = 0;
function check(cond, msg) {
  console.log(`  ${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) failures += 1;
}

const sent = [];
let socket = null;
let played = 0;

class FakeWS {
  static OPEN = 1;
  constructor() {
    socket = this;
    this.readyState = 0;
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.();
    }, 3);
  }
  send(data) {
    if (typeof data === 'string') sent.push(JSON.parse(data));
  }
  close() {}
}

window.WebSocket = FakeWS;
window.fetch = async () => ({
  json: async () => ({
    appName: 'Walkie Lagos',
    requiresPin: true,
    maxTalkSeconds: 45,
    rooms: [
      { id: 'general', name: 'General', emoji: '📢' },
      { id: 'cocina', name: 'Cocina', emoji: '🍳' },
    ],
  }),
});
window.isSecureContext = true;
window.URL.createObjectURL = () => 'blob:fake';
window.URL.revokeObjectURL = () => {};
window.navigator.vibrate = () => true;
window.navigator.mediaDevices = {
  getUserMedia: async () => ({
    getAudioTracks: () => [{ readyState: 'live' }],
    getTracks: () => [{ stop() {} }],
  }),
};
window.AudioContext = class {
  constructor() {
    this.state = 'running';
    this.sampleRate = 48000;
    this.currentTime = 0;
    this.destination = {};
  }
  resume() {
    return Promise.resolve();
  }
  createMediaStreamSource() {
    return { connect() {}, disconnect() {} };
  }
  createGain() {
    return { gain: { value: 1 }, connect: (n) => n, disconnect() {} };
  }
  createBufferSource() {
    played += 1;
    return { connect() {}, start() {}, stop() {} };
  }
  createBuffer(ch, len, rate) {
    return { duration: len / rate, copyToChannel() {} };
  }
  get audioWorklet() {
    return { addModule: async () => {} };
  }
};
window.AudioWorkletNode = class {
  constructor() {
    this.port = { onmessage: null, close() {} };
  }
  connect(n) {
    return n;
  }
  disconnect() {}
};

const errors = [];
window.addEventListener('error', (e) => errors.push(e.message));
window.eval(fs.readFileSync('public/app.js', 'utf8'));
await new Promise((r) => setTimeout(r, 60));

const $ = (id) => doc.getElementById(id);
const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const submit = (el) => el.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
const press = (type) => $('ptt').dispatchEvent(new window.Event(type, { bubbles: true, cancelable: true }));
const receive = (payload) => socket.onmessage({ data: JSON.stringify(payload) });

console.log('\nENTRADA');
check($('loginRooms').children.length === 2, 'muestra los canales');
$('nameInput').value = 'Marta';
$('pinInput').value = 'lagos';
submit($('loginForm'));
await new Promise((r) => setTimeout(r, 40));
check(sent[0]?.type === 'join' && sent[0].name === 'Marta', 'entra con nombre y PIN');

receive({
  type: 'welcome',
  you: { id: 'u1', name: 'Marta', room: 'general' },
  rooms: [
    { id: 'general', name: 'General', emoji: '📢', count: 2, talking: null },
    { id: 'cocina', name: 'Cocina', emoji: '🍳', count: 0, talking: null },
  ],
  users: [
    { id: 'u1', name: 'Marta', talking: false },
    { id: 'u2', name: 'Luis', talking: false },
  ],
  history: [{ from: 'Luis', text: 'hola', ts: Date.now() }],
  maxTalkSeconds: 45,
});
await new Promise((r) => setTimeout(r, 30));
check($('login').hidden && !$('app').hidden, 'pasa a la pantalla principal');
check($('roster').children.length === 2, 'lista a los dos del canal');
check($('log').textContent.includes('hola'), 'recupera el chat anterior');

console.log('\nHABLAR');
press('pointerdown');
await new Promise((r) => setTimeout(r, 60));
check(sent.some((m) => m.type === 'talk' && m.on === true), 'pide el turno al mantener');
receive({ type: 'talkAccept', maxSeconds: 45 });
await new Promise((r) => setTimeout(r, 30));
check($('ptt').classList.contains('talking'), 'el botón muestra HABLANDO');
press('pointerup');
await new Promise((r) => setTimeout(r, 30));
check(sent.filter((m) => m.type === 'talk').at(-1)?.on === false, 'suelta el turno al dejar de pulsar');
check(!$('ptt').classList.contains('talking'), 'el botón vuelve a su sitio');

console.log('\nESCUCHAR');
receive({ type: 'talkStart', from: 'Luis' });
await new Promise((r) => setTimeout(r, 20));
check(!$('incoming').hidden && $('incomingName').textContent === 'Luis', 'avisa de quién habla');
socket.onmessage({ data: new Int16Array(640).fill(2000).buffer });
await new Promise((r) => setTimeout(r, 20));
check(played > 0, 'reproduce el audio que llega');
receive({ type: 'talkEnd', from: 'Luis' });
await new Promise((r) => setTimeout(r, 20));
check($('incoming').hidden, 'lo oculta al terminar');

console.log('\nCANAL OCUPADO');
receive({ type: 'talkDeny', by: 'Luis' });
await new Promise((r) => setTimeout(r, 20));
check($('toast').textContent.includes('Luis'), 'avisa de que Luis está hablando');

console.log('\nCHAT Y CANALES');
$('chatInput').value = 'Mesa 4';
submit($('chatForm'));
check(sent.some((m) => m.type === 'chat' && m.text === 'Mesa 4'), 'envía el mensaje');
click($('channelsBtn'));
check(!$('drawer').hidden && $('roomList').children.length === 2, 'abre la lista de canales');
click($('roomList').children[1]);
check(sent.some((m) => m.type === 'switch' && m.room === 'cocina'), 'pide cambiar de canal');
receive({ type: 'switched', room: 'cocina', users: [{ id: 'u1', name: 'Marta', talking: false }], history: [] });
await new Promise((r) => setTimeout(r, 20));
check($('roomName').textContent === 'Cocina' && $('drawer').hidden, 'cambia y cierra la lista');

console.log('\nMICRÓFONO BLOQUEADO');
window.navigator.mediaDevices.getUserMedia = async () => {
  throw new Error('NotAllowedError');
};
press('pointerdown');
await new Promise((r) => setTimeout(r, 60));
check($('toast').textContent.toLowerCase().includes('micrófono'), 'explica el problema');

console.log(`\nErrores JS: ${errors.length ? errors.join(' | ') : 'ninguno'}\n`);
process.exit(failures === 0 && errors.length === 0 ? 0 : 1);

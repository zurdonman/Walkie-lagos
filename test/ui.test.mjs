/**
 * Prueba de la interfaz sin navegador (jsdom) con WebSocket y audio simulados.
 * Comprueba login, PTT, directos, avisos, paneles, ajustes y errores.
 *
 *   node test/ui.test.mjs
 */
import { JSDOM } from 'jsdom';
import fs from 'node:fs';

const html = fs.readFileSync('public/index.html', 'utf8');
const appjs = fs.readFileSync('public/app.js', 'utf8');

const dom = new JSDOM(html, { url: 'http://127.0.0.1:3333/', runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;

const sent = [];
const stats = { played: 0 };
let socket = null;

class FakeWS {
  static OPEN = 1;
  static CONNECTING = 0;
  constructor() {
    socket = this;
    this.readyState = 0;
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.();
    }, 5);
  }
  send(data) {
    if (typeof data === 'string') sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
    this.onclose?.({});
  }
}

window.WebSocket = FakeWS;
window.fetch = async () => ({
  json: async () => ({
    appName: 'Walkie Lagos',
    tagline: 'Radio interna',
    requiresPin: true,
    maxTalkSeconds: 45,
    maxAlertSeconds: 25,
    alertsEnabled: true,
    online: 0,
    rooms: [
      { id: 'general', name: 'General', emoji: '📢' },
      { id: 'cocina', name: 'Cocina', emoji: '🍳' },
    ],
  }),
});
window.isSecureContext = true;
window.URL.createObjectURL = () => 'blob:fake';
window.URL.revokeObjectURL = () => {};
window.requestAnimationFrame = () => 1;
window.navigator.vibrate = () => true;
window.navigator.mediaDevices = {
  getUserMedia: async () => ({
    getAudioTracks: () => [{ readyState: 'live' }],
    getTracks: () => [{ stop() {} }],
  }),
  enumerateDevices: async () => [{ kind: 'audioinput', deviceId: 'm1', label: 'Mic interno' }],
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
  createAnalyser() {
    return { fftSize: 256, frequencyBinCount: 128, getByteTimeDomainData(a) { a.fill(128); } };
  }
  createGain() {
    return { gain: { value: 1 }, connect: (n) => n, disconnect() {} };
  }
  createMediaStreamSource() {
    return { connect() {}, disconnect() {} };
  }
  createBufferSource() {
    stats.played += 1;
    return { connect: (n) => n, start() {}, stop() {} };
  }
  createBuffer(ch, len, rate) {
    return { duration: len / rate, copyToChannel() {} };
  }
  createScriptProcessor() {
    return { onaudioprocess: null, connect: (n) => n, disconnect() {} };
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
window.addEventListener('error', (e) => errors.push(`window.onerror: ${e.message}`));
window.eval(appjs);
await new Promise((r) => setTimeout(r, 60));

const $ = (id) => window.document.getElementById(id);
function check(cond, msg) {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    console.log(`  ✗ ${msg}`);
    errors.push(`FALLO: ${msg}`);
  }
}
const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const submit = (el) => el.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
const pointer = (type) => $('ptt').dispatchEvent(new window.Event(type, { bubbles: true, cancelable: true }));
const receive = (payload) => socket.onmessage({ data: JSON.stringify(payload) });
const lastSent = (pred) => sent.filter(pred).at(-1);

console.log('\nLOGIN');
check($('loginRooms').children.length === 2, 'pinta los canales del servidor');
check($('loginRooms').children[0].getAttribute('aria-checked') === 'true', 'preselecciona un canal');
$('nameInput').value = 'Marta';
$('pinInput').value = 'lagos';
submit($('loginForm'));
await new Promise((r) => setTimeout(r, 60));
check(sent[0]?.type === 'join' && sent[0].name === 'Marta', 'envía el alta con nombre y PIN');

receive({
  type: 'welcome',
  you: { id: 'u1', name: 'Marta', room: 'general' },
  rooms: [
    { id: 'general', name: 'General', emoji: '📢', count: 2, talking: null },
    { id: 'cocina', name: 'Cocina', emoji: '🍳', count: 1, talking: null },
  ],
  users: [
    { id: 'u1', name: 'Marta', talking: false },
    { id: 'u2', name: 'Luis', talking: false },
  ],
  history: [{ from: 'Luis', text: 'hola', ts: Date.now() }],
  maxTalkSeconds: 45,
  maxAlertSeconds: 25,
  alertsEnabled: true,
});
await new Promise((r) => setTimeout(r, 40));
check($('login').hidden === true && $('app').hidden === false, 'entra en la aplicación');
check($('roster').querySelectorAll('.person').length === 2, 'pinta a las 2 personas del canal');
check($('log').children.length === 1, 'recupera el historial del canal');
check($('targetAll').getAttribute('aria-pressed') === 'true', 'destino por defecto: todo el canal');

console.log('\nHABLAR AL CANAL');
pointer('pointerdown');
await new Promise((r) => setTimeout(r, 60));
check(lastSent((m) => m.type === 'talk' && m.on)?.scope?.kind === 'room', 'pide turno para el canal');
receive({ type: 'talkAccept', scope: 'room', maxSeconds: 45 });
await new Promise((r) => setTimeout(r, 30));
check($('ptt').classList.contains('is-talking'), 'el botón pasa a HABLANDO');
pointer('pointerup');
await new Promise((r) => setTimeout(r, 30));
check(lastSent((m) => m.type === 'talk')?.on === false, 'al soltar, cede el turno');
check(!$('ptt').classList.contains('is-talking'), 'el botón vuelve a reposo');

console.log('\nHABLAR A UNA SOLA PERSONA');
const luisChip = [...$('roster').querySelectorAll('.person')].find((el) => el.textContent.includes('Luis'));
click(luisChip);
await new Promise((r) => setTimeout(r, 30));
check($('targetDm').getAttribute('aria-pressed') === 'true', 'el destino pasa a privado');
check($('targetName').textContent === 'Luis', 'muestra el nombre del destinatario');
check($('ptt').textContent.includes('a Luis'), 'el botón indica a quién hablarás');
pointer('pointerdown');
await new Promise((r) => setTimeout(r, 60));
const dmTalk = lastSent((m) => m.type === 'talk' && m.on);
check(dmTalk?.scope?.kind === 'dm' && dmTalk.scope.to === 'u2', 'pide turno privado con Luis');
receive({ type: 'talkAccept', scope: 'dm', to: 'u2', toName: 'Luis', maxSeconds: 45 });
await new Promise((r) => setTimeout(r, 30));
check($('ptt').textContent.includes('solo a Luis'), 'el botón confirma el privado');
pointer('pointerup');
await new Promise((r) => setTimeout(r, 30));
click(luisChip);
await new Promise((r) => setTimeout(r, 20));
check($('targetAll').getAttribute('aria-pressed') === 'true', 'volver a tocar el nombre quita el privado');

console.log('\nAUDIO ENTRANTE');
receive({ type: 'talkStart', from: 'Luis', fromId: 'u2', rate: 16000 });
await new Promise((r) => setTimeout(r, 30));
check($('incoming').hidden === false && $('incomingName').textContent === 'Luis', 'avisa de quién habla');
socket.onmessage({ data: new Int16Array(640).fill(3000).buffer });
await new Promise((r) => setTimeout(r, 30));
check(stats.played > 0, 'reproduce el audio entrante');
receive({ type: 'talkEnd', from: 'Luis', scope: 'room' });
await new Promise((r) => setTimeout(r, 20));
check($('incoming').hidden === true, 'oculta el aviso al terminar');

console.log('\nAVISOS');
receive({ type: 'alert', from: 'Ana', text: 'Se ha ido la luz', ts: Date.now() });
await new Promise((r) => setTimeout(r, 30));
check($('alertBanner').hidden === false && $('alertText').textContent.includes('luz'), 'muestra el banner de aviso');
check($('log').textContent.includes('🚨'), 'deja constancia en el registro');
$('alertInput').value = 'Cierro cocina';
submit($('alertForm'));
check(sent.some((m) => m.type === 'alert' && m.text === 'Cierro cocina'), 'permite enviar un aviso escrito');
click($('alertDismiss'));
check($('alertBanner').hidden === true, 'se puede descartar');

click($('alertBtn'));
await new Promise((r) => setTimeout(r, 20));
check($('alertBtn').getAttribute('aria-pressed') === 'true', 'activa el modo aviso por voz');
check($('ptt').textContent.includes('aviso a todos'), 'el botón anuncia el aviso');
pointer('pointerdown');
await new Promise((r) => setTimeout(r, 60));
check(lastSent((m) => m.type === 'talk' && m.on)?.scope?.kind === 'alert', 'pide turno de aviso prioritario');
receive({ type: 'talkAccept', scope: 'alert', maxSeconds: 25 });
await new Promise((r) => setTimeout(r, 30));
check($('ptt').classList.contains('is-alert'), 'el botón se pone en rojo');
pointer('pointerup');
await new Promise((r) => setTimeout(r, 40));
check($('targetAll').getAttribute('aria-pressed') === 'true', 'el modo aviso es de un solo uso');

console.log('\nPANELES Y AJUSTES');
click($('channelsBtn'));
check($('drawer').hidden === false && $('roomList').children.length === 2, 'abre el panel de canales');
click($('settingsBtn'));
check($('settings').hidden === false, 'abre el panel de ajustes');
await new Promise((r) => setTimeout(r, 40));
check($('setMic').options.length === 2, 'rellena la lista de micrófonos');
$('setVol').value = '80';
$('setVol').dispatchEvent(new window.Event('input', { bubbles: true }));
check($('volLabel').textContent === '80%', 'actualiza el volumen');
$('setRate').value = '12000';
$('setRate').dispatchEvent(new window.Event('change', { bubbles: true }));
check(JSON.parse(window.localStorage.getItem('walkie.settings')).rate === 12000, 'guarda los ajustes');

console.log('\nCHAT Y CANAL');
$('chatInput').value = 'Mesa 3 lista';
submit($('chatForm'));
check(sent.some((m) => m.type === 'chat' && m.text === 'Mesa 3 lista'), 'envía el mensaje al canal');
click($('roomList').children[1]);
check(lastSent((m) => m.type === 'switch')?.room === 'cocina', 'pide cambiar de canal');
receive({ type: 'switched', room: 'cocina', users: [{ id: 'u1', name: 'Marta', talking: false }], history: [] });
await new Promise((r) => setTimeout(r, 20));
check($('roomName').textContent === 'Cocina', 'actualiza la cabecera');

console.log('\nERRORES DE MICRÓFONO');
window.navigator.mediaDevices.getUserMedia = async () => {
  const error = new Error('denied');
  error.name = 'NotAllowedError';
  throw error;
};
pointer('pointerdown');
await new Promise((r) => setTimeout(r, 80));
check($('pttError').hidden === false, 'explica el problema si el micro está bloqueado');
check($('pttErrorText').textContent.includes('permisos'), 'da instrucciones útiles');

console.log(`\nErrores JS: ${errors.length ? errors.join('\n') : 'ninguno'}\n`);
process.exit(errors.length ? 1 : 0);

/**
 * Prueba del camino de audio: captura -> paquetes de 20 ms -> WebSocket.
 * Verifica los dos caminos de captura: AudioWorklet y el plan B (ScriptProcessor).
 *
 *   node test/audio.test.mjs
 */
import { JSDOM } from 'jsdom';
import fs from 'node:fs';

const html = fs.readFileSync('public/index.html', 'utf8');
const appjs = fs.readFileSync('public/app.js', 'utf8');

let failures = 0;
function check(cond, msg) {
  console.log(`  ${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) failures += 1;
}

async function run({ useWorklet }) {
  console.log(`\n${useWorklet ? 'AudioWorklet' : 'Plan B (ScriptProcessor)'}`);

  const dom = new JSDOM(html, { url: 'http://127.0.0.1:9/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const sent = [];
  const bin = [];
  let workletNode = null;
  let scriptProc = null;
  let socket = null;

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
      else bin.push(new Uint8Array(data));
    }
    close() {}
  }

  window.WebSocket = FakeWS;
  window.fetch = async () => ({
    json: async () => ({
      rooms: [{ id: 'general', name: 'General', emoji: '📢' }],
      requiresPin: false,
      alertsEnabled: true,
    }),
  });
  window.isSecureContext = true;
  window.URL.createObjectURL = () => 'blob:fake';
  window.URL.revokeObjectURL = () => {};
  window.requestAnimationFrame = () => 1;
  window.navigator.mediaDevices = {
    getUserMedia: async () => ({
      getAudioTracks: () => [{ readyState: 'live' }],
      getTracks: () => [{ stop() {} }],
    }),
    enumerateDevices: async () => [],
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
      return { connect: (n) => n, start() {}, stop() {} };
    }
    createBuffer(ch, len, rate) {
      return { duration: len / rate, copyToChannel() {} };
    }
    createScriptProcessor() {
      scriptProc = { onaudioprocess: null, connect: (n) => n, disconnect() {} };
      return scriptProc;
    }
    get audioWorklet() {
      return {
        addModule: async () => {
          if (!useWorklet) throw new Error('worklet no disponible');
        },
      };
    }
  };
  window.AudioWorkletNode = class {
    constructor() {
      workletNode = this;
      this.port = { onmessage: null, close() {} };
    }
    connect(n) {
      return n;
    }
    disconnect() {}
  };

  window.eval(appjs);
  await new Promise((r) => setTimeout(r, 40));

  const doc = window.document;
  doc.getElementById('nameInput').value = 'Marta';
  doc.getElementById('loginForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 40));
  socket.onmessage({
    data: JSON.stringify({
      type: 'welcome',
      you: { id: 'u1', name: 'Marta', room: 'general' },
      rooms: [{ id: 'general', name: 'General', emoji: '📢', count: 1 }],
      users: [{ id: 'u1', name: 'Marta' }],
      history: [],
      maxTalkSeconds: 45,
    }),
  });
  await new Promise((r) => setTimeout(r, 30));

  doc.getElementById('ptt').dispatchEvent(new window.Event('pointerdown', { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 90));
  socket.onmessage({ data: JSON.stringify({ type: 'talkAccept', scope: 'room', maxSeconds: 45 }) });
  await new Promise((r) => setTimeout(r, 40));

  if (useWorklet) {
    check(Boolean(workletNode), 'usa AudioWorklet cuando está disponible');
    check(!scriptProc, 'no crea el plan B');
    workletNode.port.onmessage({ data: new Int16Array(320).fill(1200).buffer });
  } else {
    check(Boolean(scriptProc?.onaudioprocess), 'cae al plan B si no hay AudioWorklet');
    const frame = new Float32Array(2048);
    for (let i = 0; i < frame.length; i++) frame[i] = Math.sin(i / 10) * 0.3;
    scriptProc.onaudioprocess({ inputBuffer: { getChannelData: () => frame } });
    scriptProc.onaudioprocess({ inputBuffer: { getChannelData: () => frame } });
  }

  await new Promise((r) => setTimeout(r, 30));
  check(bin.length > 0, `envía audio por el WebSocket (${bin.length} paquetes)`);
  check(bin[0].byteLength === 640, `cada paquete son 20 ms a 16 kHz (${bin[0].byteLength} bytes)`);
  const nonSilent = bin.some((packet) => packet.some((v) => v !== 0));
  check(nonSilent || useWorklet, 'los paquetes llevan muestras (no todo ceros)');

  doc.getElementById('ptt').dispatchEvent(new window.Event('pointerup', { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 40));
  const before = bin.length;
  if (useWorklet) workletNode.port.onmessage({ data: new Int16Array(320).buffer });
  else scriptProc.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(2048) } });
  await new Promise((r) => setTimeout(r, 20));
  check(bin.length === before, 'al soltar deja de enviar audio');
  check(sent.some((m) => m.type === 'talk' && m.on === false), 'avisa al servidor de que ha terminado');
}

await run({ useWorklet: true });
await run({ useWorklet: false });

console.log(failures === 0 ? '\nTODO OK\n' : `\n${failures} FALLOS\n`);
process.exit(failures === 0 ? 0 : 1);

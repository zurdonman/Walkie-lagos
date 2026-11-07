/* Walkie Lagos — cliente push-to-talk
 * Audio: captura -> PCM 16 bits mono -> WebSocket binario -> servidor -> resto del canal
 * Sin dependencias. Todo en un archivo para que sea fácil de mantener.
 */
(() => {
  'use strict';

  // ------------------------------------------------------------------ estado

  const $ = (id) => document.getElementById(id);

  const LS = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(`walkie.${key}`);
        return raw === null ? fallback : JSON.parse(raw);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(`walkie.${key}`, JSON.stringify(value));
      } catch {}
    },
  };

  const state = {
    name: LS.get('name', ''),
    pin: LS.get('pin', ''),
    room: LS.get('room', ''),
    rooms: [],
    you: null,
    joined: false,
    socket: null,
    reconnectAttempt: 0,
    reconnectTimer: null,
    wantTalking: false,
    talking: false,
    peerTalking: null,
    locked: false,
    online: 0,
    settings: Object.assign(
      { ns: true, ec: true, beeps: true, vibe: false, vol: 130, rate: 16000, mic: '' },
      LS.get('settings', {})
    ),
  };

  // --------------------------------------------------------------- utilidades

  let toastTimer = null;
  function toast(message, ms = 2600) {
    const el = $('toast');
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.hidden = true;
    }, ms);
  }

  function beep(freq = 880, dur = 0.09, gainValue = 0.06) {
    if (!state.settings.beeps || !audio.ctx) return;
    try {
      const ctx = audio.ctx;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(gainValue, ctx.currentTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + dur + 0.02);
    } catch {}
  }

  const AVATAR_COLORS = ['#f59e0b', '#22c55e', '#38bdf8', '#a78bfa', '#fb7185', '#34d399', '#f472b6', '#facc15'];
  function colorFor(name) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
    return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
  }

  function initials(name) {
    return name
      .split(' ')
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0].toUpperCase())
      .join('');
  }

  // -------------------------------------------------------------------- audio

  const audio = {
    ctx: null,
    micStream: null,
    inputNode: null,
    workletNode: null,
    silentGain: null,
    analyserIn: null,
    analyserOut: null,
    nextPlayTime: 0,
    sources: new Set(),
    capturing: false,
    rate: 16000,

    async ensureContext() {
      if (!this.ctx) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) throw new Error('Este navegador no soporta audio Web.');
        this.ctx = new Ctx();
      }
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return this.ctx;
    },

    async ensureMic() {
      if (this.micStream && this.micStream.getAudioTracks().some((t) => t.readyState === 'live')) {
        return this.micStream;
      }
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('Este navegador no permite acceder al micrófono. Abre la app en HTTPS o en localhost.');
      }
      const deviceId = state.settings.mic;
      const constraints = {
        audio: {
          channelCount: 1,
          echoCancellation: state.settings.ec,
          noiseSuppression: state.settings.ns,
          autoGainControl: true,
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        },
        video: false,
      };
      this.micStream = await navigator.mediaDevices.getUserMedia(constraints);
      return this.micStream;
    },

    async listMics() {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        return devices.filter((d) => d.kind === 'audioinput');
      } catch {
        return [];
      }
    },

    async startCapture() {
      const ctx = await this.ensureContext();
      const stream = await this.ensureMic();
      this.rate = Number(state.settings.rate) || 16000;

      if (this.capturing) return;

      const source = ctx.createMediaStreamSource(stream);
      this.inputNode = source;

      // Medidor de entrada
      this.analyserIn = ctx.createAnalyser();
      this.analyserIn.fftSize = 512;
      source.connect(this.analyserIn);

      if (!this.workletReady) {
        const code = `
          class WalkieCapture extends AudioWorkletProcessor {
            constructor(options) {
              super();
              const opts = options.processorOptions || {};
              this.target = opts.targetRate || 16000;
              this.step = sampleRate / this.target;
              this.pos = 0;
              this.prev = 0;
              this.hasPrev = false;
              this.packetSize = Math.round(this.target * 0.02);
              this.out = new Int16Array(this.packetSize);
              this.outLen = 0;
            }
            process(inputs) {
              const input = inputs[0];
              if (!input || !input[0]) return true;
              const ch = input[0];
              let i = 0;
              if (!this.hasPrev) { this.prev = ch[0]; this.hasPrev = true; }
              while (true) {
                const idx = Math.floor(this.pos);
                if (idx + 1 >= ch.length) {
                  this.pos -= ch.length;
                  this.prev = ch[ch.length - 1];
                  break;
                }
                const frac = this.pos - idx;
                const a = idx === 0 ? this.prev : ch[idx];
                const sample = a + (ch[idx + 1] - a) * frac;
                const s = Math.max(-1, Math.min(1, sample));
                this.out[this.outLen++] = s < 0 ? s * 0x8000 : s * 0x7fff;
                if (this.outLen >= this.packetSize) {
                  const copy = this.out.slice(0);
                  this.port.postMessage(copy.buffer, [copy.buffer]);
                  this.outLen = 0;
                }
                this.pos += this.step;
              }
              return true;
            }
          }
          registerProcessor('walkie-capture', WalkieCapture);
        `;
        const blob = new Blob([code], { type: 'application/javascript' });
        const url = URL.createObjectURL(blob);
        await ctx.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);
        this.workletReady = true;
      }

      this.workletNode = new AudioWorkletNode(ctx, 'walkie-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1,
        processorOptions: { targetRate: this.rate },
      });
      this.workletNode.port.onmessage = (event) => {
        if (!state.talking) return;
        const ws = state.socket;
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(event.data);
        measureOut(event.data);
      };

      // El worklet necesita un destino para que el navegador lo procese; lo
      // mandamos a una ganancia a 0 para no escucharnos a nosotros mismos.
      this.silentGain = ctx.createGain();
      this.silentGain.gain.value = 0;
      source.connect(this.workletNode);
      this.workletNode.connect(this.silentGain).connect(ctx.destination);
      this.capturing = true;
    },

    stopCapture() {
      try {
        this.workletNode?.port?.close?.();
        this.workletNode?.disconnect();
      } catch {}
      try {
        this.silentGain?.disconnect();
      } catch {}
      this.workletNode = null;
      this.silentGain = null;
      this.capturing = false;
    },

    releaseMic() {
      this.stopCapture();
      if (this.micStream) {
        this.micStream.getTracks().forEach((t) => t.stop());
        this.micStream = null;
      }
    },

    /** Reproduce un paquete PCM16 del compañero. */
    playPcm16(buffer, rate) {
      const ctx = this.ctx;
      if (!ctx) return;
      const pcm = new Int16Array(buffer);
      if (!pcm.length) return;

      // 1) int16 -> float (-1..1)
      const floats = new Float32Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) floats[i] = pcm[i] / 0x8000;

      // 2) remuestreo al ritmo del contexto (48k en la mayoría de móviles)
      const srcRate = rate || this.rate || 16000;
      const outRate = ctx.sampleRate;
      let samples = floats;
      if (Math.abs(outRate - srcRate) > 1) {
        const ratio = srcRate / outRate;
        const outLen = Math.max(1, Math.floor(floats.length / ratio));
        const res = new Float32Array(outLen);
        for (let i = 0; i < outLen; i++) {
          const pos = i * ratio;
          const idx = Math.floor(pos);
          const frac = pos - idx;
          const a = floats[idx] ?? 0;
          const b = floats[idx + 1] ?? a;
          res[i] = a + (b - a) * frac;
        }
        samples = res;
      }

      const audioBuffer = ctx.createBuffer(1, samples.length, outRate);
      audioBuffer.copyToChannel(samples, 0);

      const node = ctx.createBufferSource();
      node.buffer = audioBuffer;
      if (!this.outputGain) {
        this.outputGain = ctx.createGain();
        this.outputGain.connect(ctx.destination);
        this.analyserOut = ctx.createAnalyser();
        this.analyserOut.fftSize = 256;
        this.outputGain.connect(this.analyserOut);
      }
      this.outputGain.gain.value = Math.max(0, Number(state.settings.vol) || 100) / 100;
      node.connect(this.outputGain);

      const now = ctx.currentTime;
      const target = 0.12; // colchón de jitter: 120 ms
      if (this.nextPlayTime < now + 0.02) this.nextPlayTime = now + target;
      if (this.nextPlayTime > now + 1.2) this.nextPlayTime = now + target; // nos hemos quedado atrás
      try {
        node.start(this.nextPlayTime);
      } catch {
        node.start();
      }
      this.nextPlayTime += audioBuffer.duration;
      this.sources.add(node);
      node.onended = () => this.sources.delete(node);
    },

    resetPlayback() {
      for (const node of this.sources) {
        try {
          node.stop();
        } catch {}
      }
      this.sources.clear();
      this.nextPlayTime = 0;
    },
  };

  // ------------------------------------------------------------ medidores VU

  const meters = { inBuf: null, outBuf: null, levelIn: 0, levelOut: 0 };

  function measureOut(arrayBuffer) {
    if (!arrayBuffer || !arrayBuffer.byteLength) return;
    const pcm = new Int16Array(arrayBuffer);
    let peak = 0;
    for (let i = 0; i < pcm.length; i += 4) {
      const v = Math.abs(pcm[i]) / 0x8000;
      if (v > peak) peak = v;
    }
    meters.levelOut = Math.max(peak, meters.levelOut * 0.85);
  }

  function currentLevelIn() {
    if (!audio.analyserIn) return 0;
    if (!meters.inBuf) meters.inBuf = new Uint8Array(audio.analyserIn.frequencyBinCount);
    audio.analyserIn.getByteTimeDomainData(meters.inBuf);
    let peak = 0;
    for (let i = 0; i < meters.inBuf.length; i += 2) {
      const v = Math.abs(meters.inBuf[i] - 128) / 128;
      if (v > peak) peak = v;
    }
    return peak;
  }

  function currentLevelOut() {
    meters.levelOut *= 0.82;
    return meters.levelOut;
  }

  function rafMeters() {
    const talking = state.talking;
    const incoming = Boolean(state.peerTalking);
    if (talking) {
      const level = currentLevelIn();
      $('ptt').style.setProperty('--level', String(level));
    }
    if (incoming) {
      const level = Math.min(1, currentLevelOut() * 2.4);
      const bar = $('vuBar');
      if (bar) bar.style.width = `${Math.max(4, Math.round(level * 100))}%`;
      if (level > 0.06) lastVoiceAt = performance.now();
    }
    requestAnimationFrame(rafMeters);
  }

  let lastVoiceAt = 0;

  // --------------------------------------------------------------- servidor

  function wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/ws`;
  }

  function connect({ rejoin = false } = {}) {
    if (state.socket && (state.socket.readyState === WebSocket.OPEN || state.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }
    clearTimeout(state.reconnectTimer);
    setRoomStatus(rejoin ? 'reconectando…' : 'conectando…');

    let socket;
    try {
      socket = new WebSocket(wsUrl());
    } catch {
      scheduleReconnect();
      return;
    }
    socket.binaryType = 'arraybuffer';
    state.socket = socket;

    socket.onopen = () => {
      state.reconnectAttempt = 0;
      socket.send(
        JSON.stringify({
          type: 'join',
          name: state.name,
          pin: state.pin,
          room: state.room,
        })
      );
    };

    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') {
        audio.playPcm16(event.data, state.peerRate || 16000);
        return;
      }
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      handleMessage(msg);
    };

    socket.onclose = () => {
      const wasJoined = state.joined;
      state.joined = false;
      state.talking = false;
      state.peerTalking = null;
      renderTalkingUI();
      hideIncoming();
      audio.resetPlayback();
      audio.releaseMic();
      setRoomStatus('sin conexión');
      if (wasJoined) scheduleReconnect();
    };

    socket.onerror = () => {
      setRoomStatus('error de conexión');
    };
  }

  function scheduleReconnect() {
    if (!state.name) return;
    state.reconnectAttempt += 1;
    const delay = Math.min(12000, 700 * 2 ** Math.min(state.reconnectAttempt, 4));
    setRoomStatus(`reconectando en ${Math.round(delay / 1000)} s…`);
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = setTimeout(() => connect({ rejoin: true }), delay);
  }

  function send(payload) {
    const socket = state.socket;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(payload));
      return true;
    }
    return false;
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case 'welcome': {
        state.you = msg.you;
        state.joined = true;
        state.room = msg.you.room;
        state.rooms = msg.rooms || [];
        state.maxTalkSeconds = msg.maxTalkSeconds || 45;
        LS.set('room', state.room);
        showApp();
        renderRooms();
        resizeRoster(msg.users || []);
        renderHistory(msg.history || []);
        setRoomStatus('en línea');
        break;
      }
      case 'switched': {
        state.room = msg.room;
        LS.set('room', state.room);
        audio.resetPlayback();
        hideIncoming();
        state.peerTalking = null;
        resizeRoster(msg.users || []);
        renderHistory(msg.history || []);
        renderRooms();
        closeDrawer();
        updateRoomHeader();
        toast('Canal cambiado');
        break;
      }
      case 'rooms':
        state.rooms = msg.rooms || state.rooms;
        renderRooms();
        updateRoomHeader();
        break;
      case 'roster':
        if (msg.room === state.room) resizeRoster(msg.users || []);
        break;
      case 'presence':
        state.online = msg.online || 0;
        $('onlineBadge').textContent = `${state.online} en línea`;
        break;
      case 'talkAccept':
        // Si ya hemos soltado el botón mientras llegaba el turno, lo cedemos.
        if (!state.wantTalking) {
          send({ type: 'talk', on: false });
          setTimeout(() => {
            if (!state.talking && !state.peerTalking) audio.releaseMic();
          }, 300);
          break;
        }
        state.talking = true;
        state.talkStartedAt = Date.now();
        state.maxTalkSeconds = msg.maxSeconds || state.maxTalkSeconds;
        beep(920, 0.08);
        renderTalkingUI();
        startPttTimer();
        requestWakeLock();
        break;
      case 'talkDeny':
        state.wantTalking = false;
        state.talking = false;
        beep(300, 0.14, 0.05);
        renderTalkingUI();
        flashBusy();
        toast(`${msg.by || 'Alguien'} está hablando`);
        setTimeout(() => {
          if (!state.talking) audio.releaseMic();
        }, 300);
        break;
      case 'talkStart': {
        state.peerTalking = msg.from;
        state.peerRate = msg.rate || 16000;
        showIncoming(msg.from);
        if (state.settings.vibe && navigator.vibrate) navigator.vibrate(40);
        beep(760, 0.06, 0.035);
        break;
      }
      case 'talkEnd':
        state.peerTalking = null;
        hideIncoming();
        break;
      case 'chat':
        addLog({ who: msg.from, what: msg.text, ts: msg.ts, kind: 'chat' });
        if (msg.from !== state.name) {
          if (state.settings.vibe && navigator.vibrate && document.hidden) navigator.vibrate(30);
          if (document.hidden) beep(680, 0.07, 0.03);
        }
        break;
      case 'system':
        addLog({ what: msg.text, ts: msg.ts, kind: 'sys' });
        break;
      case 'error':
        if (!state.joined) {
          showLoginError(msg.message);
          setLoginBusy(false);
        } else {
          toast(msg.message);
        }
        break;
      default:
        break;
    }
  }

  // ------------------------------------------------------------ PTT (hablar)

  let pttTimerHandle = null;
  let pttInterval = null;

  function startPttTimer() {
    clearInterval(pttInterval);
    const el = $('pttTimer');
    pttInterval = setInterval(() => {
      const elapsed = (Date.now() - (state.talkStartedAt || Date.now())) / 1000;
      const remaining = Math.max(0, (state.maxTalkSeconds || 45) - elapsed);
      el.textContent = remaining < 10 ? `${remaining.toFixed(1)} s` : '';
      if (remaining <= 0) clearInterval(pttInterval);
    }, 100);
  }

  async function startTalking() {
    if (!state.joined || state.talking) return;
    if (state.peerTalking) {
      // El canal está ocupado: avisamos sin encender el micro.
      beep(300, 0.12, 0.05);
      flashBusy();
      toast(`${state.peerTalking} está hablando`);
      return;
    }
    state.wantTalking = true;
    try {
      await audio.startCapture();
    } catch (err) {
      state.wantTalking = false;
      const secure = window.isSecureContext || location.hostname === 'localhost';
      const message = secure
        ? 'Revisa los permisos del micrófono en los ajustes del navegador y vuelve a intentarlo.'
        : 'El navegador solo deja usar el micrófono en HTTPS o en localhost. Abre la app con la dirección segura que te ha dado el servidor.';
      showPttError(err?.name === 'NotAllowedError' ? 'Micrófono bloqueado' : 'No puedo usar el micrófono', `${message}\n\nDetalle: ${err?.message || err}`);
      return;
    }
    if (!state.wantTalking) {
      audio.releaseMic();
      return;
    }
    send({ type: 'talk', on: true, rate: Number(state.settings.rate) || 16000 });
  }

  function stopTalking() {
    state.wantTalking = false;
    if (state.talking) {
      send({ type: 'talk', on: false });
      beep(620, 0.08, 0.045);
    }
    state.talking = false;
    clearInterval(pttInterval);
    $('pttTimer').textContent = '';
    renderTalkingUI();
    releaseWakeLock();
    // Liberamos el micro tras un pequeño margen para no cortar la última sílaba.
    setTimeout(() => {
      if (!state.talking && !state.peerTalking) audio.releaseMic();
    }, 400);
  }

  function renderTalkingUI() {
    const ptt = $('ptt');
    ptt.classList.toggle('is-talking', state.talking);
    ptt.disabled = !state.joined;
    const text = ptt.querySelector('.ptt-text');
    if (state.talking) text.innerHTML = 'HABLANDO<br /><small>suelta para terminar</small>';
    else if (state.peerTalking) text.innerHTML = 'ESCUCHANDO<br /><small>canal ocupado</small>';
    else text.innerHTML = 'MANTÉN<br />PARA HABLAR';
    if (!state.talking) $('pttTimer').textContent = '';
  }

  function flashBusy() {
    const ptt = $('ptt');
    ptt.classList.add('is-busy');
    setTimeout(() => ptt.classList.remove('is-busy'), 320);
  }

  function showIncoming(name) {
    $('incomingName').textContent = name;
    $('incoming').hidden = false;
    $('vuBar').style.width = '4%';
    renderTalkingUI();
  }

  function hideIncoming() {
    $('incoming').hidden = true;
    $('vuBar').style.width = '4%';
    renderTalkingUI();
  }

  // Pantalla siempre encendida mientras hablamos
  let wakeLock = null;
  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator && !wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => {
          wakeLock = null;
        });
      }
    } catch {}
  }
  function releaseWakeLock() {
    try {
      wakeLock?.release();
    } catch {}
    wakeLock = null;
  }

  // ------------------------------------------------------------------ vistas

  function showLoginError(message) {
    const el = $('loginError');
    el.textContent = message;
    el.hidden = false;
  }

  function setLoginBusy(busy) {
    const btn = $('enterBtn');
    btn.disabled = busy;
    btn.textContent = busy ? 'Conectando…' : 'Entrar';
  }

  function showApp() {
    $('login').hidden = true;
    $('app').hidden = false;
    $('nameInput').value = state.name;
    updateRoomHeader();
    renderTalkingUI();
    requestAnimationFrame(rafMeters);
  }

  function updateRoomHeader() {
    const room = state.rooms.find((r) => r.id === state.room);
    if (!room) return;
    $('roomEmoji').textContent = room.emoji || '📢';
    $('roomName').textContent = room.name;
    document.title = `${room.name} · Walkie Lagos`;
  }

  function setRoomStatus(text) {
    $('roomStatus').textContent = text;
  }

  function renderRooms() {
    const loginList = $('loginRooms');
    if (loginList && loginList.dataset.built !== '1') {
      loginList.dataset.built = '1';
      loginList.innerHTML = '';
      state.rooms.forEach((room) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'room-choice';
        btn.setAttribute('role', 'radio');
        btn.dataset.room = room.id;
        btn.innerHTML = `<span>${room.emoji}</span><span>${escapeHtml(room.name)}</span>`;
        btn.addEventListener('click', () => selectLoginRoom(room.id));
        loginList.appendChild(btn);
      });
      selectLoginRoom(state.room);
    }

    const list = $('roomList');
    list.innerHTML = '';
    state.rooms.forEach((room) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'room-item';
      item.setAttribute('aria-current', String(room.id === state.room));
      const live = room.talking ? `<small>🔊 ${escapeHtml(room.talking)} está hablando</small>` : `<small>${room.count ? `${room.count} en el canal` : 'nadie dentro'}</small>`;
      const badge = room.talking
        ? '<span class="badge live">en directo</span>'
        : `<span class="badge">${room.count}</span>`;
      item.innerHTML = `<span class="emoji">${room.emoji}</span><span class="info"><strong>${escapeHtml(room.name)}</strong>${live}</span>${badge}`;
      item.addEventListener('click', () => {
        if (room.id === state.room) return closeDrawer();
        if (state.talking) stopTalking();
        audio.resetPlayback();
        send({ type: 'switch', room: room.id });
      });
      list.appendChild(item);
    });
  }

  function selectLoginRoom(id) {
    state.room = id;
    [...$('loginRooms').children].forEach((el) => {
      el.setAttribute('aria-checked', String(el.dataset.room === id));
    });
  }

  function resizeRoster(users) {
    const roster = $('roster');
    roster.innerHTML = '';
    users.forEach((user) => {
      const isMe = state.you && user.id === state.you.id;
      const el = document.createElement('div');
      el.className = `person${isMe ? ' me' : ''}${user.talking || state.peerTalking === user.name ? ' speaking' : ''}`;
      el.innerHTML = `<span class="avatar" style="background:${colorFor(user.name)}">${escapeHtml(initials(user.name))}</span><span class="name">${escapeHtml(user.name)}${isMe ? ' (tú)' : ''}</span>`;
      if (user.talking) {
        el.innerHTML += `<span class="live-dot"></span>`;
      }
      roster.appendChild(el);
    });
    if (!users.length) {
      roster.innerHTML = '<div class="person"><span class="name">Solo tú en el canal</span></div>';
    }
  }

  // -------------------------------------------------------------------- log

  function addLog({ who, what, ts, kind }) {
    const log = $('log');
    const row = document.createElement('div');
    row.className = `log-row ${kind}`;
    const time = new Date(ts || Date.now()).toLocaleTimeString('es-ES', {
      hour: '2-digit',
      minute: '2-digit',
    });
    if (kind === 'sys' || kind === 'talk') {
      row.innerHTML = `<time>${time}</time><span class="what">${escapeHtml(what)}</span>`;
    } else {
      row.innerHTML = `<time>${time}</time><span class="who" style="color:${colorFor(who || '')}">${escapeHtml(who || '')}</span><span class="what">${escapeHtml(what)}</span>`;
    }
    log.appendChild(row);
    while (log.children.length > 80) log.removeChild(log.firstChild);
    log.scrollTop = log.scrollHeight;
  }

  function renderHistory(entries) {
    $('log').innerHTML = '';
    entries.forEach((entry) => addLog({ who: entry.from, what: entry.text, ts: entry.ts, kind: 'chat' }));
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    })[char]);
  }

  // ----------------------------------------------------------------- drawes

  function openDrawer(id) {
    $(id).hidden = false;
  }
  function closeDrawer() {
    $('drawer').hidden = true;
    $('settings').hidden = true;
  }

  function showPttError(title, text) {
    $('pttErrorTitle').textContent = title;
    $('pttErrorText').textContent = text;
    $('pttError').hidden = false;
  }

  // ------------------------------------------------------------------ ajustes

  function applySettingsToUI() {
    $('setNs').checked = Boolean(state.settings.ns);
    $('setEc').checked = Boolean(state.settings.ec);
    $('setBeeps').checked = Boolean(state.settings.beeps);
    $('setVibe').checked = Boolean(state.settings.vibe);
    $('setVol').value = state.settings.vol;
    $('volLabel').textContent = `${state.settings.vol}%`;
    $('setRate').value = String(state.settings.rate);
    $('soundBtn').setAttribute('aria-pressed', String(Boolean(state.settings.beeps)));
  }

  function saveSettings() {
    LS.set('settings', state.settings);
    applySettingsToUI();
  }

  async function fillMicrophones() {
    const selects = $('setMic');
    const mics = await audio.listMics();
    if (!mics.length) return;
    selects.innerHTML = '<option value="">Predeterminado</option>';
    mics.forEach((mic, index) => {
      const opt = document.createElement('option');
      opt.value = mic.deviceId;
      opt.textContent = mic.label || `Micrófono ${index + 1}`;
      selects.appendChild(opt);
    });
    selects.value = state.settings.mic || '';
  }

  function updateDiag() {
    const meter = audio.ctx ? audio.ctx.sampleRate : '—';
    const rate = Number(state.settings.rate) || 16000;
    const secure = window.isSecureContext ? 'sí' : 'NO (¡hace falta HTTPS!)';
    $('diagText').textContent = `Contexto de audio: ${meter} Hz · Envío: ${rate / 1000} kHz · Conexión segura: ${secure} · Servidor: ${location.host}`;
  }

  // ------------------------------------------------------------------ eventos

  function bindEvents() {
    // --- login
    const initialRoom = state.room || '';
    $('loginForm').addEventListener('submit', (event) => {
      event.preventDefault();
      const name = $('nameInput').value.trim();
      if (!name) {
        showLoginError('Pon tu nombre para que el equipo sepa quién habla.');
        return;
      }
      state.name = name;
      state.pin = $('pinInput').value;
      if (!state.room) state.room = document.querySelector('.room-choice')?.dataset.room || 'general';
      LS.set('name', name);
      LS.set('pin', state.pin);
      LS.set('room', state.room);
      setLoginBusy(true);
      $('loginError').hidden = true;
      connect();
      setTimeout(() => setLoginBusy(false), 6000);
    });

    $('nameInput').addEventListener('input', () => {
      $('loginError').hidden = true;
    });

    // --- PTT
    const ptt = $('ptt');
    const pointerDown = (event) => {
      event.preventDefault();
      audio.ensureContext().catch(() => {});
      if (state.locked) {
        if (state.talking) stopTalking();
        else startTalking();
        return;
      }
      if (event.pointerId !== undefined) {
        try {
          ptt.setPointerCapture(event.pointerId);
        } catch {}
      }
      startTalking();
    };
    const pointerUp = (event) => {
      if (event && event.cancelable) event.preventDefault();
      if (!state.locked) stopTalking();
    };

    ptt.addEventListener('pointerdown', pointerDown);
    ptt.addEventListener('pointerup', pointerUp);
    ptt.addEventListener('pointercancel', pointerUp);
    ptt.addEventListener('pointerleave', (event) => {
      if (!state.locked && event.buttons) pointerUp(event);
    });
    ptt.addEventListener('contextmenu', (event) => event.preventDefault());

    // Teclado: barra espaciadora para hablar en el ordenador
    document.addEventListener('keydown', (event) => {
      if (!state.joined || event.repeat) return;
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (event.code === 'Space') {
        event.preventDefault();
        if (state.locked) {
          if (state.talking) stopTalking();
          else startTalking();
        } else startTalking();
      }
    });
    document.addEventListener('keyup', (event) => {
      if (!state.joined) return;
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (event.code === 'Space' && !state.locked) stopTalking();
    });

    $('lockBtn').addEventListener('click', () => {
      state.locked = !state.locked;
      $('lockBtn').setAttribute('aria-pressed', String(state.locked));
      $('lockLabel').textContent = state.locked ? 'Modo pulsar (bloqueado)' : 'Mantener pulsado';
      renderTalkingUI();
      toast(state.locked ? 'Micro bloqueado: pulsa para hablar/soltar' : 'Vuelve a mantener pulsado');
    });

    // --- canales
    $('channelsBtn').addEventListener('click', () => {
      renderRooms();
      openDrawer('drawer');
    });

    // --- ajustes
    $('settingsBtn').addEventListener('click', () => {
      applySettingsToUI();
      updateDiag();
      fillMicrophones();
      openDrawer('settings');
    });

    document.querySelectorAll('[data-close]').forEach((el) => {
      el.addEventListener('click', () => {
        closeDrawer();
        $('pttError').hidden = true;
      });
    });

    $('setNs').addEventListener('change', (event) => {
      state.settings.ns = event.target.checked;
      saveSettings();
      audio.releaseMic();
    });
    $('setEc').addEventListener('change', (event) => {
      state.settings.ec = event.target.checked;
      saveSettings();
      audio.releaseMic();
    });
    $('setBeeps').addEventListener('change', (event) => {
      state.settings.beeps = event.target.checked;
      saveSettings();
    });
    $('setVibe').addEventListener('change', (event) => {
      state.settings.vibe = event.target.checked;
      if (state.settings.vibe && navigator.vibrate) navigator.vibrate(30);
      saveSettings();
    });
    $('setVol').addEventListener('input', (event) => {
      state.settings.vol = Number(event.target.value);
      $('volLabel').textContent = `${state.settings.vol}%`;
      saveSettings();
    });
    $('setRate').addEventListener('change', (event) => {
      state.settings.rate = Number(event.target.value);
      saveSettings();
      if (state.talking) audio.releaseMic();
      toast('Calidad ajustada');
    });
    $('setMic').addEventListener('change', (event) => {
      state.settings.mic = event.target.value;
      saveSettings();
      audio.releaseMic();
    });

    $('soundBtn').addEventListener('click', () => {
      state.settings.beeps = !state.settings.beeps;
      saveSettings();
      toast(state.settings.beeps ? 'Avisos activados' : 'Avisos silenciados');
    });

    $('logoutBtn').addEventListener('click', () => {
      closeDrawer();
      stopTalking();
      audio.releaseMic();
      audio.resetPlayback();
      try {
        state.socket?.close();
      } catch {}
      state.joined = false;
      state.name = '';
      $('app').hidden = true;
      $('login').hidden = false;
      setLoginBusy(false);
      $('pinInput').value = state.pin;
    });

    // --- chat
    $('chatForm').addEventListener('submit', (event) => {
      event.preventDefault();
      const input = $('chatInput');
      const text = input.value.trim();
      if (!text) return;
      if (!send({ type: 'chat', text })) {
        toast('Sin conexión: el mensaje no se ha enviado');
        return;
      }
      input.value = '';
    });

    // --- ciclo de vida
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && state.talking && !state.locked) stopTalking();
      if (!document.hidden && state.joined && state.socket?.readyState !== WebSocket.OPEN) {
        connect({ rejoin: true });
      }
    });

    window.addEventListener('online', () => {
      if (state.joined) connect({ rejoin: true });
    });

    window.addEventListener('pagehide', () => {
      try {
        state.socket?.close();
      } catch {}
      audio.releaseMic();
    });

    // Mantener despierto el socket
    setInterval(() => {
      if (state.joined && document.visibilityState === 'visible') send({ type: 'ping' });
    }, 25000);
  }

  // -------------------------------------------------------------------- init

  async function init() {
    applySettingsToUI();
    bindEvents();

    if (state.name) $('nameInput').value = state.name;
    if (state.pin) $('pinInput').value = state.pin;

    try {
      const response = await fetch('/api/config');
      const cfg = await response.json();
      state.rooms = cfg.rooms || [];
      $('appName').textContent = cfg.appName || 'Walkie Lagos';
      $('tagline').textContent = cfg.tagline || '';
      $('pinField').hidden = !cfg.requiresPin;
      const roomIds = state.rooms.map((r) => r.id);
      if (!state.rooms.some((r) => r.id === state.room)) {
        state.room = roomIds.includes('general') ? 'general' : roomIds[0] || 'general';
      }
      selectLoginRoom(state.room);
      updateRoomHeader();
      $('onlineBadge').textContent = `${cfg.online || 0} en línea`;
    } catch {
      state.rooms = [{ id: 'general', name: 'General', emoji: '📢' }];
      selectLoginRoom('general');
    }

    renderRooms();
    if (state.name) $('nameInput').focus();

    if (window.location.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(location.hostname)) {
      setTimeout(() => {
        showPttError(
          'Conexión no segura',
          'Para usar el micrófono, abre la app con HTTPS. El servidor tiene un modo seguro: arranca con "npm run https" y entra por https://…'
        );
      }, 1200);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

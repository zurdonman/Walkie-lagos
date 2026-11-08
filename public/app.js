/* Walkie Lagos — cliente
 * Micrófono -> PCM 16 bits mono -> WebSocket -> altavoz del compañero.
 * Sin dependencias y sin florituras: lo justo para hablar.
 */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const store = {
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
    name: store.get("name", ""),
    pin: store.get("pin", ""),
    room: store.get("room", ""),
    rooms: [],
    you: null,
    joined: false,
    socket: null,
    retry: 0,
    retryTimer: null,
    talking: false,
    wantsTalk: false,
    peer: null,
    maxSeconds: 0,
  };

  // ------------------------------------------------------------------ avisos

  let toastTimer = null;
  function toast(text) {
    const el = $("toast");
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.hidden = true;
    }, 2400);
  }

  // ------------------------------------------------------------------- audio

  const audio = {
    ctx: null,
    stream: null,
    capture: false,
    rate: 16000,
    node: null,
    fallback: null,
    next: 0,
    playing: new Set(),

    async context() {
      if (!this.ctx) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) throw new Error("Este navegador no puede reproducir audio.");
        this.ctx = new Ctx();
      }
      if (this.ctx.state === "suspended") await this.ctx.resume();
      return this.ctx;
    },

    async microphone() {
      if (this.stream?.getAudioTracks().some((t) => t.readyState === "live"))
        return this.stream;
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error(
          "Este navegador necesita HTTPS para usar el micrófono.",
        );
      }
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      return this.stream;
    },

    async start() {
      if (this.capture) return;
      const ctx = await this.context();
      const stream = await this.microphone();
      const source = ctx.createMediaStreamSource(stream);
      this.rate = 16000;

      const silence = ctx.createGain();
      silence.gain.value = 0;

      const post = (buffer) => {
        if (!state.talking) return;
        const ws = state.socket;
        if (ws?.readyState === WebSocket.OPEN) ws.send(buffer);
      };

      let worklet = false;
      if (
        ctx.audioWorklet &&
        typeof AudioWorkletNode === "function" &&
        !this.noWorklet
      ) {
        try {
          if (!this.workletLoaded) {
            const code = `
            class Capture extends AudioWorkletProcessor {
              constructor(options) {
                super();
                this.step = sampleRate / (options.processorOptions?.rate || 16000);
                this.size = Math.round((options.processorOptions?.rate || 16000) * 0.02);
                this.pos = 0; this.prev = 0; this.ready = false;
                this.out = new Int16Array(this.size); this.len = 0;
              }
              process(inputs) {
                const ch = inputs[0] && inputs[0][0];
                if (!ch) return true;
                if (!this.ready) { this.prev = ch[0]; this.ready = true; }
                while (true) {
                  const i = Math.floor(this.pos);
                  if (i + 1 >= ch.length) { this.pos -= ch.length; this.prev = ch[ch.length - 1]; break; }
                  const a = i === 0 ? this.prev : ch[i];
                  const s = Math.max(-1, Math.min(1, a + (ch[i + 1] - a) * (this.pos - i)));
                  this.out[this.len++] = s < 0 ? s * 0x8000 : s * 0x7fff;
                  if (this.len >= this.size) {
                    const copy = this.out.slice(0);
                    this.port.postMessage(copy.buffer, [copy.buffer]);
                    this.len = 0;
                  }
                  this.pos += this.step;
                }
                return true;
              }
            }
            registerProcessor('walkie-capture', Capture);
          `;
            const url = URL.createObjectURL(
              new Blob([code], { type: "application/javascript" }),
            );
            await ctx.audioWorklet.addModule(url);
            URL.revokeObjectURL(url);
            this.workletLoaded = true;
          }
          this.node = new AudioWorkletNode(ctx, "walkie-capture", {
            processorOptions: { rate: this.rate },
          });
          this.node.port.onmessage = (event) => post(event.data);
          source.connect(this.node);
          this.node.connect(silence).connect(ctx.destination);
          worklet = true;
        } catch {
          // Navegador sin audioWorklet utilizable: seguimos por el plan B.
          this.noWorklet = true;
          try {
            this.node?.disconnect();
          } catch {}
          this.node = null;
        }
      }

      if (!worklet) {
        // Navegadores sin AudioWorklet: mismo resultado con ScriptProcessor.
        const proc = ctx.createScriptProcessor(2048, 1, 1);
        const step = ctx.sampleRate / this.rate;
        const size = Math.round(this.rate * 0.02);
        let pos = 0;
        let prev = 0;
        let ready = false;
        let out = new Int16Array(size);
        let len = 0;
        proc.onaudioprocess = (event) => {
          if (!state.talking) return;
          const ch = event.inputBuffer.getChannelData(0);
          if (!ready) {
            prev = ch[0];
            ready = true;
          }
          while (true) {
            const i = Math.floor(pos);
            if (i + 1 >= ch.length) {
              pos -= ch.length;
              prev = ch[ch.length - 1];
              break;
            }
            const a = i === 0 ? prev : ch[i];
            const s = Math.max(
              -1,
              Math.min(1, a + (ch[i + 1] - a) * (pos - i)),
            );
            out[len++] = s < 0 ? s * 0x8000 : s * 0x7fff;
            if (len >= size) {
              post(out.slice(0).buffer);
              len = 0;
            }
            pos += step;
          }
        };
        source.connect(proc);
        proc.connect(silence).connect(ctx.destination);
        this.fallback = proc;
      }
      this.capture = true;
    },

    stop() {
      try {
        this.node?.port?.close?.();
        this.node?.disconnect();
      } catch {}
      try {
        if (this.fallback) {
          this.fallback.onaudioprocess = null;
          this.fallback.disconnect();
        }
      } catch {}
      this.node = null;
      this.fallback = null;
      this.capture = false;
    },

    release() {
      this.stop();
      if (this.stream) {
        this.stream.getTracks().forEach((t) => t.stop());
        this.stream = null;
      }
    },

    /** Reproduce un trozo de audio del compañero. */
    play(buffer) {
      const ctx = this.ctx;
      if (!ctx) return;
      const pcm = new Int16Array(buffer);
      if (!pcm.length) return;

      const floats = new Float32Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) floats[i] = pcm[i] / 0x8000;

      // Del ritmo de envío (16 kHz) al del dispositivo (48 kHz normalmente).
      const ratio = this.rate / ctx.sampleRate;
      let samples = floats;
      if (Math.abs(1 - ratio) > 0.001) {
        const length = Math.max(1, Math.floor(floats.length / ratio));
        samples = new Float32Array(length);
        for (let i = 0; i < length; i++) {
          const pos = i * ratio;
          const idx = Math.floor(pos);
          const a = floats[idx] ?? 0;
          const b = floats[idx + 1] ?? a;
          samples[i] = a + (b - a) * (pos - idx);
        }
      }

      const source = ctx.createBufferSource();
      const audioBuffer = ctx.createBuffer(1, samples.length, ctx.sampleRate);
      audioBuffer.copyToChannel(samples, 0);
      source.buffer = audioBuffer;
      source.connect(ctx.destination);

      // Colchón de 120 ms para aguantar los tirones del wifi del local.
      const now = ctx.currentTime;
      if (this.next < now + 0.02 || this.next > now + 1) this.next = now + 0.12;
      try {
        source.start(this.next);
      } catch {
        source.start();
      }
      this.next += audioBuffer.duration;
      this.playing.add(source);
      source.onended = () => this.playing.delete(source);
    },

    reset() {
      for (const source of this.playing) {
        try {
          source.stop();
        } catch {}
      }
      this.playing.clear();
      this.next = 0;
    },
  };

  // ------------------------------------------------------------------ socket

  function connect() {
    if (state.socket && state.socket.readyState < 2) return;
    clearTimeout(state.retryTimer);
    $("roomStatus").textContent = "conectando…";

    const socket = new WebSocket(
      `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`,
    );
    socket.binaryType = "arraybuffer";
    state.socket = socket;

    socket.onopen = () => {
      state.retry = 0;
      socket.send(
        JSON.stringify({
          type: "join",
          name: state.name,
          pin: state.pin,
          room: state.room,
        }),
      );
    };

    socket.onmessage = (event) => {
      if (typeof event.data !== "string") {
        audio.play(event.data);
        return;
      }
      handle(JSON.parse(event.data));
    };

    socket.onclose = () => {
      const was = state.joined;
      state.joined = false;
      state.talking = false;
      state.peer = null;
      audio.reset();
      audio.release();
      renderPtt();
      $("incoming").hidden = true;
      $("roomStatus").textContent = "sin conexión";
      if (was && state.name) {
        state.retry += 1;
        const delay = Math.min(10000, 800 * 2 ** Math.min(state.retry, 4));
        $("roomStatus").textContent =
          `reconectando (${Math.round(delay / 1000)} s)…`;
        state.retryTimer = setTimeout(connect, delay);
      }
    };

    socket.onerror = () => {
      $("roomStatus").textContent = "error de conexión";
    };
  }

  const send = (payload) => {
    if (state.socket?.readyState === WebSocket.OPEN) {
      state.socket.send(JSON.stringify(payload));
      return true;
    }
    return false;
  };

  function handle(msg) {
    switch (msg.type) {
      case "welcome":
        state.you = msg.you;
        state.joined = true;
        state.room = msg.you.room;
        state.rooms = msg.rooms || [];
        state.maxSeconds = msg.maxTalkSeconds || 0;
        store.set("room", state.room);
        $("login").hidden = true;
        $("app").hidden = false;
        $("roomStatus").textContent = "en línea";
        drawRooms();
        drawHeader();
        drawRoster(msg.users || []);
        drawLog(msg.history || []);
        renderPtt();
        break;

      case "switched":
        state.room = msg.room;
        store.set("room", state.room);
        state.peer = null;
        $("incoming").hidden = true;
        audio.reset();
        drawHeader();
        drawRoster(msg.users || []);
        drawLog(msg.history || []);
        drawRooms();
        $("drawer").hidden = true;
        break;

      case "rooms":
        state.rooms = msg.rooms || state.rooms;
        drawRooms();
        drawHeader();
        break;

      case "roster":
        if (msg.room === state.room) drawRoster(msg.users || []);
        break;

      case "presence":
        $("onlineBadge").textContent = String(msg.online || 0);
        break;

      case "talkAccept":
        if (!state.wantsTalk) {
          send({ type: "talk", on: false });
          break;
        }
        state.talking = true;
        state.startedAt = Date.now();
        state.maxSeconds = msg.maxSeconds || 0;
        renderPtt();
        break;

      case "talkDeny":
        state.wantsTalk = false;
        state.talking = false;
        audio.release();
        renderPtt();
        flashBusy();
        toast(`${msg.by || "Alguien"} está hablando`);
        break;

      case "talkStart":
        state.peer = msg.from;
        $("incomingName").textContent = msg.from;
        $("incoming").hidden = false;
        if (navigator.vibrate) navigator.vibrate(30);
        renderPtt();
        break;

      case "talkEnd":
        state.peer = null;
        $("incoming").hidden = true;
        renderPtt();
        break;

      case "chat":
        addLog(msg.from, msg.text, msg.ts, true);
        if (msg.from !== state.name && document.hidden && navigator.vibrate)
          navigator.vibrate(20);
        break;

      case "system":
        addLog(null, msg.text, msg.ts);
        break;

      case "error":
        if (!state.joined) {
          $("loginError").textContent = msg.message;
          $("loginError").hidden = false;
          $("enterBtn").disabled = false;
          $("enterBtn").textContent = "Entrar";
        } else {
          toast(msg.message);
        }
        break;

      default:
        break;
    }
  }

  // -------------------------------------------------------------------- PTT

  let timer = null;

  async function startTalk() {
    if (!state.joined || state.talking) return;
    if (state.peer) {
      flashBusy();
      toast(`${state.peer} está hablando`);
      return;
    }
    state.wantsTalk = true;
    try {
      await audio.context();
      await audio.start();
    } catch (error) {
      state.wantsTalk = false;
      const secure =
        window.isSecureContext || location.hostname === "localhost";
      toast(
        secure
          ? "No puedo usar el micrófono: revisa los permisos del navegador"
          : "El micrófono necesita HTTPS: abre la dirección https:// de la app",
      );
      return;
    }
    if (!state.wantsTalk) {
      audio.release();
      return;
    }
    send({ type: "talk", on: true });
  }

  function stopTalk() {
    state.wantsTalk = false;
    if (state.talking) send({ type: "talk", on: false });
    state.talking = false;
    clearInterval(timer);
    $("pttTimer").textContent = "";
    renderPtt();
    setTimeout(() => {
      if (!state.talking) audio.release();
    }, 400);
  }

  function renderPtt() {
    const ptt = $("ptt");
    ptt.classList.toggle("talking", state.talking);
    const label = $("pttText");
    label.innerHTML = state.talking
      ? "HABLANDO<br /><small>suelta para terminar</small>"
      : state.peer
        ? "ESCUCHANDO<br /><small>canal ocupado</small>"
        : "MANTÉN<br />PARA HABLAR";
    clearInterval(timer);
    // Sin límite de tiempo: solo se muestra cuánto lleva hablando.
    if (!state.talking) return;
    timer = setInterval(() => {
      const elapsed = Math.floor((Date.now() - state.startedAt) / 1000);
      $("pttTimer").textContent =
        elapsed >= 1
          ? `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`
          : "";
    }, 250);
  }

  function flashBusy() {
    $("ptt").classList.add("busy");
    setTimeout(() => $("ptt").classList.remove("busy"), 320);
  }

  // ----------------------------------------------------------------- vistas

  function drawHeader() {
    const room = state.rooms.find((r) => r.id === state.room);
    if (!room) return;
    $("roomEmoji").textContent = room.emoji || "📻";
    $("roomName").textContent = room.name;
    document.title = `${room.name} · Walkie Lagos`;
  }

  function drawRooms() {
    const pick = $("loginRooms");
    if (
      !pick.children.length ||
      pick.dataset.count !== String(state.rooms.length)
    ) {
      pick.innerHTML = "";
      pick.dataset.count = String(state.rooms.length);
      for (const room of state.rooms) {
        const button = document.createElement("button");
        button.type = "button";
        button.setAttribute("role", "radio");
        button.dataset.room = room.id;
        button.textContent = `${room.emoji} ${room.name}`;
        button.addEventListener("click", () => pickRoom(room.id));
        pick.appendChild(button);
      }
      pickRoom(state.room || state.rooms[0]?.id);
    }

    const list = $("roomList");
    list.innerHTML = "";
    for (const room of state.rooms) {
      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute("aria-current", String(room.id === state.room));
      const detail = room.talking
        ? `${room.talking} hablando`
        : `${room.count} dentro`;
      button.innerHTML = `<span>${room.emoji}</span><span>${escapeHtml(room.name)}</span><small>${escapeHtml(detail)}</small>`;
      button.addEventListener("click", () => {
        if (room.id === state.room) {
          $("drawer").hidden = true;
          return;
        }
        stopTalk();
        audio.reset();
        send({ type: "switch", room: room.id });
      });
      list.appendChild(button);
    }
  }

  function pickRoom(id) {
    state.room = id;
    for (const button of $("loginRooms").children) {
      button.setAttribute("aria-checked", String(button.dataset.room === id));
    }
  }

  function drawRoster(users) {
    const roster = $("roster");
    roster.innerHTML = "";
    if (!users.length) {
      roster.innerHTML = "<span>Estás solo en el canal</span>";
      return;
    }
    for (const user of users) {
      const chip = document.createElement("span");
      const me = state.you && user.id === state.you.id;
      chip.className = user.talking ? "speaking" : "";
      chip.textContent = me ? `${user.name} (tú)` : user.name;
      roster.appendChild(chip);
    }
  }

  // ------------------------------------------- historial guardado en este equipo
  // Cada navegador guarda lo suyo: así el chat sigue ahí aunque se recargue o se
  // caiga la wifi, sin depender de lo que recuerde el servidor.
  // store ya añade el prefijo "walkie.", así que la clave real es walkie.log
  const LOG_KEY = "log";
  let localLog = [];
  let localLogRoom = "";

  function loadLocalLog(room) {
    if (room !== localLogRoom) {
      localLogRoom = room;
      const all = store.get(LOG_KEY, {}) || {};
      localLog = Array.isArray(all[room]) ? all[room] : [];
    }
    return localLog;
  }

  function saveLocalLog(entry) {
    if (!localLogRoom) return;
    localLog.push(entry);
    if (localLog.length > 200) localLog = localLog.slice(-200);
    try {
      const all = store.get(LOG_KEY, {}) || {};
      all[localLogRoom] = localLog;
      store.set(LOG_KEY, all);
    } catch {}
  }

  function drawLog(entries) {
    const local = loadLocalLog(localLogRoom || state.room);
    $("log").innerHTML = "";
    if (local.length) {
      // lo guardado en este equipo manda (incluye voces transcritas)
      for (const entry of local) addLog(entry.from, entry.text, entry.ts);
      return;
    }
    // Primera vez en este equipo: se copia lo que recuerda el servidor.
    for (const entry of entries) addLog(entry.from, entry.text, entry.ts, true);
  }

  function addLog(who, text, ts, remember) {
    if (remember && who) saveLocalLog({ from: who, text, ts: ts || Date.now() });
    const log = $("log");
    const row = document.createElement("div");
    const time = new Date(ts || Date.now()).toLocaleTimeString("es-ES", {
      hour: "2-digit",
      minute: "2-digit",
    });
    if (who) {
      row.innerHTML = `<i>${time}</i> <b>${escapeHtml(who)}</b>: ${escapeHtml(text)}`;
    } else {
      row.innerHTML = `<i>${escapeHtml(text)}</i>`;
    }
    log.appendChild(row);
    while (log.children.length > 60) log.removeChild(log.firstChild);
    log.scrollTop = log.scrollHeight;
  }

  const escapeHtml = (value) =>
    String(value ?? "").replace(
      /[&<>"']/g,
      (char) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[char],
    );

  // ---------------------------------------------------------------- eventos

  $("loginForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const name = $("nameInput").value.trim();
    if (!name) return;
    state.name = name;
    state.pin = $("pinInput").value;
    if (!state.room)
      state.room =
        $("loginRooms").querySelector('[aria-checked="true"]')?.dataset.room ||
        "general";
    store.set("name", name);
    store.set("pin", state.pin);
    store.set("room", state.room);
    $("loginError").hidden = true;
    $("enterBtn").disabled = true;
    $("enterBtn").textContent = "Conectando…";
    connect();
  });

  const ptt = $("ptt");
  ptt.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    audio.context().catch(() => {});
    startTalk();
  });
  ptt.addEventListener("pointerup", (event) => {
    event.preventDefault();
    stopTalk();
  });
  ptt.addEventListener("pointercancel", stopTalk);
  ptt.addEventListener("contextmenu", (event) => event.preventDefault());

  // En el ordenador, la barra espaciadora hace de botón.
  document.addEventListener("keydown", (event) => {
    if (event.code !== "Space" || event.repeat || !state.joined) return;
    if (["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName)) return;
    event.preventDefault();
    startTalk();
  });
  document.addEventListener("keyup", (event) => {
    if (event.code === "Space" && state.joined) stopTalk();
  });

  $("channelsBtn").addEventListener("click", () => {
    drawRooms();
    $("drawer").hidden = false;
  });
  document.querySelectorAll("[data-close]").forEach((el) => {
    el.addEventListener("click", () => {
      $("drawer").hidden = true;
    });
  });

  $("chatForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const input = $("chatInput");
    const text = input.value.trim();
    if (!text) return;
    if (!send({ type: "chat", text })) return toast("Sin conexión");
    input.value = "";
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden && state.talking) stopTalk();
    if (
      !document.hidden &&
      state.joined &&
      state.socket?.readyState !== WebSocket.OPEN
    )
      connect();
  });
  window.addEventListener("online", () => state.joined && connect());
  window.addEventListener("pagehide", () => audio.release());
  setInterval(() => state.joined && send({ type: "ping" }), 25000);

  // ------------------------------------------------------------------- init

  (async () => {
    if (state.name) $("nameInput").value = state.name;
    if (state.pin) $("pinInput").value = state.pin;

    try {
      const cfg = await (await fetch("/api/config")).json();
      state.rooms = cfg.rooms || [];
      $("pinField").hidden = !cfg.requiresPin;
      if (cfg.appName) document.title = cfg.appName;
      if (!state.rooms.some((r) => r.id === state.room))
        state.room = state.rooms[0]?.id || "general";
    } catch {
      state.rooms = [{ id: "general", name: "General", emoji: "📢" }];
      state.room = "general";
    }
    drawRooms();
    drawHeader();
  })();
})();

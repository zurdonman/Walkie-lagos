# Walkie Lagos 📻

Radio interna **push-to-talk** para el restaurante. Pulsas el botón, hablas, sueltas y
lo oye todo el que esté en ese canal. Además hay chat escrito y varios canales
(General, Cocina, Sala, Barra) para no pisarse.

Es una alternativa libre a Zello: software propio, sin cuotas, sin límite de usuarios
y alojado donde tú quieras (el portátil del despacho, una Raspberry Pi, un servidor…).

## Qué hace

- **Audio en vivo tipo walkie**: mantén pulsado → hablas → sueltas. Sin llamadas, sin aceptar.
- **Modo bloquear** para quien prefiere pulsar en vez de mantener.
- **Canales** independientes, cada uno con su lista de gente conectada.
- **Hablar a una sola persona**: toca el nombre de un compañero en la lista (aunque esté en otro
  canal) y el botón pasa a "solo a Luis". Nadie más oye esa conversación.
- **Aviso prioritario 🚨**: un botón rojo para avisar a TODO el restaurante a la vez
  (se oye estés en el canal que estés) y escrito: el aviso sale como banner en todos los móviles.)
- **Un solo turno de palabra por canal** (quien habla primero manda; los demás reciben un aviso suave).
- **Límite de 45 s** por intervención (configurable) para que nadie acapare el canal.
- **Chat de texto** y registro de actividad del canal (últimos 60 mensajes al entrar).
- **Avisos**: pitidos al empezar/terminar, vibración opcional, medidor de voz de quien habla.
- **Ajustes de audio**: filtro de ruido, cancelación de eco, calidad (12/16/24 kHz), volumen, elegir micrófono.
- **Reconexión automática** si se cae el wifi, y keep-alive con ping/pong (los "cuelgues" típicos de Zello).
- **PWA**: se instala en el móvil como una app ("Añadir a pantalla de inicio").
- **Plan B de audio** con `ScriptProcessor` para navegadores sin `AudioWorklet` (Safari antiguos):
  así no te quedas sin radio en un móvil viejo.
- Se maneja con **guantes grasientos**: un solo botón enorme, sin menús raros.

## Cómo se ejecuta

```bash
npm install
npm start            # http://localhost:3000
```

Configuración en `config.json`: nombre de la app, **PIN de acceso**, canales y segundos máximos por turno.

```json
{
  "appName": "Walkie Lagos",
  "pin": "lagos",
  "maxTalkSeconds": 45,
  "maxAlertSeconds": 25,
  "alertsEnabled": true,
  "rooms": [{ "id": "cocina", "name": "Cocina", "emoji": "🍳" }]
}
```

- `maxTalkSeconds`: máximo por intervención normal (el que habla pierde el turno solo).
- `maxAlertSeconds`: máximo de un aviso prioritario.
- `alertsEnabled`: ponlo en `false` si no quieres el botón de aviso (menos sustos).

> Cambia el PIN antes de usarlo de verdad. Si lo dejas vacío (`""`), no pide PIN.

## Importante: el micrófono necesita HTTPS

Los navegadores **solo dejan usar el micrófono en contextos seguros**: `https://` o `localhost`.
En http:// por la IP del local el botón no funcionará (la app te avisa).

Tres formas, de menos a más seria:

1. **Pruebas en el ordenador**: `npm start` y entra en `http://localhost:3000`.
2. **Pruebas en los móviles por la wifi del local**: certificado autofirmado

   ```bash
   npm run cert -- 192.168.1.50   # tu IP local
   npm run https
   ```

   Y abre `https://192.168.1.50:3000`. El móvil avisará del certificado ("Avanzado → Continuar").
   Vale para pruebas, es incómodo para el día a día.

3. **Uso real en el restaurante** (recomendado): Docker + Caddy con HTTPS automático.

   ```bash
   cp .env.example .env      # pon tu DOMINIO y un PIN propio
   docker compose up -d      # app + certificado Let's Encrypt, sin tocar nada más
   ```

   Necesita que el dominio apunte a la IP pública del local y los puertos 80/443 abiertos.
   Caddy se encarga del certificado y su renovación; la app no está expuesta directamente.
   `docker compose logs -f` para ver qué pasa, `docker compose down` para pararlo.

   Sin Docker también vale: `npm start` y delante Caddy o Nginx con tu certificado
   (`deploy/Caddyfile` está listo como referencia), o Cloudflare Tunnel si el local
   no tiene IP fija.

## Despliegue en el restaurante (resumen)

```bash
# 1) en el servidor del local (un mini-PC, Raspberry Pi 4 o un NAS con Docker)
git clone <este repo> walkie && cd walkie

# 2) configuración
cp .env.example .env
nano .env            # DOMAIN=walkie.turestaurante.com  y  PIN=el-tuyo

# 3) comprobar antes de arrancar (sin Docker también sirve)
npm install && npm run check

# 4) arrancar
docker compose up -d
```

Después, en cada móvil: abrir `https://walkie.turestaurante.com`, poner nombre y PIN,
y "Añadir a pantalla de inicio". Sin instalar nada, sin cuotas y sin cuentas.

Alternativa sin dominio (solo wifi del local, para probar): `npm run cert -- <IP>` y
`npm run https`. El móvil avisará del certificado autofirmado; vale para pruebas,
no para el día a día.

### Variables de entorno

| Variable | Para qué | Por defecto |
| --- | --- | --- |
| `PIN` | PIN de acceso (cámbialo siempre) | el de `config.json` |
| `APP_NAME` / `TAGLINE` | Nombre y lema que se ven en la app | Walkie Lagos |
| `ROOMS` | Canales en JSON, p. ej. `[{"id":"cocina","name":"Cocina","emoji":"🍳"}]` | los de `config.json` |
| `MAX_TALK_SECONDS` | Segundos máximos por intervención | 45 |
| `MAX_ALERT_SECONDS` | Segundos máximos de un aviso prioritario | 25 |
| `ALERTS_ENABLED` | `false` para quitar el botón de aviso | true |
| `PORT` / `HOST` | Dónde escucha el servidor | 3000 / 0.0.0.0 |

El servidor avisa al arrancar de lo que conviene revisar (PIN de ejemplo, PIN vacío,
canales repetidos…). Puedes verlo antes con `npm run check`.

Mantenimiento del día a día: `docker compose logs -f walkie` (quién entra, errores),
`docker compose restart walkie`, y actualizar con `git pull && docker compose up -d --build`.
Como el estado vive en memoria, reiniciar solo borra el historial de chat: el audio
nunca se guarda.

## Cómo lo usa el equipo

1. Abren la web (o el icono instalado), ponen su nombre y el PIN.
2. Entran al canal que les toca (Cocina, Sala…).
3. Pulsan y mantienen el botón, hablan, sueltan.
4. Si quieren, escriben en el chat: "mesa 4 sin pan".

**Para hablarle solo a una persona:** toca su nombre en la lista de abajo. El botón
cambia a "MANTÉN · a Marta" y el audio solo le llega a ella (aunque esté en otro canal).
Tocas otra vez su nombre (o el botón "Todo el canal") para volver al canal.

**Para un aviso urgente:** botón rojo 🚨 "Aviso a todos", mantienes y hablas: lo oirán
todos los móviles del restaurante, estén en el canal que estén. También puedes escribir
el aviso en el banner y pulsar "Enviar". El modo aviso se desactiva solo después de usarlo.

Detalles útiles para el local:

- Sube el volumen del móvil y llévalo con auricular de un oído (así te oyes y oyes el canal).
- Cada zona puede tener su canal y entrar al General para avisos a todos.
- Si alguien está hablando y pulsas, te avisa ("X está hablando") en vez de cortarle.
- Pon el móvil con la app abierta y la pantalla encendida mientras dura el servicio:
  al hablar se pide automáticamente que no se apague.

## Cómo está montado

```
server.js              Express + WebSocket (ws). Canales, turnos (canal/directo/aviso), historial.
lib/config.js          Configuración: config.json + variables de entorno, con validación.
Dockerfile             Imagen de producción (Node Alpine, usuario sin privilegios, healthcheck).
docker-compose.yml     App + Caddy (HTTPS automático de Let's Encrypt).
deploy/Caddyfile       Proxy inverso con cabeceras de seguridad.
.env.example           Plantilla de configuración del despliegue.
public/index.html      Interfaz (una sola pantalla, móvil primero).
public/app.js          Captura de micro -> PCM16 mono -> WebSocket -> reproducción.
public/styles.css      Estilos.
config.json            Canales, PIN, límites, avisos.
scripts/gen-cert.sh    Certificado autofirmado para pruebas en la LAN.
test/                  Pruebas automáticas (protocolo, audio y interfaz).
```

Cada conversación es un "turno" con su propia clave: `room:<canal>`, `dm:<idA>|<idB>` o `alert`.
El audio de un turno solo se reenvía a quienes participan en él, así que un directo no se
filtra al canal y un aviso llega a todos.

### Pruebas

```bash
npm run check   # revisa la configuración (PIN, canales, límites)
npm test        # protocolo + configuración + despliegue + audio + interfaz
```

Cubren, entre otras cosas: PIN incorrecto, turnos simultáneos, liberación del canal al
desconectarse, directos que no se filtran, avisos que cruzan canales, chat privado,
cambio de canal, paquetes de audio de 20 ms, bloqueo del micrófono, variables de entorno
(ROOMS/PIN/límites), coherencia del Dockerfile/compose/Caddyfile y el `/healthz`.

Flujo del audio:

1. `getUserMedia` con cancelación de eco y filtro de ruido.
2. `AudioWorklet` que remuestrea a 16 kHz y trocea en paquetes de 20 ms (PCM 16 bits mono).
3. Cada paquete viaja como mensaje binario por WebSocket.
4. El servidor lo reenvía solo a los del mismo canal, y solo si el emisor tenía el turno.
5. El receptor lo reprograma en el `AudioContext` con un colchón de 120 ms para absorber el jitter del wifi.

Un paquete de 20 ms a 16 kHz son 640 bytes → unos **32 kB/s** hablando (≈115 MB por hora de voz real).
Si el wifi del local va flojo, baja la calidad a 12 kHz en Ajustes.

## Limitaciones honestas

- Los avisos prioritarios **no se pueden silenciar** (es el sentido de un aviso). Si resultan
  molestos, baja `maxAlertSeconds` o pon `alertsEnabled: false`.
- El "directo" es de audio en vivo: no hay timbre ni llamada que aceptar, quien recibe
  simplemente oye al compañero hablarle.

- No es código de Zello: es una implementación propia del mismo concepto (que además evita
  problemas legales de copiar su app). No hay grabación, ni historial de audio, ni geolocalización.
- Un solo servidor, estado en memoria: si se reinicia, se pierden los mensajes del chat
  (el audio nunca se guarda). No hay balanceo entre varios servidores: para un local,
  uno basta de sobra.
- El audio va cifrado en tránsito si sirves por HTTPS (`wss://`), pero no está cifrado
  de extremo a extremo. Uso interno de un restaurante: suficiente.
- Sin cuentas de usuario: el PIN es la única puerta. No lo publiques en internet sin cambiarlo.

## Ideas siguientes

- ~~Canal "prioridad" que interrumpe (avisos de cocina).~~ ✅ hecho
- ~~Llamada individual (1 a 1) además de canales.~~ ✅ hecho (directo de voz)
- Grabación de avisos para turnos.
- Llamada individual (1 a 1) además de canales.
- Botón de "emergencia" que suena en todos los canales.

Licencia MIT.

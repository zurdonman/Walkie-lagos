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
- **Un solo turno de palabra por canal** (quien habla primero manda; los demás reciben un aviso suave).
- **Límite de 45 s** por intervención (configurable) para que nadie acapare el canal.
- **Chat de texto** y registro de actividad del canal (últimos 60 mensajes al entrar).
- **Avisos**: pitidos al empezar/terminar, vibración opcional, medidor de voz de quien habla.
- **Ajustes de audio**: filtro de ruido, cancelación de eco, calidad (12/16/24 kHz), volumen, elegir micrófono.
- **Reconexión automática** si se cae el wifi, y keep-alive con ping/pong (los "cuelgues" típicos de Zello).
- **PWA**: se instala en el móvil como una app ("Añadir a pantalla de inicio").
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
  "rooms": [{ "id": "cocina", "name": "Cocina", "emoji": "🍳" }]
}
```

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

3. **Uso real en el restaurante** (recomendado): un dominio o subdominio con HTTPS de verdad.

   ```bash
   # con Caddy (el más fácil: HTTPS automático con Let's Encrypt)
   # Caddyfile
   walkie.turestaurante.com {
       reverse_proxy localhost:3000
   }
   ```

   `npm start` en el servidor detrás de Caddy y listo. También vale Nginx + certbot,
   Cloudflare Tunnel o cualquier hosting con Node.

## Cómo lo usa el equipo

1. Abren la web (o el icono instalado), ponen su nombre y el PIN.
2. Entran al canal que les toca (Cocina, Sala…).
3. Pulsan y mantienen el botón, hablan, sueltan.
4. Si quieren, escriben en el chat: "mesa 4 sin pan".

Detalles útiles para el local:

- Sube el volumen del móvil y llévalo con auricular de un oído (así te oyes y oyes el canal).
- Cada zona puede tener su canal y entrar al General para avisos a todos.
- Si alguien está hablando y pulsas, te avisa ("X está hablando") en vez de cortarle.
- Pon el móvil con la app abierta y la pantalla encendida mientras dura el servicio:
  al hablar se pide automáticamente que no se apague.

## Cómo está montado

```
server.js              Express + WebSocket (ws). Estado en memoria: canales, turnos, historial.
public/index.html      Interfaz (una sola pantalla, móvil primero).
public/app.js          Captura de micro -> PCM16 mono -> WebSocket -> reproducción.
public/styles.css      Estilos.
config.json            Canales, PIN, límites.
scripts/gen-cert.sh    Certificado autofirmado para pruebas en la LAN.
```

Flujo del audio:

1. `getUserMedia` con cancelación de eco y filtro de ruido.
2. `AudioWorklet` que remuestrea a 16 kHz y trocea en paquetes de 20 ms (PCM 16 bits mono).
3. Cada paquete viaja como mensaje binario por WebSocket.
4. El servidor lo reenvía solo a los del mismo canal, y solo si el emisor tenía el turno.
5. El receptor lo reprograma en el `AudioContext` con un colchón de 120 ms para absorber el jitter del wifi.

Un paquete de 20 ms a 16 kHz son 640 bytes → unos **32 kB/s** hablando (≈115 MB por hora de voz real).
Si el wifi del local va flojo, baja la calidad a 12 kHz en Ajustes.

## Limitaciones honestas

- No es código de Zello: es una implementación propia del mismo concepto (que además evita
  problemas legales de copiar su app). No hay grabación, ni historial de audio, ni geolocalización.
- Un solo servidor, estado en memoria: si se reinicia, se pierden los mensajes del chat
  (el audio nunca se guarda).
- El audio va cifrado en tránsito si sirves por HTTPS (`wss://`), pero no está cifrado
  de extremo a extremo. Uso interno de un restaurante: suficiente.
- Sin cuentas de usuario: el PIN es la única puerta. No lo publiques en internet sin cambiarlo.

## Ideas siguientes

- Canal "prioridad" que interrumpe (avisos de cocina).
- Grabación de avisos para turnos.
- Llamada individual (1 a 1) además de canales.
- Botón de "emergencia" que suena en todos los canales.

Licencia MIT.

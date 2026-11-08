# 📻 Walkie Lagos

Walkie-talkie para el restaurante. Pulsas el botón, hablas, sueltas y te oyen los
compañeros que estén en tu canal. Además hay chat escrito.

```
npm install
npm start        # http://localhost:3000
```

PIN por defecto: `lagos` (cámbialo en `config.json`).

## Cómo se usa

1. Pones tu nombre y el PIN.
2. Eliges canal: General, Cocina, Sala o Barra.
3. Mantienes pulsado el botón grande y hablas. Sueltas para escuchar.

Las opciones son las mínimas:

- **Un turno por canal**: si alguien está hablando, a ti te avisa en vez de cortarle.
- **45 segundos** máximo por intervención (se cambia en `config.json`).
- **Chat escrito** al canal, con los últimos 60 mensajes al entrar.
- En el ordenador, la **barra espaciadora** hace de botón.

## Canales

En `config.json`:

```json
{
  "pin": "lagos",
  "maxTalkSeconds": 45,
  "rooms": [
    { "id": "cocina", "name": "Cocina", "emoji": "🍳" },
    { "id": "sala", "name": "Sala", "emoji": "🍽️" }
  ]
}
```

## Lo único que hay que saber: hace falta HTTPS

Los navegadores solo dejan usar el micrófono en `localhost` o por HTTPS. Para probar
en los móviles del local:

```bash
npm run cert -- 192.168.1.50    # tu IP
npm run https
```

Y abres `https://192.168.1.50:3000` (el móvil avisará del certificado: "Avanzado →
Continuar"). Para el día a día, ponlo detrás de Caddy o Nginx con un dominio y su
certificado; no hay nada más que configurar en la app.

## Cómo funciona por dentro

- `server.js`: Express + WebSocket. Guárdalo todo en memoria (canales, quién habla,
  últimos mensajes).
- `public/app.js`: coge el micrófono, lo convierte a PCM 16 bits a 16 kHz y lo manda
  en paquetes de 20 ms (unos 32 kB/s hablando). Al recibir, lo reproduce con un colchón
  de 120 ms para aguantar el wifi.
- Nada se guarda en disco: ni audio ni historial. Al reiniciar, se borra el chat.

Detalles que evitan los cuelgues típicos de estas apps: ping/pong cada 20 segundos para
tirar conexiones muertas, reconexión automática al volver el wifi, y liberar el turno
cuando alguien se desconecta.

## Pruebas

```bash
npm test
```

- `test/protocol.test.mjs`: servidor con tres clientes (hablar, turno ocupado, chat, canales).
- `test/audio.test.mjs`: captura de audio por los dos caminos (AudioWorklet y el plan B).
- `test/ui.test.mjs`: la interfaz completa sin navegador.

## Límites, sin adornos

- Un servidor y nada de cuentas: el PIN es la única puerta.
- Audio cifrado en tránsito si sirves por HTTPS, pero no de extremo a extremo.
- No hay grabaciones, ni historial de audio, ni llamadas, ni avisos especiales: solo
  canales, voz y chat.

Licencia MIT.

# 📻 Walkie Lagos

Walkie-talkie para el restaurante. Pulsas el botón, hablas, sueltas y te oyen los
compañeros que estén en tu canal. Además hay chat escrito.

```
npm install
npm start        # http://localhost:3000
```

PIN por defecto: `lagos` (cámbialo en `config.json`).

## Sin servidor (solo la wifi del local)

En la app Android se elige **"Solo wifi"**: los móviles se hablan directamente entre ellos
por multicast, sin servidor, sin internet y sin configurar nada. El router es el único
"host". No hay historial de chat ni cruza a otras redes; el resto funciona igual (canales,
turno de palabra, texto).

El protocolo está especificado en `lan/protocol.mjs` (paquete binario `WLK1`, grupo
`239.255.43.43:45454`) e implementado en Kotlin en `android/.../LanPacket.kt`. Se prueba de
verdad con dos nodos por multicast: `node test/lan.test.mjs`.

## Dos formas de usarlo

- **En el móvil (APK de Android)**, instalado como una app: carpeta [`android/`](android/README.md).
  Funciona con la pantalla apagada y se oye entre móviles y navegadores, todo en el mismo canal.
- **En el navegador**, abriendo la dirección del servidor. Sirve para el ordenador de la
  barra o para probar sin instalar nada.

## El APK de Android

El APK se compila solo en GitHub; no hace falta Android Studio:

**Descarga:** <https://github.com/zurdonman/Walkie-lagos/releases/latest> → `walkie-lagos.apk`
(se abre desde el propio móvil). También está en *Actions → Compilar APK → Artifacts*.

**Instalar:** abrir el archivo → permitir "instalar apps desconocidas" para Chrome o
Archivos → Instalar. Si Play Protect avisa, "Instalar de todos modos".

**Configurar:** IP del servidor (`192.168.1.50`), tu nombre, el PIN y el canal.

Para compilarlo en tu ordenador: `cd android && gradle :app:assembleDebug`.

En el móvil, la pantalla de entrada pide:

- **Servidor**: la IP del ordenador del local (ej. `192.168.1.50`) o el dominio si lo
  tienes con HTTPS. Sin puerto, usa el 3000.
- **Nombre**, **PIN** y **canal**.

## Cómo se usa

1. Pones tu nombre y el PIN.
2. Eliges canal: General, Cocina, Sala o Barra.
3. Mantienes pulsado el botón grande y hablas. Sueltas para escuchar.

Las opciones son las mínimas:

- **Un turno por canal**: si alguien está hablando, a ti te avisa en vez de cortarle.
- **Sin límite de tiempo**: mantienes el botón todo lo que necesites; el reloj solo
  muestra cuánto llevas hablando.
- **Chat escrito** al canal, con los últimos mensajes al entrar.
- **Historial en cada equipo**: lo que se dice por voz se convierte en texto en tu
  propio móvil y queda guardado ahí (no hay nube de por medio).
- En el ordenador, la **barra espaciadora** hace de botón.

## Canales

En `config.json`:

```json
{
  "pin": "lagos",
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

- `server.js`: Express + WebSocket. Canales y quién habla en memoria; el chat se
  guarda en `data/history.json` para que no se pierda al reiniciar.
- `public/app.js`: coge el micrófono, lo convierte a PCM 16 bits a 16 kHz y lo manda
  en paquetes de 20 ms (unos 32 kB/s hablando). Al recibir, lo reproduce con un colchón
  de 120 ms para aguantar el wifi.
- `android/`: misma idea en Kotlin, con servicio en primer plano para seguir escuchando
  con el móvil bloqueado. El protocolo es el mismo, así que APK y web conviven.
- Nada de audio se guarda. Solo el historial de texto: `data/history.json` en el
  servidor y una base de datos pequeña en cada móvil (o `localStorage` en la web).

Detalles que evitan los cuelgues típicos de estas apps: ping/pong cada 20 segundos para
tirar conexiones muertas, reconexión automática al volver el wifi, y liberar el turno
cuando alguien se desconecta.

## Si la app se cierra o algo va mal

Hay **dos APK** en cada Release, firmados con la misma clave (así el de pruebas se
instala encima del normal, sin desinstalar):

- `walkie-lagos.apk` → **el normal**, el del día a día.
- `walkie-lagos-diagnostico.apk` → **el de pruebas**. Además de funcionar igual, deja
  escritos todos sus pasos y cualquier fallo en:

  ```
  Descargas/log walkie/walkie-log.txt     (lo que va pasando)
  Descargas/log walkie/walkie-crash.txt   (el fallo completo, si la app se cierra)
  ```

  Si Android no deja escribir en Descargas, se guarda dentro de la app y el botón
  **Registro** (abajo, junto a «Salir») lo envía por el móvil (WhatsApp, correo…).

> Las versiones publicadas antes de este cambio iban firmadas con otra clave: la
> primera vez hay que **desinstalar** la app antigua; a partir de ahí las
> actualizaciones se instalan encima y el historial se conserva.

Cómo mandarme el diagnóstico: instala el APK de pruebas, abre la app, reproduce el
problema y pásame `walkie-crash.txt` (o `walkie-log.txt` si no llegó a generarse el
otro). Con eso se ve exactamente qué falló y en qué móvil.

## Pruebas

```bash
npm test              # servidor, radio wifi, audio e interfaz web
npm run check:android  # revisa el proyecto Android (manifiesto, protocolo, textos, ids)
```

- `test/protocol.test.mjs`: servidor con tres clientes (hablar, turno ocupado, chat, canales).
- `test/audio.test.mjs`: captura de audio por los dos caminos (AudioWorklet y el plan B).
- `test/ui.test.mjs`: la interfaz completa sin navegador.
- `scripts/check-android.py`: el proyecto Android revisado contra el servidor real
  (mensajes del protocolo, permisos, paquetes de audio, textos e ids del layout).

## Límites, sin adornos

- Un servidor y nada de cuentas: el PIN es la única puerta.
- Audio cifrado en tránsito si sirves por HTTPS, pero no de extremo a extremo.
- No hay grabaciones ni historial de audio, ni llamadas, ni avisos especiales: solo
  canales, voz, chat y la transcripción de lo hablado.
- La transcripción es **local** (Vosk, modelo español dentro del APK): puede fallar con
  ruido de cocina o acentos fuertes; en ese caso se queda el aviso de voz y ya está.

Licencia MIT.

# Walkie Lagos para Android

App nativa (Kotlin, sin frameworks) que habla con el mismo servidor que la versión web:
los que usen el APK y los que usen el navegador se oyen entre sí en el mismo canal.

## Dos modos

En la pantalla de entrada se elige:

| | **Solo wifi** (sin servidor) | **Con servidor** |
| --- | --- | --- |
| Qué hace falta | la wifi del local y ya | un ordenador/servidor en la red |
| Internet | no | sí (o red local con el servidor) |
| Dirección y PIN | no | sí |
| Alcance | los móviles de esa wifi | cualquiera con la dirección, aunque esté fuera |
| Historial de chat | sí, guardado **en cada móvil** (500 mensajes por canal) | igual, más la copia del servidor |
| Canales | General, Cocina, Sala, Barra | los que tenga `config.json` |
| Lo hablado | transcrito en el propio móvil y guardado | igual |

## Canales y botón flotante

- **Canales**: General, Cocina, Comedor, Barra y Terraza (índice en el byte 6 del
  paquete). El botón **Canal** cambia sin salir de la app; cada canal tiene su audio,
  su transcripción y su historial en el móvil.
- **Botón flotante**: activándolo con el botón *Botón flotante*, aparece un 🎙️ encima
  de cualquier app. Se **mantiene pulsado para hablar** y se suelta para escuchar; un
  toque corto abre Walkie Lagos; arrastrándolo se cambia de sitio y se recuerda.
  Android pide una vez el permiso **«mostrar sobre otras apps»**; si no se concede, la
  app lo explica y no aparece el botón.

## Dos APK y registro de fallos

Cada Release publica `walkie-lagos.apk` (normal) y `walkie-lagos-diagnostico.apk`
(depurable, con el mismo código). Los dos van firmados con la misma clave
(`scripts/keystore.b64` → `WALKIE_KEYSTORE` en la compilación), así uno se instala
encima del otro.

En el de diagnóstico, `WalkieLog` escribe:

- `Descargas/log walkie/walkie-log.txt`: cada paso (arranque, modo, canal, errores).
- `Descargas/log walkie/walkie-crash.txt`: la pila del fallo si la app se cierra,
  con los datos del móvil y las últimas 60 líneas del registro.

En Android 10+ no hace falta permiso (carpeta de Descargas pública); en Android 9 y
anteriores se pide `WRITE_EXTERNAL_STORAGE` solo para eso. El botón **Registro** de la
pantalla abre un diálogo con la ruta y lo comparte con `FileProvider`. Si la pantalla
normal no se puede montar, aparece una pantalla mínima con el motivo en vez de cerrarse.

## Transcripción (lo hablado queda escrito)

Cuando alguien suelta el botón, el móvil **de quien habló** no hace nada especial: cada
móvil que lo escuchó pasa ese audio por **Vosk** (reconocimiento de voz **offline**,
modelo español pequeño) y añade el texto a su historial con el nombre de quien habló,
como un mensaje más del chat.

- El modelo (`vosk-model-small-es-0.42`, unos 40 MB) se descarga **al compilar** y va
  dentro del APK (por eso el APK pasa de 6 MB a ~61 MB). Al primer arranque se copia a
  la carpeta privada de la app.
- No sale nada a internet: la transcripción ocurre en el teléfono, sin cuenta ni nube.
- Si el modelo no está, la app sigue igual, solo sin transcripción.
- Con ruido de cocina puede equivocarse o no entender nada; en ese caso simplemente no
  aparece el mensaje de voz.

En **solo wifi** los móviles se hablan directamente por **multicast UDP**
(`239.255.43.43:45454`): el router es el único "host" y no hay nada que instalar ni
configurar. Cada móvil tiene su **nodeId** aleatorio de 8 bytes que viaja en cada
paquete, así que se reconocen entre ellos y descartan sus propios paquetes.

Lo que **no** puede hacer el modo sin servidor:

- **Cruzar redes**: si el móvil se va a datos móviles u otra wifi, deja de oír. El
  multicast no sale del router.
- **Compartir el historial entre móviles**: cada uno guarda el suyo; si entras a mitad
  de servicio ves lo que ya se dijo desde que instalaste la app, no antes.
- **Funcionar con el ahorro de batería agresivo** en algunos móviles (Xiaomi, Huawei):
  hay que permitir que la app siga en segundo plano.
- Si el router tiene **aislamiento de clientes (AP isolation)** activado, los móviles no
  se ven entre sí. Es un ajuste del router, no de la app.

## Qué hace

- Escucha y habla con la **pantalla apagada** o la app en segundo plano (servicio en
  primer plano con notificación).
- Botón grande de **mantener para hablar**, chat escrito y lista de canales.
- Reconexión automática al volver la wifi; turno de palabra único por canal.
- Audio PCM 16 bits a 16 kHz, ~32 kB/s hablando.

## Configuración

En la pantalla de entrada se pide:

- **Servidor**: la IP del ordenador/servidor del local (`192.168.1.50`), o un dominio
  (`walkie.turestaurante.com` para HTTPS). Si no pones puerto, usa el 3000.
- **Nombre**, **PIN** y **canal**.

## Cómo conseguir el APK

No hace falta instalar Android Studio: GitHub lo compila en cada push.

**Descarga directa** (la más cómoda): abre
<https://github.com/zurdonman/Walkie-lagos/releases/latest> en el móvil y toca
`walkie-lagos.apk`. Se guarda en Descargas.

**Desde Actions**: pestaña *Actions* → "Compilar APK" → última ejecución → *Artifacts* →
`walkie-lagos-apk` (es un .zip, hay que descomprimirlo).

### Instalarlo en el Android

1. Descarga `walkie-lagos.apk` en el móvil (o pásalo por WhatsApp/Drive/cable).
2. Ábrelo desde Descargas o desde el gestor de archivos.
3. Android dirá que no puede instalar apps de esta fuente: toca **Ajustes** y activa
   **"Permitir desde esta aplicación"** (Chrome o Archivos). Es normal, el APK no viene
   de Play Store.
4. Puede salir *"¿Instalar aplicación desconocida?"* → **Instalar**. Si Play Protect
   avisa, elige **"Instalar de todos modos"**.
5. Al abrir la app: acepta el permiso de **micrófono** (imprescindible para hablar) y el
   de **notificaciones** (para que siga conectada con la pantalla apagada).
6. Escribe la IP del servidor, tu nombre, el PIN y el canal → **Entrar**.

Cada nueva versión se instala encima (no hace falta desinstalar) siempre que la firma
sea la misma; los APK de depuración generados aquí lo son.

### Compilarlo tú mismo

Con Android Studio (Ladybug o posterior): *File → Open* → carpeta `android/` → Run.
Por consola, con el SDK de Android instalado y `JAVA_HOME` apuntando a un JDK 17:

```bash
cd android
gradle :app:assembleDebug
# queda en app/build/outputs/apk/debug/app-debug.apk
```

## Estructura

```
app/src/main/java/com/walkielagos/app/
  MainActivity.kt    pantalla: entrada, botón de hablar, chat
  VoiceService.kt    servicio en primer plano: micrófono, altavoz, notificación
  VoiceClient.kt     WebSocket (OkHttp) y reconexión
  Protocol.kt        mensajes JSON del servidor
  Pcm.kt             remuestreo a 16 kHz y empaquetado en 20 ms
  LanPacket.kt       formato del paquete de la radio wifi (idéntico a lan/protocol.mjs)
  LanRadio.kt        sockets multicast, turno de palabra, latidos y canales
  LanService.kt      servicio en primer plano del modo sin servidor
  ChatAdapter.kt     lista del chat
```

## Detalles que importan en un restaurante

- El servicio pide el tipo `microphone` en primer plano: Android no corta el audio al
  bloquear la pantalla, que es justo cuando más se usa.
- `usesCleartextTraffic` está activado para poder usar el servidor por `ws://` dentro de
  la wifi del local. Si lo publicas en internet, usa `wss://` (dominio con HTTPS).
- El audio no se guarda en el móvil ni en el servidor.

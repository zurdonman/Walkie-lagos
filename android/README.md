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
| Historial de chat | no (solo en directo) | sí, últimos 60 mensajes |
| Canales | General, Cocina, Sala, Barra | los que tenga `config.json` |

En **solo wifi** los móviles se hablan directamente por **multicast UDP**
(`239.255.43.43:45454`): el router es el único "host" y no hay nada que instalar ni
configurar. Cada móvil tiene su **nodeId** aleatorio de 8 bytes que viaja en cada
paquete, así que se reconocen entre ellos y descartan sus propios paquetes.

Lo que **no** puede hacer el modo sin servidor:

- **Cruzar redes**: si el móvil se va a datos móviles u otra wifi, deja de oír. El
  multicast no sale del router.
- **Guardar el chat**: no hay memoria compartida; si abres la app a mitad de servicio,
  no ves lo de antes.
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

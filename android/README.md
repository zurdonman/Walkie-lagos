# Walkie Lagos para Android

App nativa (Kotlin, sin frameworks) que habla con el mismo servidor que la versión web:
los que usen el APK y los que usen el navegador se oyen entre sí en el mismo canal.

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

No hace falta instalar Android Studio. Al subir cambios a GitHub, la acción
`.github/workflows/build-apk.yml` compila el APK:

1. Pestaña **Actions** → última ejecución de "Compilar APK".
2. Abajo, en **Artifacts**, descarga `walkie-lagos-apk`.
3. Descomprime y pasa `walkie-lagos.apk` al móvil (WhatsApp, Drive, cable…).
4. En el móvil: abrir el archivo y permitir **"Instalar apps desconocidas"** para esa
   aplicación (Chrome/Archivos). Es normal: el APK no viene de Play Store.

Si el repositorio está en `main`, además se publica en **Releases** con enlace directo.

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
  ChatAdapter.kt     lista del chat
```

## Detalles que importan en un restaurante

- El servicio pide el tipo `microphone` en primer plano: Android no corta el audio al
  bloquear la pantalla, que es justo cuando más se usa.
- `usesCleartextTraffic` está activado para poder usar el servidor por `ws://` dentro de
  la wifi del local. Si lo publicas en internet, usa `wss://` (dominio con HTTPS).
- El audio no se guarda en el móvil ni en el servidor.

#!/usr/bin/env python3
"""Comprobaciones del proyecto Android que se pueden hacer sin Android Studio.

Revisa el manifiesto, Gradle, el protocolo (comparado con el servidor Node), el
audio, los textos/ids del layout y la lógica de direcciones del servidor.

    python3 scripts/check-android.py     (o  npm run check:android)
"""
import re
import sys
import os
import json

fail = []
def ok(cond, msg):
    print(("  ✓ " if cond else "  ✗ ") + msg)
    if not cond: fail.append(msg)

m = open('android/app/src/main/AndroidManifest.xml').read()
print("\nMANIFIESTO")
ok('android.permission.RECORD_AUDIO' in m, 'permiso de micrófono')
ok('android.permission.FOREGROUND_SERVICE_MICROPHONE' in m, 'servicio en primer plano de micrófono')
ok('android:foregroundServiceType="microphone"' in m, 'el servicio declara el tipo microphone')
ok('android.permission.INTERNET' in m, 'permiso de red')
ok('usesCleartextTraffic="true"' in m, 'permite ws:// en la wifi del local')
ok('.MainActivity' in m and 'android:exported="true"' in m, 'actividad principal lanzadora')
ok('minSdk' not in m, 'minSdk se define en Gradle (correcto)')

g = open('android/app/build.gradle.kts').read()
print("\nGRADLE")
ok('minSdk = 26' in g, 'Android 8 o superior')
ok('compileSdk = 35' in g, 'compila contra API 35')
ok('okhttp3:okhttp' in g, 'OkHttp para el WebSocket')
ok('buildFeatures' in g and 'viewBinding = true' in g, 'viewBinding activado (lo usa la actividad)')
ok('com.android.application' in open('android/build.gradle.kts').read(), 'plugin de Android aplicado')

lan = open('android/app/src/main/java/com/walkielagos/app/LanPacket.kt').read()
lanradio = open('android/app/src/main/java/com/walkielagos/app/LanRadio.kt').read()
proto_ref = open('lan/protocol.mjs').read()
print("\nMODO SIN SERVIDOR (wifi)")
for const, in [('"239.255.43.43"',), ('45454',), ('"WLK1"',)]:
    ok(const in lan, f'constante {const} igual que lan/protocol.mjs')
ok('239.255.43.43' in proto_ref and '45454' in proto_ref, 'la referencia Node usa el mismo grupo y puerto')
ok('CHANGE_WIFI_MULTICAST_STATE' in m, 'permiso para recibir multicast con la pantalla apagada')
ok('MulticastLock' in lanradio, 'toma el MulticastLock mientras la radio está abierta')
ok('TYPE_CLAIM' in lan and 'hasPriority' in lan, 'turno de palabra con nodeId menor en colisión')
ok('TYPE_HEARTBEAT' in lan and '7000' in lanradio, 'latidos y caducidad de nodos')
ok('sequenceOf' in lan, 'descarta audio repetido o viejo')

kt = open('android/app/src/main/java/com/walkielagos/app/VoiceClient.kt').read()
proto = open('android/app/src/main/java/com/walkielagos/app/Protocol.kt').read()
print("\nPROTOCOLO (servidor Java vs servidor Node)")
for msg in ['join', 'talk', 'chat', 'switch', 'ping']:
    ok(f'"type", "{msg}"' in proto.replace("put('type'", 'put("type"') or f'put("type", "{msg}")' in proto, f'envía "{msg}"')
for field in ['maxTalkSeconds', 'users', 'history', 'rooms', 'from', 'text', 'ts', 'online', 'by', 'message']:
    ok(f'"{field}"' in proto, f'lee el campo "{field}"')
ok('/ws' in kt, 'conecta a /ws como el servidor')
ok('pingInterval(20' in kt, 'keep-alive de 20 s como el servidor')
ok('scheduleRetry' in kt, 'reconexión automática')

svc = open('android/app/src/main/java/com/walkielagos/app/VoiceService.kt').read()
print("\nAUDIO")
ok('MediaRecorder.AudioSource.VOICE_COMMUNICATION' in svc, 'usa la fuente de voz (cancelación de eco)')
ok('MODE_IN_COMMUNICATION' in svc, 'modo de audio de llamada')
ok('AudioTrack' in svc and '.write(' in svc, 'reproduce el audio entrante')
ok('120_000_000L' in svc, 'colchón de 120 ms contra los tirones del wifi')
pcm = open('android/app/src/main/java/com/walkielagos/app/Pcm.kt').read()
ok('SAMPLE_RATE = 16_000' in pcm, '16 kHz como la web')
ok('PACKET_SAMPLES = SAMPLE_RATE / 50' in pcm, 'paquetes de 20 ms')
ok('bytes[i * 2]' in pcm and 'bytes[i * 2 + 1]' in pcm, 'PCM 16 bits little-endian')

lay = open('android/app/src/main/res/layout/activity_main.xml').read()
ids_kotlin = set(re.findall(r'binding\.(\w+)', open('android/app/src/main/java/com/walkielagos/app/MainActivity.kt').read()))
ids_kotlin -= {'root', 'login', 'stage', 'chatBar'}
ids_kotlin = {i for i in ids_kotlin if i[0].islower()}  # descarta clases (ActivityMainBinding)
ids_xml = set(re.findall(r'@\+id/(\w+)', lay))
print("\nKOTLIN")
kt_files = __import__('glob').glob('android/app/src/main/java/com/walkielagos/app/*.kt')
empty_catch = [(f, i + 1) for f in kt_files for i, line in enumerate(open(f).read().splitlines()) if line.strip() == 'catch {}']
ok(not empty_catch, f'sin catch vacíos (Kotlin no los admite){" -> " + str(empty_catch) if empty_catch else ""}')

print("\nINTERFAZ")
missing = sorted(ids_kotlin - ids_xml)
ok(not missing, f'todos los ids que usa el código existen{" (faltan: " + ", ".join(missing) + ")" if missing else ""}')
ok('@+id/ptt' in lay and '@+id/chatList' in lay, 'botón de hablar y lista de chat')

strings = open('android/app/src/main/res/values/strings.xml').read()
used = set(re.findall(r'R\.string\.(\w+)', open('android/app/src/main/java/com/walkielagos/app/MainActivity.kt').read()))
used |= set(re.findall(r'R\.string\.(\w+)', svc)) if 'R.string.' in svc else set()
defined = set(re.findall(r'<string name="(\w+)"', strings))
ok(not (used - defined), f'textos usados existen{" (faltan: " + ", ".join(sorted(used - defined)) + ")" if used - defined else ""}')
layout_strings = set(re.findall(r'@string/(\w+)', lay))
ok(not (layout_strings - defined), f'todos los @string del layout existen{" (faltan: " + ", ".join(sorted(layout_strings - defined)) + ")" if layout_strings - defined else ""}')
colors = open('android/app/src/main/res/values/colors.xml').read()
# los dos selectores de color del botón son <color> dentro de res/color/
selector_colors = {'ptt_tint', 'ptt_text'}
used_colors = set(re.findall(r'@color/(\w+)', lay + open('android/app/src/main/res/values/themes.xml').read() + m))
used_colors -= selector_colors
ok(all(f'name="{c}"' in colors for c in used_colors), 'todos los colores usados están definidos')

print("\nPACOTES / WRAPPER")
ok('distributionUrl' in open('android/gradle/wrapper/gradle-wrapper.properties').read(), 'gradle wrapper configurado')
wf = open('.github/workflows/build-apk.yml').read()
ok('assembleDebug' in wf and 'upload-artifact' in wf, 'la acción compila y publica el APK')

# normalize() de VoiceClient: replicamos la lógica en Python y probamos casos
print("\nDIRECCIONES DEL SERVIDOR (misma lógica que normalize)")
def normalize(raw):
    v = raw.strip()
    if not v: return None
    if not (v.startswith('ws://') or v.startswith('wss://')):
        secure = v.startswith('https://')
        v = v.replace('http://','',1).replace('https://','',1).rstrip('/')
        if ':' not in v: v += ':3000'
        v = ('wss://' if secure else 'ws://') + v
    elif ':' not in v.replace('ws://','',1).replace('wss://','',1):
        v = v.rstrip('/') + ':3000'
    host_part = v.replace('ws://','',1).replace('wss://','',1).split('/')[0]
    host = host_part.split(':')[0]
    if not host or ' ' in host_part: return None
    return v + '/ws'
for raw, expected in [
    ('192.168.1.50', 'ws://192.168.1.50:3000/ws'),
    ('192.168.1.50:8080', 'ws://192.168.1.50:8080/ws'),
    ('https://walkie.turestaurante.com', 'wss://walkie.turestaurante.com:3000/ws'),
    ('ws://mi-servidor.local:3000', 'ws://mi-servidor.local:3000/ws'),
    ('  ', None),
    ('con espacio', None),
]:
    got = normalize(raw)
    ok(got == expected, f'{raw!r} -> {got!r}')

print("\nHISTORIAL Y TRANSCRIPCIÓN")
hist = open('android/app/src/main/java/com/walkielagos/app/HistoryStore.kt').read()
ok('CREATE TABLE messages' in hist, 'historial en SQLite dentro de cada móvil')
ok('MAX_PER_ROOM' in hist, 'el historial no crece sin freno')
tr = open('android/app/src/main/java/com/walkielagos/app/Transcriber.kt').read()
ok('org.vosk' in tr, 'transcripción offline con Vosk')
ok('installIfBundled' in tr, 'el modelo se instala desde assets en el móvil')
ok('acceptWaveForm(pcm.copyOfRange' in tr, 'Vosk recibe tramos de 1 s (no pares byte+len)')
gradle = open('android/app/build.gradle.kts').read()
ok('vosk-android' in gradle and 'net.java.dev.jna:jna' in gradle, 'Vosk con su dependencia JNA')
ok('noCompress' in gradle, 'el modelo va sin comprimir en el APK (Android 11+)')
ok('Transcriber.Listener' in open('android/app/src/main/java/com/walkielagos/app/LanService.kt').read()
   and 'Transcriber.Listener' in open('android/app/src/main/java/com/walkielagos/app/VoiceService.kt').read(),
   'la transcripción se engancha en los dos modos')
wf2 = open('.github/workflows/build-apk.yml').read()
ok('vosk-model-small-es' in wf2, 'la compilación trae el modelo español')
main_act = open('android/app/src/main/java/com/walkielagos/app/MainActivity.kt').read()
ok('loadHistory' in main_act and 'store.add' in main_act, 'la pantalla carga y guarda el historial')
srv = open('server.js').read()
ok('saveHistory' in srv and 'writeHistoryNow' in srv, 'el servidor guarda el historial en disco')
ok('maxTalkSeconds: 0' in srv or 'MAX_TALK_MS = Math.max(0' in srv, 'sin límite de tiempo al hablar')

lan_svc = open('android/app/src/main/java/com/walkielagos/app/LanService.kt').read()
voice_svc = open('android/app/src/main/java/com/walkielagos/app/VoiceService.kt').read()
ok('sendChat(text)' in lan_svc and 'sendChat(text)' in voice_svc,
   'quien habla transcribe y manda el texto a los demás')
ok('AUDIO_NOTE' in lan_svc, 'si no hay transcripción queda el aviso de voz')
ok('ownPcm' in lan_svc and 'ownPcm' in voice_svc, 'se acumula lo que dice el hablante')

ok('installIfBundled' in tr and 'executor.execute' in tr.split('installIfBundled')[1][:800],
   'la copia del modelo no bloquea la pantalla')
ok('if (!installed()) return false' in tr, 'mientras se copia, no se da por roto')

print("\nLAYOUT: TODO ELEMENTO CON TAMAÑO (si falta, la app se cierra al abrir)")
# Android exige layout_width y layout_height en cada Vista del XML; un <include> o un
# <requestFocus> no los llevan. Este fallo ya cerró la app una vez: 65: You must
# supply a layout_width attribute.
import xml.etree.ElementTree as ET
ns = '{http://schemas.android.com/apk/res/android}'
import glob
sin_tamano = []
files = sorted(glob.glob('android/app/src/main/res/layout/*.xml'))
for path in files:
  layout_root = ET.parse(path).getroot()
  for element in layout_root.iter():
    tag = element.tag.split('.')[-1]
    if tag in ('include', 'requestFocus', 'merge'):
        continue
    for attr in ('layout_width', 'layout_height'):
        if ns + attr not in element.attrib:
            sin_tamano.append(f"{path.split('/')[-1]}:{tag}({element.attrib.get(ns + 'id', 'sin id')}).{attr}")
ok(not sin_tamano, 'todas las vistas llevan layout_width y layout_height' + (f" → {sin_tamano[:4]}" if sin_tamano else ''))
# El estilo tampoco sirve: el inflador exige el atributo en la propia vista.
estilos = open('android/app/src/main/res/values/themes.xml').read()
ok('name="Widget.Walkie.Field"' in estilos, 'el estilo de los campos existe')

print("\nRADIO WIFI (que se oigan los móviles)")
radio_kt = open('android/app/src/main/java/com/walkielagos/app/LanRadio.kt').read()
ok('NetworkInterface' in radio_kt, 'elige la interfaz de la wifi (no los datos móviles)')
ok('setNetworkInterface' in radio_kt or 'networkInterface =' in radio_kt, 'el envío sale por la wifi')
ok('joinGroup(InetSocketAddress' in radio_kt, 'se une al grupo en la interfaz concreta')
ok('MulticastLock' in radio_kt, 'pide el bloqueo de multicast (pantalla apagada)')
ok('status =' in radio_kt, 'guarda un resumen del estado para enseñarlo')
ok('WalkieLog.i("Radio wifi' in radio_kt, 'deja la radio en el registro')
lan_svc2 = open('android/app/src/main/java/com/walkielagos/app/LanService.kt').read()
ok('Event.PeerCount' in lan_svc2, 'la cuenta de la wifi llega a la pantalla')
ok('Event.Status' in lan_svc2, 'el estado de la radio llega a la pantalla')
main2 = open('android/app/src/main/java/com/walkielagos/app/MainActivity.kt').read()
ok('if (!lanMode && !connected)' in main2, 'en wifi se puede hablar sin esperar al servidor')
ok(main2.index('LanService.listener =') < main2.index('startForegroundService(intent)'),
   'la pantalla escucha al servicio antes de arrancarlo')
ok('getUriForFile' in main2 and 'getOrNull()' in main2, 'enviar el registro no puede cerrar la app')
paths = open('android/app/src/main/res/xml/file_paths.xml').read()
ok('external-path' in paths, 'el archivo de Descargas se puede enviar')

print("\nKOTLIN BÁSICO (errores que rompen la compilación)")
import glob as _glob
descuadre = []
for _f in _glob.glob('android/app/src/main/java/com/walkielagos/app/*.kt'):
    _s = open(_f).read()
    if _s.count('{') != _s.count('}'):
        descuadre.append(_f.split('/')[-1])
ok(not descuadre, 'llaves { } equilibradas en todos los .kt' + (f" → {descuadre}" if descuadre else ''))

print("\nCANALES Y BOTÓN FLOTANTE")
lan_pkt = open('android/app/src/main/java/com/walkielagos/app/LanPacket.kt').read()
proto = open('lan/protocol.mjs').read()
import re as _re
rooms_kt = _re.search(r'val ROOMS = listOf\(([^)]*)\)', lan_pkt).group(1)
rooms_js = _re.findall(r"name: '([^']+)'", proto.split('export const ROOMS')[1].split('];')[0])
nombres_kt = [x.strip().strip('"') for x in rooms_kt.split(',')]
ok(nombres_kt == rooms_js, f'los canales coinciden en Android y en el protocolo ({", ".join(nombres_kt)})')
ok('Comedor' in nombres_kt and 'Barra' in nombres_kt, 'están Comedor y Barra')
cfg_rooms = [r['id'] for r in json.load(open('config.json'))['rooms']]
ok(cfg_rooms == ['general','cocina','comedor','barra','terraza'], 'el servidor ofrece los mismos canales')
ok('MAX_TEXT_BYTES' in proto and 'MAX_TEXT_BYTES' in lan_pkt, 'texto largo sin cortar (antes: 200 caracteres)')
radio2 = open('android/app/src/main/java/com/walkielagos/app/LanRadio.kt').read()
ok('fun setRoom' in radio2, 'la radio cambia de canal sin reiniciar')
ok('ACTION_ROOM' in open('android/app/src/main/java/com/walkielagos/app/LanService.kt').read(), 'el servicio acepta el cambio de canal')
ok('roomButton' in open('android/app/src/main/res/layout/activity_main.xml').read(), 'botón «Canal» en la pantalla')
float_kt = open('android/app/src/main/java/com/walkielagos/app/FloatingButton.kt').read()
ok('TYPE_APPLICATION_OVERLAY' in float_kt, 'el botón flotante es una capa sobre otras apps')
ok('canDrawOverlays' in float_kt, 'pide el permiso de «mostrar sobre otras apps»')
ok('ACTION_MOVE' in float_kt and 'stopTalking' in float_kt, 'se mantiene pulsado para hablar y se arrastra para moverlo')
ok('SYSTEM_ALERT_WINDOW' in open('android/app/src/main/AndroidManifest.xml').read(), 'permiso declarado en el manifiesto')
ok('enableFloating' in lan_svc and 'enableFloating' in open('android/app/src/main/java/com/walkielagos/app/VoiceService.kt').read(),
   'los dos modos (wifi y servidor) tienen botón flotante')

print("\nCHAT Y LO HABLADO EN EL CHAT")
layout_txt = open('android/app/src/main/res/layout/activity_main.xml').read()
ok('@+id/chatBar' in layout_txt and 'layout_weight="1"' in layout_txt.split('@+id/chatBar')[1][:400],
   'el chat ocupa su espacio (antes: 150dp fijos)')
ok('@+id/chatInput' in layout_txt and '@+id/sendButton' in layout_txt, 'hay caja de texto y botón de enviar')
ok('@+id/status' in layout_txt, 'línea para el estado de la radio (IP y grupo)')
ok('chat.add(mio)' in main_act, 'lo que escribo aparece al momento en el chat')
ok('isDuplicate' in main_act, 'y no se duplica cuando vuelve del servicio')
ok('noteVoz' in lan_svc, 'si no se transcribe, queda el aviso de voz')
ok('isAvailable()' in lan_svc, 'se comprueba el modelo antes de gastar tiempo')
ok('Voz: transcribiendo' in tr, 'la transcripción deja rastro en el registro')

print("\nREGISTRO DE FALLOS (para saber por qué se cierra)")
# Regla sencilla que evita un error que ya rompió la compilación: dentro de un
# bloque apply de un botón, Toast.makeText(this, ...) apunta al botón, no a la pantalla.
toast_bad = [l for l in main_act.splitlines() if 'Toast.makeText(this' in l and l.strip().startswith('android.widget')]
ok(not toast_bad, 'los avisos usan la función toast() y no Toast.makeText(this…) dentro de apply')
log_kt = open('android/app/src/main/java/com/walkielagos/app/WalkieLog.kt').read()
ok('Download' in log_kt and 'log walkie' in log_kt, 'el registro va a Descargas/log walkie')
ok('UncaughtExceptionHandler' in log_kt or 'setDefaultUncaughtExceptionHandler' in log_kt, 'captura el fallo que cierra la app')
ok('walkie-crash.txt' in log_kt, 'deja el informe de fallo en walkie-crash.txt')
ok('privateDir' in log_kt and 'canWrite' in log_kt, 'si no puede en Descargas, guarda dentro de la app')
man = open('android/app/src/main/AndroidManifest.xml').read()
ok('FileProvider' in man and 'file_paths' in man, 'la app puede enviar el archivo del registro')
ok('WRITE_EXTERNAL_STORAGE' in man and 'maxSdkVersion="28"' in man, 'permiso de escritura solo donde hace falta')
ok('.LanService' in man, 'el servicio wifi está declarado (sin esto se cierra al entrar)')
layout = open('android/app/src/main/res/layout/activity_main.xml').read()
ok('@+id/logButton' in layout, 'botón «Registro» en la pantalla')
main_kt = open('android/app/src/main/java/com/walkielagos/app/MainActivity.kt').read()
ok('WalkieLog.start(this)' in main_kt, 'el registro arranca al abrir la app')
ok(main_kt.index('WalkieLog.start(this)') < main_kt.index('ActivityMainBinding.inflate'), 'antes de dibujar la pantalla')
ok('safe("Entrar")' in main_kt, 'un fallo al entrar no cierra la app')
ok('showFallback' in main_kt, 'si la pantalla no se puede montar, se ve el motivo')
ok('buildUi(' in main_kt, 'el montaje de la pantalla está protegido')
wf3 = open('.github/workflows/build-apk.yml').read()
ok('assembleRelease' in wf3 and 'walkie-lagos-diagnostico.apk' in wf3, 'se publican el APK normal y el de diagnóstico')
ok('keystore.b64' in wf3, 'los dos van firmados con la misma clave')
ok(os.path.exists('scripts/keystore.b64'), 'la clave está en el repositorio (APK actualizables)')
gradle2 = open('android/app/build.gradle.kts').read()
ok('versionCode = 6' in gradle2, 'la versión sube para poder instalar encima')

print("\nRESUMEN:", "TODO OK" if not fail else f"{len(fail)} FALLOS")
sys.exit(0 if not fail else 1)

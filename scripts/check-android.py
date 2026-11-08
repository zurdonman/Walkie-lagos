#!/usr/bin/env python3
"""Comprobaciones del proyecto Android que se pueden hacer sin Android Studio.

Revisa el manifiesto, Gradle, el protocolo (comparado con el servidor Node), el
audio, los textos/ids del layout y la lógica de direcciones del servidor.

    python3 scripts/check-android.py     (o  npm run check:android)
"""
import re
import sys

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

print("\nRESUMEN:", "TODO OK" if not fail else f"{len(fail)} FALLOS")
sys.exit(0 if not fail else 1)

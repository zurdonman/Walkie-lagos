/**
 * Prueba de la radio sin servidor: dos nodos que se oyen por multicast en la
 * misma máquina. Comprueba el formato del paquete, el audio, el texto, el turno
 * de palabra y quién gana cuando dos hablan a la vez.
 *
 *   node test/lan.test.mjs
 */
import { encode, decode, TYPE, ROOMS, FRAME_SAMPLES, hasPriority } from '../lan/protocol.mjs';
import { LanRadio } from '../lan/radio.mjs';

let failures = 0;
function check(cond, msg) {
  console.log(`  ${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) failures += 1;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('\nFORMATO DEL PAQUETE (lo mismo que implementa android/.../LanPacket.kt)');
const sample = encode({
  type: TYPE.audio,
  room: 'cocina',
  nodeId: 'aabbccddeeff0011',
  name: 'Marta',
  payload: Buffer.alloc(640, 7),
});
check(sample.subarray(0, 4).toString() === 'WLK1', 'empieza por el magic "WLK1"');
check(sample[4] === 1, 'versión 1');
check(sample[5] === TYPE.audio, 'tipo audio');
check(ROOMS[sample[6]].id === 'cocina', 'canal en el byte 6');
check(sample[7] === 5, 'longitud del nombre');
check(sample.subarray(8, 16).toString('hex') === 'aabbccddeeff0011', 'nodeId de 8 bytes');
check(sample.subarray(16, 21).toString() === 'Marta', 'nombre en UTF-8');
check(sample.length === 16 + 5 + 640, 'cabecera + nombre + audio');
check(sample.length < 1500, `cabe en un paquete IP sin fragmentar (${sample.length} B)`);

const back = decode(sample);
check(back.name === 'Marta' && back.room === 'cocina' && back.payload.length === 640, 'se decodifica igual');
check(decode(Buffer.from('WLK2....')) === null, 'rechaza magic ajeno');
check(decode(Buffer.alloc(10)) === null, 'rechaza paquetes cortos');
check(decode(encode({ type: TYPE.chat, room: 'sala', nodeId: '11'.repeat(8), name: 'Ñandú 🍳', payload: Buffer.from('hola') })).name === 'Ñandú 🍳', 'soporta acentos y emoji en el nombre');

check(hasPriority('1111111111111111', '2222222222222222'), 'en una colisión gana el nodeId menor');
check(!hasPriority('ffffffffffffffff', '0000000000000000'), 'y pierde el mayor');

console.log('\nRADIO REAL POR MULTICAST');
const events = { a: [], b: [] };
// La prueba corre en una máquina, no en una wifi con dos móviles: el
// descubrimiento inicial (latidos) tarda una ronda, así que aquí lo forzamos.
const marta = new LanRadio({ name: 'Marta', nodeId: '1111111111111111', onEvent: (e) => events.a.push(e) });
const luis = new LanRadio({ name: 'Luis', nodeId: '2222222222222222', onEvent: (e) => events.b.push(e) });

await marta.start();
await luis.start();
await wait(300);
const known = marta.peers.has(luis.nodeId) && luis.peers.has(marta.nodeId);
if (!known) {
  // Los dos se unen al mismo grupo casi a la vez y los latidos caen juntos;
  // se repite un latido para simular el siguiente ciclo (2 s en la app real).
  marta.sendHeartbeat();
  luis.sendHeartbeat();
  await wait(200);
}
check(marta.peers.has(luis.nodeId) && luis.peers.has(marta.nodeId), `se ven entre sí en la wifi (${marta.onlineCount} nodos)`);

marta.sendChat('Mesa 4 lista');
await wait(200);
check(events.b.some((e) => e.type === 'chat' && e.text === 'Mesa 4 lista' && e.from === 'Marta'), 'el texto llega al otro móvil');

const frame = Buffer.alloc(FRAME_SAMPLES * 2);
for (let i = 0; i < frame.length; i += 2) frame.writeInt16LE(Math.round(8000 * Math.sin(i / 8)), i);
marta.claimTalk();
marta.sendAudio(frame);
marta.sendAudio(frame);
await wait(250);
const audioEvents = events.b.filter((e) => e.type === 'audio');
check(audioEvents.length === 2, `llegan los 2 paquetes de voz (${audioEvents.length})`);
check(audioEvents[0]?.data.length === 640, 'cada paquete son 20 ms a 16 kHz');
check(events.b.some((e) => e.type === 'speakerStart' && e.from === 'Marta'), 'Luis ve que Marta habla');
marta.releaseTalk();
await wait(200);
check(events.b.some((e) => e.type === 'speakerEnd'), 'y que ha terminado');

console.log('\nCOLISIÓN: los dos empiezan a hablar a la vez');
events.a.length = 0;
events.b.length = 0;
marta.claimTalk();
luis.claimTalk();
await wait(250);
check(marta.talking === true, 'gana el nodeId menor (Marta, 1111…)');
check(luis.talking === false, 'el otro cede el turno');
check(events.b.some((e) => e.type === 'preempted' && e.by === 'Marta'), 'y se le avisa');
marta.releaseTalk();
luis.releaseTalk();

console.log('\nUN CANAL DISTINTO NO SE OYE');
events.b.length = 0;
luis.setRoom('cocina');
await wait(200);
marta.sendChat('esto es de general');
await wait(200);
check(!events.b.some((e) => e.type === 'chat' && e.text === 'esto es de general'), 'Luis, en cocina, no recibe lo de general');
marta.setRoom('cocina');
await wait(200);
marta.sendChat('ahora sí');
await wait(250);
check(events.b.some((e) => e.type === 'chat' && e.text === 'ahora sí'), 'al cambiar de canal, sí');

console.log('\nSALIR');
events.a.length = 0;
await luis.stop();
await wait(300);
check(!marta.peers.has(luis.nodeId), 'Marta deja de contar a Luis al salir');
await marta.stop();

console.log(failures === 0 ? '\nTODO OK\n' : `\n${failures} FALLOS\n`);
process.exit(failures === 0 ? 0 : 1);

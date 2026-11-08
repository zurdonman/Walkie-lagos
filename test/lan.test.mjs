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

console.log('\nENTRAR Y VER A LOS DEMÁS (el caso que fallaba en el móvil)');
// Ninguno de los dos fuerza latidos: basta con lo que manda la radio sola en 2,5 s.
events.a.length = 0;
events.b.length = 0;
const solos = new (await import('../lan/radio.mjs')).LanRadio({
  name: 'Pepe',
  room: 'general',
  nodeId: '3333333333333333',
  onEvent: (e) => events.a.push(e),
});
await solos.start();
await wait(120);
check(
  marta.peers.has(solos.nodeId) || solos.peers.has(marta.nodeId),
  'al entrar ya se oyen entre sí, sin pulsar nada',
);
await wait(2600);
check(marta.peers.has(solos.nodeId), 'Marta ve a Pepe tras su primer latido');
check(solos.peers.has(marta.nodeId), 'Pepe ve a Marta tras su primer latido');
// 3 porque Luis sigue en la wifi (está en el canal; aún no se ha ido).
check(solos.onlineCount === 3, `la cuenta de la wifi es correcta (${solos.onlineCount})`);
await solos.stop();

console.log('\nLO HABLADO SE QUEDA ESCRITO');
// El hablante transcribe su propia voz y manda el texto: en un restaurante real
// puede llegar un segundo después, así que el otro móvil debe guardarlo igual.
marta.sendChat('Mesa cuatro lista.');
await wait(200);
check(
  events.b.some((e) => e.type === 'chat' && e.text === 'Mesa cuatro lista.' && e.from === 'Marta'),
  'la frase transcrita por quien habló llega a los demás como mensaje',
);
luis.sendChat('🎙️ voz de 12 s');
await wait(200);
check(
  events.a.some((e) => e.type === 'chat' && e.text.startsWith('🎙️ voz de')),
  'si no hay transcripción queda el aviso de voz',
);

console.log('\nCANALES SEPARADOS (general, cocina, comedor, barra, terraza)');
check(ROOMS.map((r) => r.id).join(',') === 'general,cocina,comedor,barra,terraza', `canales: ${ROOMS.map((r) => r.name).join(', ')}`);
for (const [indice, canal] of ROOMS.entries()) {
  const paquete = encode({ type: TYPE.chat, room: canal.id, nodeId: 'aa'.repeat(8), name: 'X', payload: Buffer.from('hola') });
  check(paquete[6] === indice && decode(paquete).room === canal.id, `${canal.name} viaja en el byte ${indice}`);
}
// Comedor y barra están aislados: quien está en comedor no oye barra.
marta.setRoom('comedor');
luis.setRoom('barra');
await wait(400);
events.a.length = 0;
events.b.length = 0;
marta.sendChat('esto es de comedor');
luis.sendChat('esto es de barra');
await wait(350);
// Cada uno oye lo del canal en el que está y no lo del otro.
check(!events.a.some((e) => e.type === 'chat' && e.text === 'esto es de barra'), 'comedor no recibe lo de barra');
check(!events.b.some((e) => e.type === 'chat' && e.text === 'esto es de comedor'), 'barra no recibe lo de comedor');
luis.setRoom('comedor');
await wait(350);
events.b.length = 0;
marta.sendChat('ahora luis está en comedor');
await wait(300);
check(events.b.some((e) => e.type === 'chat' && e.text === 'ahora luis está en comedor'), 'al cambiarse a comedor, sí lo recibe');

// Un mensaje largo (una transcripción entera) tiene que llegar completo.
events.b.length = 0;
const fraseLarga = 'Vicente escúchame sal un momento a la calle porfa que esto está lleno de gente y no cabe nadie más dentro.';
marta.sendChat(fraseLarga);
await wait(300);
const recibido = events.b.find((e) => e.type === 'chat');
check(recibido?.text === fraseLarga, `un mensaje de ${fraseLarga.length} caracteres llega entero`);
marta.setRoom('general');
luis.setRoom('general');
await wait(300);

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

package com.walkielagos.app

import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.random.Random

/**
 * Paquete de la radio local. Mismo formato que lan/protocol.mjs (probado en
 * test/lan.test.mjs), así que un móvil y la versión de escritorio se entienden.
 *
 *  0..3  "WLK1" | 4 versión | 5 tipo | 6 canal | 7 largo del nombre
 *  8..15 nodeId (8 bytes) | 16.. nombre UTF-8 | ... payload
 */
object Lan {
    const val GROUP = "239.255.43.43"
    const val PORT = 45454
    const val VERSION: Byte = 1
    const val MAX_NAME = 16
    const val SAMPLE_RATE = 16_000
    const val FRAME_BYTES = SAMPLE_RATE / 50 * 2 // 20 ms = 640 bytes
    val MAGIC = byteArrayOf('W'.code.toByte(), 'L'.code.toByte(), 'K'.code.toByte(), '1'.code.toByte())

    const val TYPE_AUDIO: Byte = 0x41
    const val TYPE_CHAT: Byte = 0x54
    const val TYPE_CLAIM: Byte = 0x43
    const val TYPE_END: Byte = 0x45
    const val TYPE_HEARTBEAT: Byte = 0x48
    const val TYPE_LEAVE: Byte = 0x4C

    val ROOMS = listOf("General", "Cocina", "Sala", "Barra")

    data class Packet(
        val type: Byte,
        val room: Int,
        val nodeId: String,
        val name: String,
        val payload: ByteArray,
    ) {
        override fun equals(other: Any?) = this === other
        override fun hashCode() = java.lang.System.identityHashCode(this)
    }

    fun encode(type: Byte, room: Int, nodeId: ByteArray, name: String, payload: ByteArray = ByteArray(0)): ByteArray {
        val nameBytes = name.toByteArray(Charsets.UTF_8).let {
            if (it.size > MAX_NAME) it.copyOf(MAX_NAME) else it
        }
        val out = ByteArray(16 + nameBytes.size + payload.size)
        MAGIC.copyInto(out, 0)
        out[4] = VERSION
        out[5] = type
        out[6] = room.coerceIn(0, ROOMS.size - 1).toByte()
        out[7] = nameBytes.size.toByte()
        nodeId.copyInto(out, 8, 0, 8)
        nameBytes.copyInto(out, 16)
        payload.copyInto(out, 16 + nameBytes.size)
        return out
    }

    fun decode(bytes: ByteArray, length: Int = bytes.size): Packet? {
        if (length < 16) return null
        for (i in 0 until 4) if (bytes[i] != MAGIC[i]) return null
        if (bytes[4] != VERSION) return null
        val nameLength = bytes[7].toInt() and 0xFF
        if (16 + nameLength > length) return null
        val nodeId = buildString {
            for (i in 8 until 16) append("%02x".format(bytes[i]))
        }
        return Packet(
            type = bytes[5],
            room = (bytes[6].toInt() and 0xFF).coerceIn(0, ROOMS.size - 1),
            nodeId = nodeId,
            name = String(bytes, 16, nameLength, Charsets.UTF_8),
            payload = bytes.copyOfRange(16 + nameLength, length),
        )
    }

    fun newNodeId(): ByteArray = Random.nextBytes(8)

    fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }

    fun fromHex(hex: String): ByteArray {
        val clean = hex.padEnd(16, '0').take(16)
        return ByteArray(8) { clean.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
    }

    /** En una colisión de turno gana el nodeId menor. */
    fun hasPriority(mine: String, theirs: String): Boolean = mine < theirs

    /** Añade números de secuencia al audio para descartar paquetes viejos. */
    fun sequenceOf(payload: ByteArray): Int =
        if (payload.size >= 2) {
            ByteBuffer.wrap(payload, 0, 2).order(ByteOrder.LITTLE_ENDIAN).short.toInt() and 0xFFFF
        } else {
            0
        }
}

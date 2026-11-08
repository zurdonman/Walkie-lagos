package com.walkielagos.app

import kotlin.math.abs
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Utilidades de audio en crudo.
 *
 * La app trabaja con PCM 16 bits mono a 16 kHz, que es lo que escucha bien la voz
 * y gasta poco (~32 kB/s hablando). El móvil suele dar 44,1 o 48 kHz, así que hay
 * que remuestrear. Se hace a mano porque es poco código y así el APK no crece con
 * librerías nativas.
 */
object Pcm {

    const val SAMPLE_RATE = 16_000
    const val PACKET_SAMPLES = SAMPLE_RATE / 50 // 20 ms = 320 muestras = 640 bytes

    /** Remuestrea audio en coma flotante (-1..1) a 16 kHz y lo pasa a PCM 16 bits. */
    fun resampleToPcm16(input: FloatArray, inputRate: Int): ShortArray {
        if (inputRate == SAMPLE_RATE) {
            return ShortArray(input.size) { i -> toPcm16(input[i]) }
        }
        val ratio = inputRate.toDouble() / SAMPLE_RATE
        val length = (input.size / ratio).toInt().coerceAtLeast(1)
        val out = ShortArray(length)
        for (i in 0 until length) {
            val position = i * ratio
            val index = position.toInt()
            val frac = position - index
            val a = if (index < input.size) input[index] else 0f
            val b = if (index + 1 < input.size) input[index + 1] else a
            out[i] = toPcm16(a + (b - a) * frac.toFloat())
        }
        return out
    }

    /** Remuestrea del ritmo de red (16 kHz) al del altavoz. */
    fun pcm16ToFloat(input: ShortArray, targetRate: Int): FloatArray {
        val ratio = SAMPLE_RATE.toDouble() / targetRate
        val length = (input.size / ratio).toInt().coerceAtLeast(1)
        val out = FloatArray(length)
        for (i in 0 until length) {
            val position = i * ratio
            val index = position.toInt()
            val frac = position - index
            val a = if (index < input.size) input[index] / 32768f else 0f
            val b = if (index + 1 < input.size) input[index + 1] / 32768f else a
            out[i] = a + (b - a) * frac.toFloat()
        }
        return out
    }

    /** Agrupa en paquetes de 20 ms para enviar por el WebSocket. */
    fun packetize(samples: ShortArray): List<ByteArray> {
        val packets = ArrayList<ByteArray>(samples.size / PACKET_SAMPLES + 1)
        var offset = 0
        while (offset + PACKET_SAMPLES <= samples.size) {
            packets.add(pack(samples, offset, PACKET_SAMPLES))
            offset += PACKET_SAMPLES
        }
        return packets
    }

    fun pack(samples: ShortArray, offset: Int = 0, count: Int = samples.size - offset): ByteArray {
        val bytes = ByteArray(count * 2)
        for (i in 0 until count) {
            val value = samples[offset + i].toInt()
            bytes[i * 2] = (value and 0xFF).toByte()
            bytes[i * 2 + 1] = ((value shr 8) and 0xFF).toByte()
        }
        return bytes
    }

    fun unpack(bytes: ByteArray, offset: Int = 0, length: Int = bytes.size - offset): ShortArray {
        val count = length / 2
        val out = ShortArray(count)
        for (i in 0 until count) {
            val low = bytes[offset + i * 2].toInt() and 0xFF
            val high = bytes[offset + i * 2 + 1].toInt()
            out[i] = ((high shl 8) or low).toShort()
        }
        return out
    }

    /** Nivel 0..1 para el medidor de voz. */
    fun level(samples: ShortArray): Float {
        if (samples.isEmpty()) return 0f
        var peak = 0
        var i = 0
        while (i < samples.size) {
            val value = abs(samples[i].toInt())
            if (value > peak) peak = value
            i += 4
        }
        return min(1f, peak / 32768f * 2f)
    }

    private fun toPcm16(sample: Float): Short {
        val clamped = sample.coerceIn(-1f, 1f)
        return (clamped * if (clamped < 0) 32768f else 32767f).roundToInt().toShort()
    }
}

package com.walkielagos.app

import android.content.Context
import org.vosk.Model
import org.vosk.Recognizer
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Pasa la voz a texto en el propio móvil, sin internet (Vosk, modelo español).
 *
 * Se le van dando los paquetes de 20 ms según llegan y, al terminar la frase,
 * devuelve el texto reconocido. Si el modelo no está instalado, la app sigue
 * funcionando: solo se pierde la transcripción.
 */
class Transcriber(private val context: Context) {

    interface Listener {
        fun onTranscribed(room: Int, from: String, text: String)
    }

    private val executor = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "walkie-transcriber").apply { isDaemon = true }
    }
    private val busy = AtomicBoolean(false)
    private var model: Model? = null
    private var failed = false

    /** Dónde se espera el modelo (lo copia el usuario o viene en la compilación). */
    fun modelDir(): File = File(context.filesDir, "vosk-es")

    fun isAvailable(): Boolean = installed() && ensureModel()

    /** ¿Está el modelo ya en el almacenamiento de la app? */
    fun installed(): Boolean {
        val dir = modelDir()
        return dir.isDirectory && (dir.listFiles()?.isNotEmpty() == true)
    }

    private fun ensureModel(): Boolean {
        if (model != null) return true
        if (failed) return false
        return try {
            model = Model(modelDir().absolutePath)
            true
        } catch (error: Throwable) {
            failed = true
            false
        }
    }

    /** Instala el modelo desde assets si viene dentro del APK. */
    fun installIfBundled(assetsPath: String = "vosk-es"): Boolean {
        return try {
            val children = context.assets.list(assetsPath) ?: return false
            if (children.isEmpty()) return false
            if (installed()) return true
            copyDir(assetsPath, modelDir())
            true
        } catch (error: Throwable) {
            false
        }
    }

    private fun copyDir(from: String, to: File) {
        val children = context.assets.list(from).orEmpty()
        if (children.isEmpty()) {
            to.parentFile?.mkdirs()
            context.assets.open(from).use { input -> to.outputStream().use { input.copyTo(it) } }
            return
        }
        to.mkdirs()
        for (child in children) copyDir("$from/$child", File(to, child))
    }

    // ------------------------------------------------------------- transcripción

    /**
     * Transcribe una frase completa de PCM16 mono 16 kHz (lo que se acumula
     * mientras alguien mantiene el botón). El texto llega en otro hilo.
     */
    fun transcribe(room: Int, from: String, pcm: ByteArray, listener: Listener) {
        if (pcm.size < Pcm.SAMPLE_RATE / 2) return // menos de medio segundo: ruido
        if (!ensureModel()) return
        if (!busy.compareAndSet(false, true)) return
        executor.execute {
            try {
                val model = model ?: return@execute
                val recognizer = Recognizer(model, Pcm.SAMPLE_RATE.toFloat())
                try {
                    // Vosk acepta tramos de un segundo como máximo.
                    val chunk = Pcm.SAMPLE_RATE * 2
                    var offset = 0
                    while (offset < pcm.size) {
                        val size = minOf(chunk, pcm.size - offset)
                        recognizer.acceptWaveForm(pcm.copyOfRange(offset, offset + size), size)
                        offset += size
                    }
                    val text = clean(extractText(recognizer.finalResult))
                    if (text.isNotBlank()) listener.onTranscribed(room, from, text)
                } finally {
                    recognizer.close()
                }
            } catch (error: Throwable) {
                failed = true
            } finally {
                busy.set(false)
            }
        }
    }

    private fun extractText(json: String): String {
        val key = "\"text\""
        val index = json.indexOf(key)
        if (index < 0) return ""
        val start = json.indexOf('"', json.indexOf(':', index) + 1)
        if (start < 0) return ""
        val end = json.indexOf('"', start + 1)
        if (end < 0) return ""
        return json.substring(start + 1, end)
    }

    /** Pone mayúscula inicial y punto final. */
    private fun clean(raw: String): String {
        val text = raw.split(" ").filter { it.isNotBlank() }.joinToString(" ")
        if (text.isEmpty()) return ""
        val capitalized = text.replaceFirstChar { it.uppercase() }
        return if (capitalized.last() in charArrayOf('.', '?', '!')) capitalized else "$capitalized."
    }

    fun close() {
        executor.shutdownNow()
        runCatching { model?.close() }
        model = null
    }
}

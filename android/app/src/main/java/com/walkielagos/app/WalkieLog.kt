package com.walkielagos.app

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Environment
import java.io.File
import java.io.PrintWriter
import java.io.StringWriter
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Deja por escrito todo lo que hace la app y, sobre todo, cualquier fallo.
 *
 * Escribe dos archivos (si Android deja, en la carpeta pública de Descargas):
 *   Download/log walkie/walkie-log.txt   → lo que va pasando
 *   Download/log walkie/walkie-crash.txt → el fallo completo, si la app se cierra
 *
 * Si la app no tiene permiso para escribir ahí, guarda lo mismo en su carpeta
 * privada y ofrece compartir el archivo desde la propia pantalla.
 */
object WalkieLog {

    private const val DIR_NAME = "log walkie"
    private const val LOG_NAME = "walkie-log.txt"
    private const val CRASH_NAME = "walkie-crash.txt"
    private const val MAX_BYTES = 512 * 1024

    private val stamp = SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", Locale.US)

    @Volatile
    private var context: Context? = null

    /** Carpeta pública de Descargas (la que se ve con el explorador de archivos). */
    fun downloadDir(): File = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), DIR_NAME)

    /** Carpeta privada, siempre disponible. */
    fun privateDir(ctx: Context): File = File(ctx.getExternalFilesDir(null) ?: ctx.filesDir, "logs")

    /**
     * Arranca el registro: instala el cazador de fallos, escribe la cabecera con
     * los datos del móvil y devuelve dónde se está guardando.
     */
    fun start(ctx: Context): File {
        context = ctx.applicationContext
        val dir = privateDir(ctx)
        dir.mkdirs()
        // Se intenta también la carpeta visible; si el sistema no deja, no pasa nada.
        runCatching { downloadDir().mkdirs() }

        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, error ->
            try {
                writeCrash(ctx, thread, error)
            } catch (ignored: Throwable) {
            }
            previous?.uncaughtException(thread, error)
        }

        val version = runCatching {
            val info = ctx.packageManager.getPackageInfo(ctx.packageName, 0)
            "${info.versionName} (${info.longVersionCode})"
        }.getOrDefault("?")
        val bundle = Bundle2.debuggable(ctx)
        i("=== Walkie Lagos ${version} · paquete ${ctx.packageName} · build ${if (bundle) "DEBUG" else "NORMAL"} ===")
        i(
            "Móvil: ${Build.MANUFACTURER} ${Build.MODEL} · Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT}) · " +
                "${Build.SUPPORTED_ABIS.joinToString(", ")}"
        )
        i("Carpeta visible: ${downloadDir().absolutePath}")
        i("Carpeta privada: ${dir.absolutePath}")
        i("Permiso de escritura en Descargas: ${runCatching { downloadDir().canWrite() }.getOrDefault(false)}")
        return dir
    }

    fun i(message: String) = line("INFO", message, null)

    fun w(message: String, error: Throwable? = null) = line("AVISO", message, error)

    fun e(message: String, error: Throwable? = null) = line("ERROR", message, error)

    private fun line(level: String, message: String, error: Throwable?) {
        val text = buildString {
            append(stamp.format(Date()))
            append(' ')
            append(level)
            append(' ')
            append(message)
            if (error != null) {
                append(" · ")
                append(error.javaClass.simpleName)
                append(": ")
                append(error.message)
            }
            append('\n')
        }
        val ctx = context ?: return
        runCatching {
            appendTo(File(privateDir(ctx), LOG_NAME), text)
            appendTo(File(downloadDir(), LOG_NAME), text)
        }
    }

    private fun appendTo(file: File, text: String) {
        runCatching {
            file.parentFile?.mkdirs()
            if (file.exists() && file.length() > MAX_BYTES) file.delete()
            file.appendText(text)
        }
    }

    private fun writeCrash(ctx: Context, thread: Thread, error: Throwable) {
        val writer = StringWriter()
        PrintWriter(writer).use { error.printStackTrace(it) }
        val report = buildString {
            append("=== FALLO DE WALKIE LAGOS ===\n")
            append("Cuándo: ${stamp.format(Date())}\n")
            append("Hilo: ${thread.name}\n")
            append(
                "Móvil: ${Build.MANUFACTURER} ${Build.MODEL} · Android ${Build.VERSION.RELEASE} " +
                    "(API ${Build.VERSION.SDK_INT})\n"
            )
            append("Versión: ${runCatching {
                val info = ctx.packageManager.getPackageInfo(ctx.packageName, 0)
                "${info.versionName} (${info.longVersionCode})"
            }.getOrDefault("?")}\n")
            append("Build: ${if (Bundle2.debuggable(ctx)) "DEBUG" else "NORMAL"}\n")
            append("ABIs: ${Build.SUPPORTED_ABIS.joinToString(", ")}\n\n")
            append("--- Pila del fallo ---\n")
            append(writer.toString())
            append("\n--- Últimas líneas del registro ---\n")
            append(runCatching {
                File(privateDir(ctx), LOG_NAME).readLines().takeLast(60).joinToString("\n")
            }.getOrDefault("(sin registro)"))
            append("\n")
        }
        for (dir in listOf(downloadDir(), privateDir(ctx))) {
            runCatching {
                dir.mkdirs()
                File(dir, CRASH_NAME).writeText(report)
            }
        }
        appendTo(File(privateDir(ctx), LOG_NAME), "SE HA CERRADO LA APP; informe guardado\n")
    }

    /**
     * Deja una copia del registro (y del informe de fallo) donde la app pueda
     * enviarla sin problemas: su carpeta privada. Devuelve esa copia.
     */
    fun copyForSharing(ctx: Context): List<File> {
        val out = ArrayList<File>()
        val dir = privateDir(ctx).apply { mkdirs() }
        for (name in listOf(LOG_NAME, CRASH_NAME)) {
            for (from in listOf(File(downloadDir(), name), File(dir, name))) {
                if (from.exists()) {
                    val to = File(dir, name)
                    if (from.absolutePath != to.absolutePath) runCatching { from.copyTo(to, overwrite = true) }
                    out.add(to)
                    break
                }
            }
        }
        return out
    }

    /** Copia el registro en la carpeta de Descargas (por si solo estaba en la privada). */
    fun exportToDownloads(ctx: Context): Boolean = runCatching {
        val from = File(privateDir(ctx), LOG_NAME)
        if (!from.exists()) return false
        val to = File(downloadDir(), LOG_NAME)
        to.parentFile?.mkdirs()
        from.copyTo(to, overwrite = true)
        File(privateDir(ctx), CRASH_NAME).takeIf { it.exists() }?.copyTo(File(downloadDir(), CRASH_NAME), overwrite = true)
        true
    }.getOrDefault(false)
}

/** Pequeño atajo para saber si el APK es el de diagnóstico. */
internal object Bundle2 {
    fun debuggable(context: Context): Boolean =
        (context.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0
}

/** Comprueba que la app tiene el permiso de micrófono, sin lanzar excepciones. */
fun Context.hasMic(): Boolean =
    checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

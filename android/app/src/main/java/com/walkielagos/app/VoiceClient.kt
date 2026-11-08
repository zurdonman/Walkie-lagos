package com.walkielagos.app

import android.os.Handler
import android.os.Looper
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import java.util.concurrent.TimeUnit

/**
 * Conexión con el servidor del restaurante: entra al canal, pide el turno de
 * palabra, manda el audio y reparte lo que llega. La reconexión es automática.
 */
class VoiceClient(
    private val settings: Settings,
    private val listener: Listener,
) {
    interface Listener {
        fun onConnecting()
        fun onConnected()
        fun onDisconnected(reason: String)
        fun onEvent(event: Event)
        fun onLevel(level: Float)
        fun onPeerLevel(level: Float)
    }

    private val main = Handler(Looper.getMainLooper())
    private val http = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()

    private var socket: WebSocket? = null
    private var closedByUs = false
    private var attempts = 0
    private var retry: Runnable? = null

    @Volatile
    var talking: Boolean = false
        private set

    val isConnected: Boolean get() = socket != null

    fun connect() {
        closedByUs = false
        retry?.let { main.removeCallbacks(it) }
        main.post { listener.onConnecting() }

        val url = normalize(settings.server)
        if (url == null) {
            main.post { listener.onDisconnected("Dirección del servidor no válida") }
            return
        }
        Protocol.myName = settings.name
        val request = Request.Builder().url(url).build()
        socket = http.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                attempts = 0
                webSocket.send(Protocol.join(settings))
                main.post { listener.onConnected() }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val event = Protocol.parse(text, null) ?: return
                main.post { listener.onEvent(event) }
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                val short = Pcm.unpack(bytes.toByteArray())
                main.post {
                    listener.onPeerLevel(Pcm.level(short))
                    listener.onEvent(Event.Audio(bytes.toByteArray()))
                }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                socket = null
                talking = false
                if (closedByUs) return
                main.post {
                    listener.onDisconnected(t.message ?: "sin conexión")
                    scheduleRetry()
                }
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                socket = null
                talking = false
                if (closedByUs) return
                main.post {
                    listener.onDisconnected(reason.ifEmpty { "conexión cerrada" })
                    scheduleRetry()
                }
            }
        })
    }

    private fun scheduleRetry() {
        attempts += 1
        val delay = minOf(15_000L, 800L * (1 shl minOf(attempts, 4)))
        val runnable = Runnable { connect() }
        retry = runnable
        main.postDelayed(runnable, delay)
    }

    fun requestTalk() {
        talking = true
        socket?.send(Protocol.talk(true))
    }

    fun releaseTalk() {
        if (!talking) return
        talking = false
        socket?.send(Protocol.talk(false))
    }

    /** El servidor nos ha dado el turno: a partir de aquí se manda audio. */
    fun sendAudio(bytes: ByteArray, level: Float) {
        if (!talking) return
        socket?.send(bytes.toByteString())
        listener.onLevel(level)
    }

    fun sendChat(text: String): Boolean = socket?.send(Protocol.chat(text)) ?: false

    fun switchRoom(room: String) = socket?.send(Protocol.switchRoom(room))

    fun ping() {
        socket?.send(Protocol.ping())
    }

    fun disconnect() {
        closedByUs = true
        retry?.let { main.removeCallbacks(it) }
        retry = null
        talking = false
        socket?.close(1000, "hasta luego")
        socket = null
    }

    companion object {
        /** Acepta "192.168.1.50", "192.168.1.50:3000" o una URL completa con ws:// o wss://. */
        fun normalize(raw: String): String? {
            var value = raw.trim()
            if (value.isEmpty()) return null
            if (!value.startsWith("ws://") && !value.startsWith("wss://")) {
                val secure = value.startsWith("https://")
                value = value.removePrefix("http://").removePrefix("https://").trimEnd('/')
                value = if (value.contains(':')) value else "$value:3000"
                value = (if (secure) "wss://" else "ws://") + value
            } else if (!value.removePrefix("ws://").removePrefix("wss://").contains(':')) {
                value = value.trimEnd('/') + ":3000"
            }
            val hostPart = value.removePrefix("ws://").removePrefix("wss://").substringBefore("/")
            val host = hostPart.substringBefore(':')
            if (host.isEmpty() || hostPart.any { it.isWhitespace() }) return null
            return "$value/ws"
        }
    }
}

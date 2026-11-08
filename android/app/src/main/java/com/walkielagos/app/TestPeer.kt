package com.walkielagos.app

import android.os.Handler
import android.os.Looper

/**
 * Compañero de mentira para el **modo prueba**.
 *
 * Sirve para usar la app sin servidor, sin wifi y sin nadie más: contesta en el
 * canal, manda mensajes y "habla" para que se vea cómo queda el chat. Todo pasa
 * por las mismas pantallas y el mismo historial que la app de verdad; lo único
 * que no hay es audio real ni otros móviles.
 */
class TestPeer(private val responder: (Event) -> Unit) {

    companion object {
        const val NAME = "Compañero (prueba)"
        const val ROOM = "Prueba"
        private val FRASES = listOf(
            "¿Me oyes bien? Esto es una prueba.",
            "Mesa cuatro, dos cañas y una ración de bravas.",
            "Que salga alguien a la barra, por favor.",
            "Voy para la cocina, aviso cuando llegue.",
            "¿Queda pan? Que se acaba en la barra.",
        )
        private val RESPUESTAS = listOf(
            "Recibido, jefe.",
            "Vale, ahora voy.",
            "Perfecto, yo me encargo.",
            "Eso está hecho.",
            "Oído, sin problema.",
        )
    }

    private val main = Handler(Looper.getMainLooper())
    private var index = 0
    private var started = false
    private var room = ROOM

    /** Arranca el compañero: saluda en el canal y luego contesta solo. */
    fun start() {
        if (started) return
        started = true
        main.postDelayed({ welcome() }, 600)
        main.postDelayed({ habla(FRASES[0]) }, 3500)
    }

    fun stop() {
        started = false
        main.removeCallbacksAndMessages(null)
    }

    fun setRoom(nombre: String) {
        room = nombre
        main.postDelayed({
            responder(Event.System("(prueba) $NAME también está en $nombre", System.currentTimeMillis()))
        }, 300)
    }

    private fun welcome() {
        if (!started) return
        responder(
            Event.System(
                "MODO PRUEBA: no hace falta servidor ni wifi. $NAME está aquí para que veas " +
                    "el chat, la voz convertida en texto y los canales.",
                System.currentTimeMillis(),
            )
        )
        responder(Event.PeerCount(2))
    }

    /** Se pulsa para hablar: el compañero escucha y contesta a lo que he dicho. */
    fun onMeHablando() {
        if (!started) return
        val frase = siguienteFrase()
        main.postDelayed({ habla(frase) }, 900)
    }

    /** Lo que contesta cuando yo hablo o escribo. */
    fun onMyMessage(text: String) {
        if (!started) return
        main.postDelayed({
            val respuesta = if (text.contains("?")) RESPUESTAS.random() else "Entendido: «${text.take(40)}»"
            responder(Event.Chat(ChatEntry(NAME, respuesta, System.currentTimeMillis(), false)))
        }, 1200)
    }

    /** El compañero "habla": primero se anuncia y luego deja el texto. */
    fun habla(frase: String) {
        if (!started) return
        responder(Event.TalkStart(NAME))
        main.postDelayed({
            if (!started) return@postDelayed
            responder(Event.Chat(ChatEntry(NAME, frase, System.currentTimeMillis(), false)))
            responder(Event.TalkEnd(NAME))
        }, 1400)
    }

    /** Frase distinta cada vez, para que la prueba no sea siempre la misma. */
    fun siguienteFrase(): String {
        val frase = FRASES[index % FRASES.size]
        index += 1
        return frase
    }
}

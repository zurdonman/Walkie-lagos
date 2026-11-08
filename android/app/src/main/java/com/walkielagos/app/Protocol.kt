package com.walkielagos.app

import org.json.JSONArray
import org.json.JSONObject

/** Ajustes que escribe el usuario en la pantalla de entrada. */
data class Settings(
    val server: String,
    val name: String,
    val pin: String,
    val room: String,
)

/** Quién está en el canal. */
data class Peer(
    val id: String,
    val name: String,
    val talking: Boolean,
    val isMe: Boolean,
)

data class ChatEntry(
    val from: String?,
    val text: String,
    val ts: Long,
    val mine: Boolean,
)

/** Lo que el servidor puede contarnos. */
sealed interface Event {
    data class Welcome(val room: String, val maxSeconds: Int, val peers: List<Peer>, val history: List<ChatEntry>) : Event
    data class Rooms(val names: List<String>) : Event
    data class Roster(val peers: List<Peer>) : Event
    data class Presence(val online: Int) : Event
    data class TalkAccept(val maxSeconds: Int) : Event
    data class TalkDeny(val by: String) : Event
    data class TalkStart(val from: String) : Event
    data class TalkEnd(val from: String) : Event
    data class Chat(val entry: ChatEntry) : Event
    data class System(val text: String, val ts: Long) : Event
    data class Failure(val message: String) : Event
    data object Connected : Event
    data class Disconnected(val reason: String) : Event
    /** Un trozo de voz del compañero. */
    data class Audio(val bytes: ByteArray) : Event {
        override fun equals(other: Any?) = this === other
        override fun hashCode() = System.identityHashCode(this)
    }
}

/**
 * Lee las respuestas del servidor. Los mensajes JSON son los mismos que usa la
 * versión web, así que los dos clientes pueden convivir en el mismo canal.
 */
object Protocol {

    fun join(settings: Settings): String = JSONObject().apply {
        put("type", "join")
        put("name", settings.name)
        put("pin", settings.pin)
        put("room", settings.room)
    }.toString()

    fun talk(on: Boolean): String = JSONObject().apply {
        put("type", "talk")
        put("on", on)
    }.toString()

    fun chat(text: String): String = JSONObject().apply {
        put("type", "chat")
        put("text", text)
    }.toString()

    fun switchRoom(room: String): String = JSONObject().apply {
        put("type", "switch")
        put("room", room)
    }.toString()

    fun ping(): String = JSONObject().put("type", "ping").toString()

    fun parse(message: String, myId: String? = null): Event? {
        val json = runCatching { JSONObject(message) }.getOrNull() ?: return null
        return when (json.optString("type")) {
            "welcome" -> {
                val you = json.optJSONObject("you")
                val id = you?.optString("id")
                val maxSeconds = json.optInt("maxTalkSeconds", 45)
                val roomId = you?.optString("room").orEmpty()
                val roomName = json.optJSONArray("rooms")
                    ?.let { rooms -> (0 until rooms.length()).mapNotNull { rooms.optJSONObject(it) } }
                    ?.firstOrNull { it.optString("id") == roomId }
                    ?.optString("name")
                    .orEmpty()
                Event.Welcome(
                    room = roomName.ifEmpty { roomId },
                    maxSeconds = maxSeconds,
                    peers = peers(json.optJSONArray("users"), id),
                    history = history(json.optJSONArray("history")),
                )
            }
            "rooms" -> Event.Rooms(
                json.optJSONArray("rooms")
                    ?.let { rooms -> (0 until rooms.length()).mapNotNull { rooms.optJSONObject(it)?.optString("name") } }
                    .orEmpty()
            )
            "roster" -> Event.Roster(peers(json.optJSONArray("users"), myId))
            "presence" -> Event.Presence(json.optInt("online"))
            "talkAccept" -> Event.TalkAccept(json.optInt("maxSeconds", 45))
            "talkDeny" -> Event.TalkDeny(json.optString("by", "Alguien"))
            "talkStart" -> Event.TalkStart(json.optString("from"))
            "talkEnd" -> Event.TalkEnd(json.optString("from"))
            "chat" -> Event.Chat(
                ChatEntry(
                    from = json.optString("from"),
                    text = json.optString("text"),
                    ts = json.optLong("ts", System.currentTimeMillis()),
                    mine = myId != null && json.optString("from") == myName,
                )
            )
            "system" -> Event.System(json.optString("text"), json.optLong("ts", System.currentTimeMillis()))
            "error" -> Event.Failure(json.optString("message", "Error"))
            else -> null
        }
    }

    /** El nombre propio, para marcar los mensajes en el chat. */
    var myName: String = ""

    private fun peers(array: JSONArray?, myId: String?): List<Peer> {
        if (array == null) return emptyList()
        return (0 until array.length()).mapNotNull { index ->
            val peer = array.optJSONObject(index) ?: return@mapNotNull null
            val id = peer.optString("id")
            Peer(
                id = id,
                name = peer.optString("name"),
                talking = peer.optBoolean("talking"),
                isMe = id == myId,
            )
        }
    }

    private fun history(array: JSONArray?): List<ChatEntry> {
        if (array == null) return emptyList()
        return (0 until array.length()).mapNotNull { index ->
            val entry = array.optJSONObject(index) ?: return@mapNotNull null
            ChatEntry(
                from = entry.optString("from"),
                text = entry.optString("text"),
                ts = entry.optLong("ts", System.currentTimeMillis()),
                mine = entry.optString("from") == myName,
            )
        }
    }
}

package com.walkielagos.app

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper

/**
 * Historial de cada móvil: los mensajes de texto y las voces transcritas se
 * quedan aquí, en el propio dispositivo. No hay servidor que los guarde en el
 * modo wifi y tampoco hace falta: cada uno tiene su copia.
 */
class HistoryStore(context: Context) : SQLiteOpenHelper(context, FILE, null, 1) {

    companion object {
        private const val FILE = "walkie.db"
        private const val MAX_PER_ROOM = 500
    }

    data class Entry(
        val id: Long,
        val room: String,
        val from: String,
        val text: String,
        val mine: Boolean,
        val at: Long,
    )

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            """
            CREATE TABLE messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                room TEXT NOT NULL,
                sender TEXT NOT NULL,
                text TEXT NOT NULL,
                mine INTEGER NOT NULL,
                at INTEGER NOT NULL
            )
            """.trimIndent()
        )
        db.execSQL("CREATE INDEX idx_room_at ON messages(room, at)")
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit

    fun add(room: String, from: String, text: String, mine: Boolean, at: Long = System.currentTimeMillis()): Long {
        if (text.isBlank()) return -1
        val values = ContentValues().apply {
            put("room", room)
            put("sender", from)
            put("text", text)
            put("mine", if (mine) 1 else 0)
            put("at", at)
        }
        val id = writableDatabase.insert("messages", null, values)
        trim(room)
        return id
    }

    /** Últimos mensajes del canal, del más viejo al más nuevo. */
    fun recent(room: String, limit: Int = 100): List<Entry> {
        val out = ArrayList<Entry>()
        readableDatabase.rawQuery(
            "SELECT id, room, sender, text, mine, at FROM messages WHERE room = ? ORDER BY at DESC, id DESC LIMIT ?",
            arrayOf(room, limit.toString()),
        ).use { cursor ->
            while (cursor.moveToNext()) {
                out.add(
                    Entry(
                        id = cursor.getLong(0),
                        room = cursor.getString(1),
                        from = cursor.getString(2),
                        text = cursor.getString(3),
                        mine = cursor.getInt(4) == 1,
                        at = cursor.getLong(5),
                    )
                )
            }
        }
        out.reverse()
        return out
    }

    fun clearRoom(room: String) {
        writableDatabase.delete("messages", "room = ?", arrayOf(room))
    }

    /** No dejar crecer sin freno: se guardan los últimos 500 de cada canal. */
    private fun trim(room: String) {
        writableDatabase.execSQL(
            "DELETE FROM messages WHERE room = ? AND id NOT IN " +
                "(SELECT id FROM messages WHERE room = ? ORDER BY at DESC, id DESC LIMIT ?)",
            arrayOf(room, room, MAX_PER_ROOM),
        )
    }
}

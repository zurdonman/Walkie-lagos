package com.walkielagos.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.os.Build
import android.os.IBinder
import android.os.SystemClock
import androidx.core.app.NotificationCompat
import java.util.concurrent.ConcurrentLinkedQueue

/**
 * Modo sin servidor: radio por wifi (multicast) con la app en segundo plano.
 * Igual que [VoiceService] pero sin nada al otro lado: los móviles se hablan
 * directamente a través del router.
 */
class LanService : Service(), LanRadio.Listener {

    companion object {
        /** Si no hay transcripción, al menos queda constancia de que hubo voz. */
        const val AUDIO_NOTE = "🎙️ voz de %d s"
        const val ACTION_START = "com.walkielagos.app.LAN_START"
        const val ACTION_STOP = "com.walkielagos.app.LAN_STOP"
        const val ACTION_TALK = "com.walkielagos.app.LAN_TALK"
        const val ACTION_ROOM = "com.walkielagos.app.LAN_ROOM"
        const val ACTION_FLOATING = "com.walkielagos.app.LAN_FLOATING"
        const val EXTRA_ON = "on"
        const val EXTRA_NAME = "name"
        const val EXTRA_ROOM = "room"
        const val EXTRA_NODE_ID = "nodeId"
        private const val CHANNEL_ID = "walkie"

        /** Botón flotante activado (se recuerda entre arranques). */
        const val KEY_FLOATING = "floating"

        @Volatile
        var listener: ((Event) -> Unit)? = null

        @Volatile
        var sender: LanRadio? = null
    }

    private var radio: LanRadio? = null
    private lateinit var store: HistoryStore
    private var transcriber: Transcriber? = null
    private val speakingPcm = java.io.ByteArrayOutputStream()
    private var record: AudioRecord? = null
    private var track: AudioTrack? = null
    private var recorderThread: Thread? = null
    private var playerThread: Thread? = null
    private var sequence = 0
    private var floating: FloatingButton? = null

    @Volatile
    private var speaking = false

    private val inbox = ConcurrentLinkedQueue<ByteArray>()
    private var nextPlayAtNanos = 0L

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        WalkieLog.i("Servicio wifi: arrancando")
        store = HistoryStore(this)
        WalkieLog.i("Servicio wifi: historial listo")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_TALK -> setTalking(intent?.getBooleanExtra(EXTRA_ON, false) ?: false)
            ACTION_ROOM -> {
                val room = intent?.getIntExtra(EXTRA_ROOM, 0) ?: 0
                currentRoom = room
                radio?.setRoom(room)
                updateFloatingLabel()
                listener?.invoke(Event.RoomChanged(room, Lan.ROOMS.getOrElse(room) { "General" }))
            }
            ACTION_FLOATING -> enableFloating(intent?.getBooleanExtra(EXTRA_ON, false) ?: false)
            ACTION_STOP -> {
                close()
                stopSelf()
            }
            null -> Unit
            else -> if (radio != null) {
                // Ya estaba escuchando (la pantalla se cerró y se volvió a abrir): se le
                // manda el estado para que sepa dónde está y a quién oye.
                listener?.invoke(Event.Status(radio?.status.orEmpty()))
                listener?.invoke(Event.PeerCount(radio?.peerCount ?: 1))
            } else {
                val name = intent?.getStringExtra(EXTRA_NAME).orEmpty().ifBlank { "Móvil" }
                val room = intent?.getIntExtra(EXTRA_ROOM, 0) ?: 0
                val nodeId = intent?.getStringExtra(EXTRA_NODE_ID)
                myName = name
                startForegroundNotification(Lan.ROOMS.getOrElse(room) { "General" })

                val created = LanRadio(
                    this,
                    if (nodeId.isNullOrBlank()) Lan.newNodeId() else Lan.fromHex(nodeId),
                    name,
                    room,
                    this,
                )
                radio = created
                sender = created
                currentRoom = room
                transcriber = Transcriber(this).also { it.installIfBundled() }
                WalkieLog.i("Servicio wifi: canal ${Lan.ROOMS.getOrElse(room) { "?" }}, nombre $name")
                startAudio()
                created.start()
                if (prefs.getBoolean(KEY_FLOATING, false)) enableFloating(true)
            }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        close()
        super.onDestroy()
    }

    private fun close() {
        sender = null
        transcriber?.close()
        transcriber = null
        setTalking(false)
        radio?.stop()
        radio = null
        floating?.hide()
        floating = null
        stopAudio()
        stopForeground(STOP_FOREGROUND_REMOVE)
    }

    private fun setTalking(on: Boolean) {
        if (on == speaking) return
        floating?.setTalking(on)
        updateFloatingLabel()
        speaking = on
        radio?.setTalking(on)
        if (on) {
            ownPcm.reset()
        } else {
            // Al soltar el botón, lo que he dicho se escribe y se manda a los demás
            // para que todos lo tengan en su historial.
            val pcm = ownPcm.toByteArray()
            ownPcm.reset()
            if (pcm.isNotEmpty()) transcribeAndBroadcast(pcm)
        }
    }

    private fun transcribeAndBroadcast(pcm: ByteArray) {
        val segundos = pcm.size / (Lan.SAMPLE_RATE * 2)
        val yo = myName.ifBlank { "Móvil" }
        WalkieLog.i("Wifi: he hablado $segundos s; se transcribe en este móvil")
        val engine = transcriber
        if (engine == null || !engine.isAvailable()) {
            noteVoz(segundos, "no hay transcripción disponible")
            return
        }
        engine.transcribe(
            currentRoom,
            yo,
            pcm,
            object : Transcriber.Listener {
                override fun onTranscribed(roomIndex: Int, speaker: String, text: String) {
                    val roomName = Lan.ROOMS.getOrElse(roomIndex) { "General" }
                    store.add(roomName, speaker, text, true)
                    listener?.invoke(Event.Chat(ChatEntry(speaker, text, System.currentTimeMillis(), true)))
                    radio?.sendChat(text)
                }
            },
        )
    }

    /** Si no hay texto, queda al menos el aviso de voz (aquí y en los demás móviles). */
    private fun noteVoz(segundos: Int, motivo: String) {
        val texto = AUDIO_NOTE.format(if (segundos < 1) 1 else segundos)
        WalkieLog.w("Wifi: lo hablado se queda sin transcribir ($motivo); se anota \"$texto\"")
        val roomName = Lan.ROOMS.getOrElse(currentRoom) { "General" }
        store.add(roomName, myName.ifBlank { "Móvil" }, texto, true)
        listener?.invoke(Event.Chat(ChatEntry(myName.ifBlank { "Móvil" }, texto, System.currentTimeMillis(), true)))
        radio?.sendChat(texto)
    }

    // -------------------------------------------------------- botón flotante

    private val prefs by lazy { getSharedPreferences(FloatingButton.PREFS, MODE_PRIVATE) }

    /** Pone o quita el botón que flota sobre otras apps. */
    fun enableFloating(on: Boolean): Boolean {
        prefs.edit().putBoolean(KEY_FLOATING, on).apply()
        if (!on) {
            floating?.hide()
            floating = null
            return true
        }
        if (floating != null) return true
        if (!FloatingButton.canShow(this)) {
            WalkieLog.w("Flotante: falta el permiso para mostrarlo sobre otras apps")
            listener?.invoke(Event.Failure(getString(R.string.float_need_permission)))
            return false
        }
        val button = FloatingButton(this)
        button.listener = object : FloatingButton.Listener {
            override fun onTalkStart() {
                if (radio?.talking == true) return
                setTalking(true)
            }

            override fun onTalkStop() = setTalking(false)

            override fun onOpenApp() {
                runCatching {
                    startActivity(
                        Intent(this@LanService, MainActivity::class.java)
                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
                    )
                }
            }
        }
        val ok = button.show()
        if (!ok) {
            listener?.invoke(Event.Failure(getString(R.string.float_need_permission)))
            return false
        }
        floating = button
        updateFloatingLabel()
        WalkieLog.i("Flotante: botón visible sobre otras apps")
        return true
    }

    private fun updateFloatingLabel() {
        val nombre = Lan.ROOMS.getOrElse(currentRoom) { "General" }
        val estado = if (radio?.talking == true) "hablando" else "$nombre"
        floating?.setLabel(estado)
    }

    // ------------------------------------------------------------ LanRadio.Listener

    override fun onAudio(data: ByteArray) {
        if (inbox.size > 50) inbox.clear()
        inbox.add(data)
        // Lo que se oye se guarda (los 2 bytes de secuencia fuera) para transcribir.
        val offset = if (data.size >= 2) 2 else 0
        if (currentSpeaker.isNotEmpty() && speakingPcm.size() < 60 * Lan.SAMPLE_RATE * 2) {
            speakingPcm.write(data, offset, data.size - offset)
        }
    }

    private var currentSpeaker = ""
    private var currentRoom = 0
    private var myName = ""
    private val ownPcm = java.io.ByteArrayOutputStream()

    override fun onPeerSpeaking(from: String) {
        currentSpeaker = from
        speakingPcm.reset()
        listener?.invoke(Event.TalkStart(from))
    }

    override fun onPeerSilent(from: String) {
        val pcm = speakingPcm.toByteArray()
        speakingPcm.reset()
        currentSpeaker = ""
        if (pcm.isNotEmpty()) transcribeAndSave(currentRoom, from, pcm)
        listener?.invoke(Event.TalkEnd(from))
    }

    /** La voz se convierte en texto en este móvil y se guarda en su historial. */
    private fun transcribeAndSave(room: Int, from: String, pcm: ByteArray) {
        val engine = transcriber
        if (engine == null || !engine.isAvailable()) {
            val texto = AUDIO_NOTE.format((pcm.size / (Lan.SAMPLE_RATE * 2)).coerceAtLeast(1))
            store.add(Lan.ROOMS.getOrElse(room) { "General" }, from, texto, false)
            listener?.invoke(Event.Chat(ChatEntry(from, texto, System.currentTimeMillis(), false)))
            return
        }
        engine.transcribe(
            room,
            from,
            pcm,
            object : Transcriber.Listener {
                override fun onTranscribed(roomIndex: Int, speaker: String, text: String) {
                    store.add(Lan.ROOMS.getOrElse(roomIndex) { "General" }, speaker, text, false)
                    listener?.invoke(Event.Chat(ChatEntry(speaker, text, System.currentTimeMillis(), false)))
                }
            },
        )
    }

    private var lastStatus = ""

    override fun onPeerCount(count: Int) {
        if (floating != null) updateFloatingLabel()
        val status = radio?.status.orEmpty()
        if (status.isNotBlank() && status != lastStatus) {
            lastStatus = status
            listener?.invoke(Event.Status(status))
        }
        listener?.invoke(Event.PeerCount(count))
    }

    override fun onChat(from: String, text: String) {
        WalkieLog.i("Wifi: mensaje de $from: ${text.take(80)}")
        store.add(Lan.ROOMS.getOrElse(currentRoom) { "General" }, from, text, false)
        listener?.invoke(Event.Chat(ChatEntry(from, text, System.currentTimeMillis(), false)))
    }

    override fun onPreempted(by: String) {
        listener?.invoke(Event.TalkDeny(by))
    }

    override fun onError(message: String) {
        WalkieLog.w("Radio wifi: $message")
        listener?.invoke(Event.Failure(message))
    }

    // -------------------------------------------------------------------- audio

    private fun startAudio() {
        if (record != null) return
        val minBuffer = AudioRecord.getMinBufferSize(
            Lan.SAMPLE_RATE,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
        ).coerceAtLeast(4096)

        record = AudioRecord(
            MediaRecorder.AudioSource.VOICE_COMMUNICATION,
            Lan.SAMPLE_RATE,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
            minBuffer * 2,
        )
        track = AudioTrack.Builder()
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build()
            )
            .setAudioFormat(
                AudioFormat.Builder()
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setSampleRate(Lan.SAMPLE_RATE)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                    .build()
            )
            .setTransferMode(AudioTrack.MODE_STREAM)
            .setBufferSizeInBytes(minBuffer * 2)
            .build()

        (getSystemService(Context.AUDIO_SERVICE) as AudioManager).mode = AudioManager.MODE_IN_COMMUNICATION
        record?.startRecording()
        track?.play()

        recorderThread = Thread {
            val buffer = ShortArray(Lan.FRAME_BYTES / 2)
            while (!Thread.currentThread().isInterrupted) {
                val mic = record ?: break
                val read = mic.read(buffer, 0, buffer.size)
                if (read > 0 && speaking && radio?.talking == true) {
                    val samples = buffer.copyOf(read)
                    val bytes = Pcm.pack(samples)
                    // Dos bytes de número de secuencia delante: así el receptor
                    // descarta paquetes repetidos o viejos sin reordenar audio.
                    sequence = (sequence + 1) and 0xFFFF
                    val payload = ByteArray(bytes.size + 2)
                    payload[0] = (sequence and 0xFF).toByte()
                    payload[1] = ((sequence shr 8) and 0xFF).toByte()
                    bytes.copyInto(payload, 2)
                    radio?.sendAudio(payload)
                    if (ownPcm.size() < 120 * Lan.SAMPLE_RATE * 2) ownPcm.write(bytes, 0, bytes.size)
                }
            }
        }.apply { isDaemon = true }.also { it.start() }

        playerThread = Thread {
            while (!Thread.currentThread().isInterrupted) {
                val payload = inbox.poll()
                if (payload == null) {
                    SystemClock.sleep(5)
                    continue
                }
                val audio = track ?: break
                // Los dos primeros bytes son la secuencia, no suenan.
                val offset = if (payload.size >= 2) 2 else 0
                val samples = Pcm.unpack(payload, offset, payload.size - offset)
                val now = System.nanoTime()
                if (nextPlayAtNanos < now + 20_000_000L || nextPlayAtNanos > now + 1_000_000_000L) {
                    nextPlayAtNanos = now + 120_000_000L
                }
                val wait = (nextPlayAtNanos - now) / 1_000_000L
                if (wait > 0) SystemClock.sleep(wait)
                audio.write(samples, 0, samples.size)
                nextPlayAtNanos += samples.size * 1_000_000_000L / Lan.SAMPLE_RATE
            }
        }.apply { isDaemon = true }.also { it.start() }
    }

    private fun stopAudio() {
        recorderThread?.interrupt()
        playerThread?.interrupt()
        recorderThread = null
        playerThread = null
        inbox.clear()
        runCatching { record?.stop() }
        runCatching { record?.release() }
        runCatching { track?.stop() }
        runCatching { track?.release() }
        record = null
        track = null
    }

    // ------------------------------------------------------------ notificación

    private fun startForegroundNotification(room: String): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = getSystemService(NotificationManager::class.java)
            if (manager.getNotificationChannel(CHANNEL_ID) == null) {
                manager.createNotificationChannel(
                    NotificationChannel(CHANNEL_ID, "Radio", NotificationManager.IMPORTANCE_LOW).apply {
                        description = "Mantiene la radio conectada"
                        setShowBadge(false)
                    }
                )
            }
        }
        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val notification: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_radio)
            .setContentTitle("Walkie Lagos · wifi")
            .setContentText(room)
            .setOngoing(true)
            .setSilent(true)
            .setContentIntent(open)
            .build()
        startForeground(1, notification)
        return true
    }
}

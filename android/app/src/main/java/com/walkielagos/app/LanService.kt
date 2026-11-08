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
        const val ACTION_START = "com.walkielagos.app.LAN_START"
        const val ACTION_STOP = "com.walkielagos.app.LAN_STOP"
        const val ACTION_TALK = "com.walkielagos.app.LAN_TALK"
        const val EXTRA_ON = "on"
        const val EXTRA_NAME = "name"
        const val EXTRA_ROOM = "room"
        const val EXTRA_NODE_ID = "nodeId"
        private const val CHANNEL_ID = "walkie"

        @Volatile
        var listener: ((Event) -> Unit)? = null

        @Volatile
        var sender: LanRadio? = null
    }

    private var radio: LanRadio? = null
    private var record: AudioRecord? = null
    private var track: AudioTrack? = null
    private var recorderThread: Thread? = null
    private var playerThread: Thread? = null
    private var sequence = 0

    @Volatile
    private var speaking = false

    private val inbox = ConcurrentLinkedQueue<ByteArray>()
    private var nextPlayAtNanos = 0L

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_TALK -> setTalking(intent?.getBooleanExtra(EXTRA_ON, false) ?: false)
            ACTION_STOP -> {
                close()
                stopSelf()
            }
            null -> Unit
            else -> if (radio == null) {
                val name = intent?.getStringExtra(EXTRA_NAME).orEmpty().ifBlank { "Móvil" }
                val room = intent?.getIntExtra(EXTRA_ROOM, 0) ?: 0
                val nodeId = intent?.getStringExtra(EXTRA_NODE_ID)
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
                startAudio()
                created.start()
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
        setTalking(false)
        radio?.stop()
        radio = null
        stopAudio()
        stopForeground(STOP_FOREGROUND_REMOVE)
    }

    private fun setTalking(on: Boolean) {
        if (on == speaking) return
        speaking = on
        radio?.setTalking(on)
    }

    // ------------------------------------------------------------ LanRadio.Listener

    override fun onAudio(data: ByteArray) {
        if (inbox.size > 50) inbox.clear()
        inbox.add(data)
    }

    override fun onPeerSpeaking(from: String) {
        listener?.invoke(Event.TalkStart(from))
    }

    override fun onPeerSilent(from: String) {
        listener?.invoke(Event.TalkEnd(from))
    }

    override fun onPeerCount(count: Int) {
        listener?.invoke(Event.Presence(count))
    }

    override fun onChat(from: String, text: String) {
        listener?.invoke(Event.Chat(ChatEntry(from, text, System.currentTimeMillis(), false)))
    }

    override fun onPreempted(by: String) {
        listener?.invoke(Event.TalkDeny(by))
    }

    override fun onError(message: String) {
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

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
 * El "walkie" de verdad: mantiene la conexión y el audio en primer plano, para
 * poder escuchar y hablar con la app en segundo plano o la pantalla apagada.
 * La actividad solo pinta lo que aquí ocurre.
 */
class VoiceService : Service(), VoiceClient.Listener {

    companion object {
        const val ACTION_START = "com.walkielagos.app.START"
        const val ACTION_STOP = "com.walkielagos.app.STOP"
        const val ACTION_TALK = "com.walkielagos.app.TALK"
        const val EXTRA_ON = "on"
        const val EXTRA_SERVER = "server"
        const val EXTRA_NAME = "name"
        const val EXTRA_PIN = "pin"
        const val EXTRA_ROOM = "room"
        private const val CHANNEL_ID = "walkie"
        private const val NOTIFICATION_ID = 1

        /** La actividad se engancha aquí para recibir los eventos. */
        @Volatile
        var listener: ((Event) -> Unit)? = null

        @Volatile
        var lastPeers: List<Peer> = emptyList()

        @Volatile
        var lastRoom: String = ""
    }

    private var client: VoiceClient? = null

    private var record: AudioRecord? = null
    private var track: AudioTrack? = null
    private var recorderThread: Thread? = null
    private var playerThread: Thread? = null

    @Volatile
    private var speaking = false

    private val inbox = ConcurrentLinkedQueue<ByteArray>()
    private var nextPlayAtNanos = 0L

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_TALK -> setTalking(intent?.getBooleanExtra(EXTRA_ON, false) ?: false)
            ACTION_STOP -> {
                disconnect()
                stopSelf()
            }
            null -> Unit
            else -> {
                val extra = intent
                val server = extra?.getStringExtra(EXTRA_SERVER).orEmpty()
                if (server.isNotBlank() && client == null && extra != null) {
                    startForeground(NOTIFICATION_ID, notification("Conectando…"))
                    val newSettings = Settings(
                        server = server,
                        name = extra.getStringExtra(EXTRA_NAME).orEmpty(),
                        pin = extra.getStringExtra(EXTRA_PIN).orEmpty(),
                        room = extra.getStringExtra(EXTRA_ROOM).orEmpty(),
                    )
                    startAudio()
                    client = VoiceClient(newSettings, this).also { it.connect() }
                    VoiceServiceBus.sender = { text -> client?.sendChat(text) ?: false }
                }
            }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        disconnect()
        super.onDestroy()
    }

    // ------------------------------------------------------------- conexión

    private fun disconnect() {
        VoiceServiceBus.sender = null
        setTalking(false)
        client?.disconnect()
        client = null
        stopAudio()
        stopForeground(STOP_FOREGROUND_REMOVE)
    }

    override fun onConnecting() = Unit

    override fun onConnected() {
        updateNotification("En línea")
    }

    override fun onDisconnected(reason: String) {
        updateNotification("Reconectando…")
        emit(Event.Disconnected(reason))
    }

    override fun onEvent(event: Event) {
        if (event is Event.Welcome) {
            lastRoom = event.room
            lastPeers = event.peers
            updateNotification(event.room)
        }
        if (event is Event.Roster) lastPeers = event.peers
        if (event is Event.TalkAccept) {
            if (!speaking) client?.releaseTalk() // nos lo dieron tarde
        }
        if (event is Event.TalkDeny) setTalking(false)
        if (event is Event.Audio) {
            play(event.bytes)
            return // el audio no necesita repintar la pantalla
        }
        listener?.invoke(event)
    }

    override fun onLevel(level: Float) {
        // El medidor se pinta en la actividad cuando recibe el evento de audio.
    }

    override fun onPeerLevel(level: Float) = Unit

    // ----------------------------------------------------------------- audio

    private fun setTalking(on: Boolean) {
        if (on == speaking) return
        speaking = on
        if (on) client?.requestTalk() else client?.releaseTalk()
    }

    private fun startAudio() {
        if (record != null) return
        val rate = 16_000
        val minBuffer = AudioRecord.getMinBufferSize(
            rate,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
        ).coerceAtLeast(4096)

        record = AudioRecord(
            MediaRecorder.AudioSource.VOICE_COMMUNICATION,
            rate,
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
                    .setSampleRate(rate)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                    .build()
            )
            .setTransferMode(AudioTrack.MODE_STREAM)
            .setBufferSizeInBytes(minBuffer * 2)
            .build()

        // Con esto nos oímos por el altavoz y el micrófono no se acopla.
        val audioManager = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        audioManager.mode = AudioManager.MODE_IN_COMMUNICATION

        record?.startRecording()
        track?.play()

        recorderThread = Thread {
            val buffer = ShortArray(1024)
            while (!Thread.currentThread().isInterrupted) {
                val mic = record ?: break
                val read = mic.read(buffer, 0, buffer.size)
                if (read > 0 && speaking && client?.talking == true) {
                    val samples = buffer.copyOf(read)
                    for (packet in Pcm.packetize(samples)) {
                        client?.sendAudio(packet, Pcm.level(samples))
                    }
                }
            }
        }.apply { isDaemon = true }.also { it.start() }

        playerThread = Thread {
            while (!Thread.currentThread().isInterrupted) {
                val bytes = inbox.poll()
                if (bytes == null) {
                    SystemClock.sleep(5)
                    continue
                }
                val samples = Pcm.unpack(bytes)
                val audio = track ?: break
                val now = System.nanoTime()
                // Colchón de 120 ms para que el wifi del local no corte las palabras.
                if (nextPlayAtNanos < now + 20_000_000L || nextPlayAtNanos > now + 1_000_000_000L) {
                    nextPlayAtNanos = now + 120_000_000L
                }
                val wait = (nextPlayAtNanos - now) / 1_000_000L
                if (wait > 0) SystemClock.sleep(wait)
                audio.write(samples, 0, samples.size)
                nextPlayAtNanos += samples.size * 1_000_000_000L / Pcm.SAMPLE_RATE
            }
        }.apply { isDaemon = true }.also { it.start() }
    }

    private fun play(bytes: ByteArray) {
        if (inbox.size > 50) inbox.clear() // nos hemos quedado atrás: mejor saltar que ir con retraso
        inbox.add(bytes)
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
        nextPlayAtNanos = 0
    }

    // ---------------------------------------------------------- notificación

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = getSystemService(NotificationManager::class.java)
            val channel = NotificationChannel(CHANNEL_ID, "Radio", NotificationManager.IMPORTANCE_LOW)
            channel.description = "Mantiene la radio conectada"
            channel.setShowBadge(false)
            manager.createNotificationChannel(channel)
        }
    }

    private fun notification(text: String): Notification {
        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_radio)
            .setContentTitle("Walkie Lagos")
            .setContentText(text)
            .setOngoing(true)
            .setSilent(true)
            .setContentIntent(open)
            .build()
    }

    private fun updateNotification(text: String) {
        val manager = getSystemService(NotificationManager::class.java)
        manager.notify(NOTIFICATION_ID, notification(text))
    }

    private fun emit(event: Event) {
        listener?.invoke(event)
    }
}

package com.walkielagos.app

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.MotionEvent
import android.view.View
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.walkielagos.app.databinding.ActivityMainBinding
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Una sola pantalla: servidor y nombre, canal, botón grande para hablar y chat.
 * Todo el audio y la conexión viven en [VoiceService], así sigue funcionando con
 * la pantalla apagada.
 */
class MainActivity : AppCompatActivity(), ChatAdapter.Listener {

    private lateinit var binding: ActivityMainBinding
    private val chat = ChatAdapter(this)
    private val prefs by lazy { getSharedPreferences("walkie", Context.MODE_PRIVATE) }

    private var pending: Settings? = null
    private var connected = false
    private var peerTalking: String? = null
    private var talking = false

    private val askPermissions =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { granted ->
            if (granted[Manifest.permission.RECORD_AUDIO] == false) {
                toast(getString(R.string.no_mic))
            }
            pending?.let { startRadio(it.server, it.name, it.pin, it.room) }
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        binding.chatList.adapter = chat

        prefs.getString("name", null)?.let { binding.nameField.setText(it) }
        prefs.getString("server", null)?.let { binding.serverField.setText(it) }
        prefs.getString("pin", null)?.let { binding.pinField.setText(it) }
        prefs.getString("room", null)?.let { binding.roomField.setText(it) }

        binding.enterButton.setOnClickListener { enter() }
        binding.leaveButton.setOnClickListener { leave() }
        binding.ptt.setOnTouchListener { _, event -> onPushToTalk(event) }
        binding.sendButton.setOnClickListener { sendChat() }
        binding.chatInput.setOnEditorActionListener { _, action, _ ->
            if (action == EditorInfo.IME_ACTION_SEND) {
                sendChat()
                true
            } else {
                false
            }
        }
    }

    override fun onStart() {
        super.onStart()
        VoiceService.listener = { event -> runOnUiThread { handle(event) } }
    }

    override fun onStop() {
        super.onStop()
        VoiceService.listener = null
    }

    // ------------------------------------------------------------------ entrar

    private fun enter() {
        val server = binding.serverField.text?.toString()?.trim().orEmpty()
        val name = binding.nameField.text?.toString()?.trim().orEmpty()
        val pin = binding.pinField.text?.toString().orEmpty()
        val room = binding.roomField.text?.toString()?.trim().orEmpty().ifBlank { "general" }

        if (server.isEmpty()) {
            binding.serverField.error = getString(R.string.need_server)
            return
        }
        if (name.isEmpty()) {
            binding.nameField.error = getString(R.string.need_name)
            return
        }
        if (VoiceClient.normalize(server) == null) {
            binding.serverField.error = getString(R.string.bad_server)
            return
        }

        prefs.edit()
            .putString("server", server)
            .putString("name", name)
            .putString("pin", pin)
            .putString("room", room)
            .apply()

        val needed = mutableListOf(Manifest.permission.RECORD_AUDIO)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            needed.add(Manifest.permission.POST_NOTIFICATIONS)
        }
        val missing = needed.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isEmpty()) {
            startRadio(server, name, pin, room)
        } else {
            pending = Settings(server, name, pin, room)
            askPermissions.launch(missing.toTypedArray())
        }
    }

    private fun startRadio(server: String, name: String, pin: String, room: String) {
        val intent = Intent(this, VoiceService::class.java).apply {
            action = VoiceService.ACTION_START
            putExtra(VoiceService.EXTRA_SERVER, server)
            putExtra(VoiceService.EXTRA_NAME, name)
            putExtra(VoiceService.EXTRA_PIN, pin)
            putExtra(VoiceService.EXTRA_ROOM, room)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(intent) else startService(intent)

        binding.login.visibility = View.GONE
        binding.stage.visibility = View.VISIBLE
        binding.chatBar.visibility = View.VISIBLE
        binding.roomLabel.text = getString(R.string.connecting)
        binding.serverField.error = null
        binding.nameField.error = null
    }

    private fun leave() {
        startService(Intent(this, VoiceService::class.java).apply { action = VoiceService.ACTION_STOP })
        connected = false
        talking = false
        peerTalking = null
        chat.clear()
        binding.incoming.visibility = View.GONE
        binding.login.visibility = View.VISIBLE
        binding.stage.visibility = View.GONE
        binding.chatBar.visibility = View.GONE
    }

    // ------------------------------------------------------------------ hablar

    private fun onPushToTalk(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                if (!connected) {
                    toast(getString(R.string.not_connected))
                    return true
                }
                if (peerTalking != null) {
                    toast(getString(R.string.busy, peerTalking))
                    return true
                }
                talking = true
                startService(talkIntent(true))
                paintPtt()
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> if (talking) {
                talking = false
                startService(talkIntent(false))
                paintPtt()
            }
        }
        return true
    }

    private fun talkIntent(on: Boolean) = Intent(this, VoiceService::class.java).apply {
        action = VoiceService.ACTION_TALK
        putExtra(VoiceService.EXTRA_ON, on)
    }

    // ------------------------------------------------------------------ eventos

    private fun handle(event: Event) {
        when (event) {
            is Event.Welcome -> {
                connected = true
                binding.roomLabel.text = event.room
                binding.online.text = getString(R.string.online, event.peers.size)
                chat.setHistory(event.history)
                paintPeers(event.peers)
                paintPtt()
            }
            is Event.Rooms -> Unit
            is Event.Roster -> {
                paintPeers(event.peers)
                binding.online.text = getString(R.string.online, event.peers.size)
            }
            is Event.Presence -> binding.online.text = getString(R.string.online, event.online)
            is Event.TalkAccept -> {
                if (!talking) startService(talkIntent(false)) // turno que ya no queremos
            }
            is Event.TalkDeny -> {
                talking = false
                paintPtt()
                toast(getString(R.string.busy, event.by))
            }
            is Event.TalkStart -> {
                peerTalking = event.from
                binding.incoming.text = getString(R.string.peer_talking, event.from)
                binding.incoming.visibility = View.VISIBLE
                vibrate(30)
                paintPtt()
            }
            is Event.TalkEnd -> {
                peerTalking = null
                binding.incoming.visibility = View.GONE
                paintPtt()
            }
            is Event.Chat -> chat.add(event.entry)
            is Event.System -> chat.add(ChatEntry(null, event.text, event.ts, false))
            is Event.Failure -> toast(event.message)
            is Event.Disconnected -> {
                connected = false
                peerTalking = null
                talking = false
                binding.roomLabel.text = getString(R.string.reconnecting)
                binding.incoming.visibility = View.GONE
                paintPtt()
            }
            is Event.Connected -> Unit
            is Event.Audio -> Unit
        }
    }

    private fun paintPeers(peers: List<Peer>) {
        binding.peers.text = peers.joinToString("  ·  ") { if (it.isMe) "${it.name} (tú)" else it.name }
    }

    private fun paintPtt() {
        binding.ptt.isActivated = talking
        binding.ptt.text = when {
            talking -> getString(R.string.talking)
            peerTalking != null -> getString(R.string.listening)
            else -> getString(R.string.push_to_talk)
        }
    }

    private fun sendChat() {
        val text = binding.chatInput.text?.toString()?.trim().orEmpty()
        if (text.isEmpty()) return
        if (!VoiceServiceBus.sendChat(text)) {
            toast(getString(R.string.not_connected))
            return
        }
        binding.chatInput.setText("")
        (getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager)
            .hideSoftInputFromWindow(binding.chatInput.windowToken, 0)
    }

    override fun onChatLongPress(entry: ChatEntry) {
        entry.from?.let { toast(it) }
    }

    private fun vibrate(ms: Long) {
        val vibrator = getSystemService(Context.VIBRATOR_SERVICE) as? android.os.Vibrator
        vibrator?.vibrate(ms)
    }

    private fun toast(message: String) {
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show()
    }

    companion object {
        private val timeFormat = SimpleDateFormat("HH:mm", Locale.getDefault())
        fun formatTime(ts: Long): String = timeFormat.format(Date(ts))
    }
}

/** Canal corto entre la pantalla y el servicio (que es quien tiene la conexión). */
object VoiceServiceBus {
    @Volatile
    var sender: ((String) -> Boolean)? = null

    fun sendChat(text: String): Boolean = sender?.invoke(text) ?: false
}

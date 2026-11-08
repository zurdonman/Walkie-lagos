package com.walkielagos.app

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.wifi.WifiManager
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
import java.io.File
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
    private lateinit var store: HistoryStore
    private val prefs by lazy { getSharedPreferences("walkie", Context.MODE_PRIVATE) }

    private var pending: Settings? = null
    private var lanMode = false
    private var connected = false
    private var peerTalking: String? = null
    private var talking = false
    private var lastStatus = ""

    private val askPermissions =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { granted ->
            if (granted[Manifest.permission.RECORD_AUDIO] == false) {
                toast(getString(R.string.no_mic))
            }
            pendingLan?.let { (name, room) -> startLan(name, room) }
            pending?.let { startRadio(it.server, it.name, it.pin, it.room) }
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WalkieLog.start(this)
        WalkieLog.i("Abriendo la app (modo guardado: ${if (prefs.getString("mode", "server") == "wifi") "wifi" else "servidor"})")
        // Si algo falla al montar la pantalla, se ve un aviso con el motivo en vez de
        // que Android cierre la app sin explicación.
        try {
            buildUi(savedInstanceState)
            WalkieLog.i("Pantalla lista")
        } catch (error: Throwable) {
            WalkieLog.e("No se pudo montar la pantalla", error)
            showFallback(error)
        }
    }

    private fun buildUi(savedInstanceState: Bundle?) {
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        binding.chatList.adapter = chat
        store = runCatching { HistoryStore(this) }.getOrElse {
            WalkieLog.e("No se pudo abrir el historial", it)
            HistoryStore(this)
        }

        prefs.getString("name", null)?.let { binding.nameField.setText(it) }
        prefs.getString("server", null)?.let { binding.serverField.setText(it) }
        prefs.getString("pin", null)?.let { binding.pinField.setText(it) }
        prefs.getString("room", null)?.let { binding.roomField.setText(it) }

        if (prefs.getString("mode", "server") == "wifi") {
            binding.modeWifi.isChecked = true
            lanMode = true
        } else {
            binding.modeServer.isChecked = true
        }
        binding.modeGroup.addOnButtonCheckedListener { _, checkedId, isChecked ->
            if (!isChecked) return@addOnButtonCheckedListener
            lanMode = checkedId == R.id.modeWifi
            paintMode()
        }
        paintMode()

        binding.enterButton.setOnClickListener { safe("Entrar") { enter() } }
        binding.logButton.setOnClickListener { safe("Registro") { showLogMenu() } }
        binding.roomButton.setOnClickListener { safe("Canal") { pickRoom() } }
        binding.roomLabel.setOnClickListener { safe("Canal") { pickRoom() } }
        binding.floatButton.setOnClickListener { safe("Botón flotante") { toggleFloating() } }
        binding.leaveButton.setOnClickListener { leave() }
        binding.ptt.setOnTouchListener { _, event -> onPushToTalk(event) }
        binding.sendButton.setOnClickListener { safe("Enviar") { sendChat() } }
        binding.chatInput.setOnEditorActionListener { _, action, _ ->
            if (action == EditorInfo.IME_ACTION_SEND) {
                sendChat()
                true
            } else {
                false
            }
        }
    }

    /**
     * Pantalla mínima si el diseño normal no se puede montar: dice qué pasó y deja
     * copiar el mensaje. Así la app nunca se queda en «se ha cerrado».
     */
    private fun showFallback(error: Throwable) {
        val detail = "${error.javaClass.simpleName}: ${error.message}"
        val scroll = android.widget.ScrollView(this)
        val box = android.widget.LinearLayout(this).apply {
            orientation = android.widget.LinearLayout.VERTICAL
            setPadding(48, 96, 48, 48)
        }
        box.addView(
            android.widget.TextView(this).apply {
                text = "Walkie Lagos no ha podido abrir la pantalla.\n\n$detail"
                textSize = 16f
            }
        )
        box.addView(
            android.widget.TextView(this).apply {
                text = "\nEl detalle está en Descargas/log walkie/walkie-log.txt.\nPuedes copiar el texto y enviármelo."
                textSize = 13f
            }
        )
        box.addView(
            android.widget.Button(this).apply {
                text = "Copiar el detalle"
                setOnClickListener {
                    val board = getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
                    board.setPrimaryClip(android.content.ClipData.newPlainText("walkie", detail))
                    toast("Copiado")
                }
            }
        )
        box.addView(
            android.widget.Button(this).apply {
                text = "Ver el registro"
                setOnClickListener { showLogMenu() }
            }
        )
        scroll.addView(box)
        setContentView(scroll)
    }

    /** Enseña dónde está el registro y deja compartirlo o borrarlo. */
    private fun showLogMenu() {
        val txt = File(WalkieLog.downloadDir(), "walkie-log.txt")
        val crash = File(WalkieLog.downloadDir(), "walkie-crash.txt")
        val visible = txt.exists()
        val donde = if (visible) {
            "Carpeta: Descargas/log walkie"
        } else {
            "No se pudo escribir en Descargas; se guarda dentro de la app\n(carpeta privada). Usa «Compartir»."
        }
        val message = if (crash.exists()) {
            "$donde\n\nHay un informe de fallo: walkie-crash.txt"
        } else {
            "$donde\n\nSe está guardando todo lo que hace la app."
        }
        androidx.appcompat.app.AlertDialog.Builder(this)
            .setTitle("Registro de la app")
            .setMessage(message)
            .setPositiveButton("Compartir") { _, _ ->
                val ctx = this
                runCatching { WalkieLog.exportToDownloads(ctx) }
                // Se trabaja sobre una copia en la carpeta de la app: se puede enviar siempre.
                val copias = WalkieLog.copyForSharing(ctx)
                val target = copias.firstOrNull { it.name.contains("crash") }
                    ?: copias.firstOrNull()
                    ?: File(WalkieLog.privateDir(ctx), "walkie-log.txt")
                if (!target.exists()) {
                    toast("Todavía no hay registro")
                } else {
                    // Si el archivo está en Descargas, se manda su ruta además del archivo:
                    // siempre hay algo que copiar, aunque el otro móvil no acepte el enlace.
                    val uri = runCatching {
                        androidx.core.content.FileProvider.getUriForFile(ctx, "${packageName}.files", target)
                    }.getOrNull()
                    if (uri == null) WalkieLog.w("No se pudo preparar el archivo para enviar: ${target.absolutePath}")
                    val send = Intent(Intent.ACTION_SEND).apply {
                        type = "text/plain"
                        putExtra(Intent.EXTRA_SUBJECT, "Registro Walkie Lagos")
                        putExtra(Intent.EXTRA_TEXT, "Registro de Walkie Lagos:\n${target.absolutePath}")
                        if (uri != null) {
                            putExtra(Intent.EXTRA_STREAM, uri)
                            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                        }
                    }
                    runCatching { startActivity(Intent.createChooser(send, "Enviar el registro")) }
                        .onFailure { toast("No hay app para enviar; el archivo está en Descargas/log walkie") }
                }
            }
            .setNegativeButton("Cerrar", null)
            .show()
    }

    /** Ejecuta algo de la pantalla sin que un fallo cierre la app. */
    private inline fun safe(what: String, block: () -> Unit) {
        try {
            block()
        } catch (error: Throwable) {
            WalkieLog.e("Fallo en $what", error)
            toast("Fallo en $what. Está en el registro.")
        }
    }

    override fun onResume() {
        super.onResume()
        // Si se habló desde el botón flotante, al volver puede haber mensajes nuevos:
        // se recarga el historial del canal en el que estemos guardado.
        if (prefs.getBoolean("joined", false)) {
            val room = prefs.getInt("roomIndex", currentRoom)
            if (room != currentRoom) {
                currentRoom = room
                binding.roomLabel.text = Lan.ROOMS.getOrElse(room) { "General" }
            }
        }
        // Si venimos de conceder «mostrar sobre otras apps», se pone el botón.
        if (prefs.getBoolean("floatWanted", false) && FloatingButton.canShow(this)) {
            prefs.edit().putBoolean("floatWanted", false).apply()
            safe("Botón flotante") { setFloating(true) }
        }
        paintFloatingButton()
    }

    override fun onStart() {
        super.onStart()
        val handler = { event: Event -> runOnUiThread { handle(event) } }
        if (lanMode) LanService.listener = handler else VoiceService.listener = handler
    }

    override fun onStop() {
        super.onStop()
        VoiceService.listener = null
        LanService.listener = null
    }

    private var pendingLan: Pair<String, Int>? = null

    /** Muestra u oculta lo que sobra según el modo elegido. */
    private fun paintMode() {
        binding.serverBox.visibility = if (lanMode) View.GONE else View.VISIBLE
        binding.pinBox.visibility = if (lanMode) View.GONE else View.VISIBLE
        binding.loginHelp.text = getString(if (lanMode) R.string.help_wifi else R.string.help_server)
        val rooms = if (lanMode) Lan.ROOMS else listOf(getString(R.string.default_room))
        binding.roomField.setAdapter(
            android.widget.ArrayAdapter(this, android.R.layout.simple_list_item_1, rooms)
        )
        binding.roomField.setText(if (lanMode) Lan.ROOMS.first() else getString(R.string.default_room))
    }

    private fun lanRoomIndex(): Int {
        val name = binding.roomField.text?.toString().orEmpty()
        val index = Lan.ROOMS.indexOfFirst { it.equals(name, ignoreCase = true) }
        return if (index < 0) 0 else index
    }

    /** Modo sin servidor: nombre, canal y a hablar por la wifi. */
    private fun enterLan() {
        val wifi = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
        if (!wifi.isWifiEnabled) {
            toast(getString(R.string.need_wifi))
            return
        }
        val name = binding.nameField.text?.toString()?.trim().orEmpty()
        if (name.isEmpty()) {
            binding.nameField.error = getString(R.string.need_name)
            return
        }
        prefs.edit()
            .putString("name", name)
            .putString("mode", "wifi")
            .putInt("lanRoom", lanRoomIndex())
            .apply()

        val needed = mutableListOf(Manifest.permission.RECORD_AUDIO)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            needed.add(Manifest.permission.POST_NOTIFICATIONS)
        }
        val missing = needed.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isEmpty()) {
            startLan(name, lanRoomIndex())
        } else {
            pendingLan = name to lanRoomIndex()
            askPermissions.launch(missing.toTypedArray())
        }
    }

    /** Historial guardado en este móvil para el canal. */
    private fun loadHistory(roomName: String) {
        val entries = store.recent(roomName, 120).map {
            ChatEntry(it.from, it.text, it.at, it.mine)
        }
        chat.setHistory(entries)
    }

    /**
     * Cambia de canal sin salir: cada canal tiene su audio y su transcripción, y su
     * historial guardado en este móvil. Lo oyen los que estén en ese mismo canal.
     */
    /** Activa o quita el botón que flota sobre otras apps (para hablar sin abrirla). */
    private fun toggleFloating() {
        val activo = prefs.getBoolean(LanService.KEY_FLOATING, false)
        if (!activo && !FloatingButton.canShow(this)) {
            // Se pide el permiso y se recuerda que el usuario quiere el botón.
            toast(getString(R.string.float_need_permission))
            prefs.edit().putBoolean("floatWanted", true).apply()
            FloatingButton.requestPermission(this)
            return
        }
        setFloating(!activo)
    }

    /** El botón dice «Flotante» o «Flotante ✓» según esté puesto o no. */
    private fun paintFloatingButton() {
        val on = prefs.getBoolean(LanService.KEY_FLOATING, false)
        binding.floatButton.text = getString(R.string.float_short) + if (on) " ✓" else ""
    }

    private fun setFloating(on: Boolean) {
        prefs.edit().putBoolean(LanService.KEY_FLOATING, on).apply()
        if (lanMode) {
            startService(Intent(this, LanService::class.java).apply {
                action = LanService.ACTION_FLOATING
                putExtra(LanService.EXTRA_ON, on)
            })
        } else {
            startService(Intent(this, VoiceService::class.java).apply {
                action = VoiceService.ACTION_FLOATING
                putExtra(VoiceService.EXTRA_ON, on)
            })
        }
        paintFloatingButton()
        toast(getString(if (on) R.string.float_on else R.string.float_off))
        WalkieLog.i("Flotante: ${if (on) "activado" else "quitado"}")
    }

    private fun pickRoom() {
        val nombres = Lan.ROOMS.map { nombre ->
            if (Lan.ROOMS.indexOf(nombre) == currentRoom) "● $nombre" else "○ $nombre"
        }.toTypedArray()
        androidx.appcompat.app.AlertDialog.Builder(this)
            .setTitle(R.string.pick_room)
            .setSingleChoiceItems(nombres, currentRoom) { dialog, which ->
                dialog.dismiss()
                changeRoom(which)
            }
            .setNegativeButton("Cancelar", null)
            .show()
    }

    private var currentRoom = 0

    private fun changeRoom(room: Int) {
        if (room == currentRoom) return
        currentRoom = room
        prefs.edit()
            .putInt("roomIndex", room)
            .putString("mode", if (lanMode) "wifi" else "server")
            .putBoolean("joined", true)
            .apply()
        WalkieLog.i("Canal: cambio a ${Lan.ROOMS.getOrElse(room) { "?" }}")
        if (lanMode) {
            startService(Intent(this, LanService::class.java).apply {
                action = LanService.ACTION_ROOM
                putExtra(LanService.EXTRA_ROOM, room)
            })
        } else {
            VoiceServiceBus.switchRoom(Lan.ROOMS.getOrElse(room) { "General" })
        }
        binding.roomLabel.text = Lan.ROOMS.getOrElse(room) { "General" }
        loadHistory(Lan.ROOMS.getOrElse(room) { "General" })
        paintFloatingButton()
        binding.incoming.visibility = View.GONE
        peerTalking = null
        toast(getString(R.string.room_changed, Lan.ROOMS.getOrElse(room) { "General" }))
    }

    private fun startLan(name: String, room: Int) {
        currentRoom = room
        prefs.edit().putBoolean("joined", true).putInt("roomIndex", room).apply()
        val nodeId = prefs.getString("nodeId", null) ?: Lan.hex(Lan.newNodeId()).also {
            prefs.edit().putString("nodeId", it).apply()
        }
        LanService.listener = { event -> runOnUiThread { handle(event) } }
        val intent = Intent(this, LanService::class.java).apply {
            action = LanService.ACTION_START
            putExtra(LanService.EXTRA_NAME, name)
            putExtra(LanService.EXTRA_ROOM, room)
            putExtra(LanService.EXTRA_NODE_ID, nodeId)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(intent) else startService(intent)

        loadHistory(Lan.ROOMS.getOrElse(room) { Lan.ROOMS.first() })
        binding.login.visibility = View.GONE
        binding.stage.visibility = View.VISIBLE
        binding.chatBar.visibility = View.VISIBLE
        binding.online.text = getString(R.string.peers_online, 1)
        binding.roomLabel.text = Lan.ROOMS.getOrElse(room) { Lan.ROOMS.first() }
        paintFloatingButton()
        binding.online.text = getString(R.string.peers_online, 1)
        WalkieLog.i("Wifi: entrando como $name en el canal ${Lan.ROOMS.getOrElse(room) { "?" }}")
    }

    // ------------------------------------------------------------------ entrar

    /** En modo wifi no hay dirección ni PIN: solo nombre y canal. */
    private fun enter() {
        if (lanMode) return enterLan()

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

        currentRoom = Lan.ROOMS.indexOfFirst { it.equals(room, ignoreCase = true) }.coerceAtLeast(0)
        prefs.edit().putBoolean("joined", true).putInt("roomIndex", currentRoom).apply()
        loadHistory(room)
        binding.login.visibility = View.GONE
        binding.stage.visibility = View.VISIBLE
        binding.chatBar.visibility = View.VISIBLE
        binding.roomLabel.text = getString(R.string.connecting)
        binding.serverField.error = null
        binding.nameField.error = null
    }

    private fun leave() {
        startService(Intent(this, VoiceService::class.java).apply { action = VoiceService.ACTION_STOP })
        startService(Intent(this, LanService::class.java).apply { action = LanService.ACTION_STOP })
        LanService.listener = null
        connected = false
        talking = false
        peerTalking = null
        currentRoom = 0
        prefs.edit().putBoolean("joined", false).remove("roomIndex").apply()
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
                // En wifi no hace falta esperar a nadie: la radio ya está escuchando.
                if (!lanMode && !connected) {
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

    private fun talkIntent(on: Boolean): Intent =
        if (lanMode) {
            Intent(this, LanService::class.java).apply {
                action = LanService.ACTION_TALK
                putExtra(LanService.EXTRA_ON, on)
            }
        } else {
            Intent(this, VoiceService::class.java).apply {
                action = VoiceService.ACTION_TALK
                putExtra(VoiceService.EXTRA_ON, on)
            }
        }

    // ------------------------------------------------------------------ eventos

    private fun handle(event: Event) {
        when (event) {
            is Event.PeerCount -> {
                connected = true
                binding.online.text = getString(R.string.peers_online, event.count)
            }
            is Event.RoomChanged -> {
                currentRoom = event.index
                binding.roomLabel.text = event.name
                loadHistory(event.name)
            }
            is Event.Status -> {
                binding.status.text = event.text
                // Solo se apunta en el registro cuando cambia (antes se repetía cada 2 s).
                if (event.text != lastStatus) {
                    lastStatus = event.text
                    WalkieLog.i("Estado: ${event.text}")
                }
            }
            is Event.Welcome -> {
                connected = true
                binding.roomLabel.text = event.room
                binding.online.text = getString(R.string.online, event.peers.size)
                // El del móvil es más completo que el del servidor (incluye voces
                // transcritas); si no hay nada guardado, se usa el del servidor.
                val local = store.recent(event.room, 120)
                if (local.isNotEmpty()) {
                    chat.setHistory(local.map { ChatEntry(it.from, it.text, it.at, it.mine) })
                } else {
                    chat.setHistory(event.history)
                }
                paintPeers(event.peers)
                paintPtt()
            }
            is Event.Rooms -> Unit
            is Event.Roster -> {
                paintPeers(event.peers)
                binding.online.text = getString(R.string.online, event.peers.size)
            }
            is Event.Presence -> binding.online.text =
                if (lanMode) getString(R.string.peers_online, event.online) else getString(R.string.online, event.online)
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
            is Event.Chat -> {
                if (!isDuplicate(event.entry)) chat.add(event.entry)
                // Que se vea el mensaje recién llegado (el chat ocupa su propio espacio).
                binding.chatList.scrollToPosition(chat.itemCount - 1)
                if (!event.entry.mine && !documentHidden()) vibrate(20)
            }
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
        val sent = if (lanMode) {
            val radio = LanService.sender
            if (radio == null) {
                false
            } else {
                radio.sendChat(text)
                true
            }
        } else {
            VoiceServiceBus.sendChat(text)
        }
        if (!sent) {
            toast(getString(R.string.not_connected))
            return
        }
        WalkieLog.i("Chat: enviado \"${text.take(60)}\" (${if (lanMode) "wifi" else "servidor"})")
        store.add(
            if (lanMode) Lan.ROOMS.getOrElse(currentRoom) { "General" } else binding.roomLabel.text.toString(),
            binding.nameField.text?.toString()?.trim().orEmpty(),
            text,
            true,
        )
        val mio = ChatEntry(binding.nameField.text?.toString()?.trim().orEmpty(), text, System.currentTimeMillis(), true)
        lastMine = "${text}|${mio.from}"
        lastMineAt = System.currentTimeMillis()
        chat.add(mio)
        binding.chatList.scrollToPosition(chat.itemCount - 1)
        binding.chatInput.setText("")
        (getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager)
            .hideSoftInputFromWindow(binding.chatInput.windowToken, 0)
    }

    override fun onChatLongPress(entry: ChatEntry) {
        entry.from?.let { toast(it) }
    }

    private var lastMine = ""
    private var lastMineAt = 0L

    /** Evita que lo que acabo de escribir salga dos veces (local + vuelta del servicio). */
    private fun isDuplicate(entry: ChatEntry): Boolean {
        val clave = "${entry.text}|${entry.from}"
        val ahora = System.currentTimeMillis()
        if (entry.mine && clave == lastMine && ahora - lastMineAt < 3000) return true
        if (entry.mine) {
            lastMine = clave
            lastMineAt = ahora
        }
        return false
    }

    private fun documentHidden(): Boolean = !hasWindowFocus()


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

    @Volatile
    var switcher: ((String) -> Unit)? = null

    fun sendChat(text: String): Boolean = sender?.invoke(text) ?: false

    fun switchRoom(room: String) {
        switcher?.invoke(room)
    }
}

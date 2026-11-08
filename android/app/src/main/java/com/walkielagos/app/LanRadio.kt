package com.walkielagos.app

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.wifi.WifiManager
import java.net.Inet4Address
import java.net.NetworkInterface
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.MulticastSocket
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Radio local sin servidor: todo va por multicast dentro de la wifi del local.
 * El router es el único "host"; no hay nada que instalar ni configurar.
 *
 * Turno de palabra: se pide con un paquete CLAIM y se sostiene con latidos. Si
 * dos piden a la vez, gana el nodeId menor y el otro cede (determinista, sin
 * negociación y sin servidor que arbitre).
 */
class LanRadio(
    private val context: Context,
    private val nodeId: ByteArray,
    private val name: String,
    private val room: Int,
    private val listener: Listener,
) {
    interface Listener {
        fun onAudio(data: ByteArray)
        fun onPeerSpeaking(from: String)
        fun onPeerSilent(from: String)
        fun onPeerCount(count: Int)
        fun onChat(from: String, text: String)
        fun onPreempted(by: String)
        fun onError(message: String)
    }

    private val id = Lan.hex(nodeId)
    private var socket: MulticastSocket? = null
    private var wifiLock: WifiManager.MulticastLock? = null
    private val running = AtomicBoolean(false)
    private var heartbeatThread: Thread? = null
    private var receiveThread: Thread? = null

    private val peers = LinkedHashMap<String, Pair<String, Long>>() // nodeId -> nombre, último latido
    private var speaker: String? = null
    private var speakerName: String? = null
    private var speakerAt = 0L
    private var lastSequence = -1

    @Volatile
    var talking = false
        private set

    /** Cuántos hay escuchando (yo incluido). */
    val peerCount: Int get() = peers.size + 1

    /** Resumen del estado de la radio, para enseñarlo en pantalla y en el registro. */
    var status: String = ""
        private set

    val isRunning: Boolean get() = running.get()

    fun start() {
        if (!running.compareAndSet(false, true)) return
        try {
            val manager = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            // Sin este cerrojo, Android filtra los paquetes multicast con la pantalla apagada.
            wifiLock = manager.createMulticastLock("walkie-lan").apply {
                setReferenceCounted(false)
                acquire()
            }

            val group = InetAddress.getByName(Lan.GROUP)
            val socket = MulticastSocket(null)
            socket.reuseAddress = true
            socket.bind(InetSocketAddress(Lan.PORT))
            socket.timeToLive = 1
            this.socket = socket

            // Aquí se decide todo: Android puede tener datos móviles y wifi a la vez y,
            // si no se le dice, manda el multicast por los datos (se pierde) o se une al
            // grupo en la interfaz equivocada y no oye nada. Se elige la wifi a mano.
            val wifi = wifiInterface()
            WalkieLog.i("Radio wifi: red ${wifi ?: "no encontrada"}")
            if (wifi == null) {
                throw IllegalStateException("no hay wifi conectada")
            }
            if (wifi.address != null) {
                WalkieLog.i("Radio wifi: mi IP en la wifi es ${wifi.address.hostAddress} (${wifi.device.name})")
            }
            runCatching {
                socket.networkInterface = wifi.device
                WalkieLog.i("Radio wifi: envío por ${wifi.device.name}")
            }.onFailure { WalkieLog.w("Radio wifi: no se pudo fijar la interfaz de envío", it) }

            // Se pide el grupo en la wifi (imprescindible) y también en el resto de
            // interfaces IPv4, por si el router o el móvil obligan a otra.
            val joined = ArrayList<String>()
            for (iface in ipv4Interfaces()) {
                try {
                    socket.joinGroup(InetSocketAddress(group, Lan.PORT), iface)
                    joined.add(iface.name)
                } catch (error: Exception) {
                    WalkieLog.w("Radio wifi: no se pudo unir al grupo en ${iface.name}", error)
                }
            }
            if (joined.isEmpty()) {
                // Último recurso: el método clásico, que elige la interfaz por sí solo.
                runCatching {
                    socket.joinGroup(group)
                    joined.add("(automática)")
                }.onFailure { WalkieLog.w("Radio wifi: tampoco el método automático", it) }
            }
            WalkieLog.i("Radio wifi: unido al grupo en ${joined.joinToString(", ").ifEmpty { "ninguna interfaz" }}")
            if (joined.isEmpty()) {
                throw IllegalStateException("ninguna interfaz acepta el grupo multicast")
            }

            receiveThread = Thread { receiveLoop(socket, group) }.apply {
                isDaemon = true
                name = "walkie-receive"
                start()
            }
            heartbeatThread = Thread { heartbeatLoop() }.apply {
                isDaemon = true
                name = "walkie-heartbeat"
                start()
            }
            send(Lan.TYPE_HEARTBEAT)
            WalkieLog.i("Radio wifi: escuchando en ${Lan.GROUP}:${Lan.PORT} (canal ${Lan.ROOMS.getOrElse(room) { "?" }})")
            status = "Te escuchas en ${wifi.device.name} ${wifi.address?.hostAddress ?: ""} · grupo ${Lan.GROUP}" +
                " (${joined.joinToString(", ")})".takeIf { joined.isNotEmpty() }.orEmpty()
        } catch (error: Exception) {
            WalkieLog.e("Radio wifi: no arranca", error)
            stop()
            listener.onError("No se puede abrir la radio en la wifi: ${error.message}. Comprueba que estás conectado a la wifi del local.")
        }
    }

    /** Interfaz de la wifi conectada, con su dirección IPv4 si se puede. */
    private fun wifiInterface(): WifiInterface? {
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        // No se exige internet: la wifi del local puede no tenerlo y la radio funciona igual.
        val network = cm.allNetworks.firstOrNull { candidate ->
            val caps = cm.getNetworkCapabilities(candidate) ?: return@firstOrNull false
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
        } ?: return ipv4Interfaces()
            .firstOrNull { it.name.startsWith("wlan") }
            ?.let { WifiInterface(it, it.inetAddresses.toList().firstOrNull { a -> a is Inet4Address }) }
        val properties = cm.getLinkProperties(network)
        // Si el sistema no dice el nombre (algunas ROM), se busca la interfaz wlan*.
        val byName = NetworkInterface.getByName(properties?.interfaceName ?: "")
        val device = byName
            ?: ipv4Interfaces().firstOrNull { it.name.startsWith("wlan") || it.name.startsWith("ap") }
            ?: return null
        val address = properties?.linkAddresses
            ?.map { it.address }
            ?.firstOrNull { it is Inet4Address }
        return WifiInterface(device, address)
    }

    private data class WifiInterface(val device: NetworkInterface, val address: InetAddress?)

    /** Interfaces con IPv4 que pueden llevar multicast (fuera loopback y las virtuales). */
    private fun ipv4Interfaces(): List<NetworkInterface> = runCatching {
        NetworkInterface.getNetworkInterfaces().toList()
            .filter { iface ->
                iface.isUp && !iface.isLoopback &&
                    iface.inetAddresses.toList().any { it is Inet4Address } &&
                    !iface.name.startsWith("rmnet") && !iface.name.startsWith("p2p")
            }
    }.getOrDefault(emptyList())

    fun stop() {
        running.set(false)
        if (talking) {
            talking = false
            send(Lan.TYPE_END)
        }
        send(Lan.TYPE_LEAVE)
        send(Lan.TYPE_LEAVE)
        // Cerrar en el acto descartaría el "adiós" que aún no ha salido.
        Thread.sleep(120)
        receiveThread?.interrupt()
        heartbeatThread?.interrupt()
        receiveThread = null
        heartbeatThread = null
        try {
            socket?.close()
        } catch (_: Exception) {
        }
        socket = null
        runCatching { wifiLock?.release() }
        wifiLock = null
        speaker = null
        peers.clear()
    }

    fun setTalking(on: Boolean) {
        talking = on
        send(if (on) Lan.TYPE_CLAIM else Lan.TYPE_END)
    }

    /** Manda un bloque de audio de 20 ms. */
    fun sendAudio(pcm16: ByteArray) = send(Lan.TYPE_AUDIO, pcm16)

    fun sendChat(text: String) = send(Lan.TYPE_CHAT, text.toByteArray(Charsets.UTF_8))

    fun sendHeartbeat() = send(Lan.TYPE_HEARTBEAT)

    private fun send(type: Byte, payload: ByteArray = ByteArray(0)) {
        val socket = socket ?: return
        val packet = Lan.encode(type, room, nodeId, name, payload)
        runCatching {
            socket.send(DatagramPacket(packet, packet.size, InetAddress.getByName(Lan.GROUP), Lan.PORT))
        }
    }

    private fun receiveLoop(socket: MulticastSocket, group: InetAddress) {
        val buffer = ByteArray(2048)
        val packet = DatagramPacket(buffer, buffer.size)
        var ajenos = 0
        var ownSeen = 0
        var lastLog = System.currentTimeMillis()
        while (running.get()) {
            try {
                packet.length = buffer.size
                socket.receive(packet)
                val parsed = Lan.decode(packet.data, packet.length) ?: continue
                if (parsed.nodeId == id) {
                    ownSeen++
                    continue
                }
                ajenos++
                if (System.currentTimeMillis() - lastLog > 30_000) {
                    lastLog = System.currentTimeMillis()
                    WalkieLog.i("Radio wifi: $ajenos paquetes de otros móviles (y $ownSeen propios) en 30 s")
                }
                if (parsed.room != room) continue
                handle(parsed)
            } catch (closed: java.net.SocketException) {
                break
            } catch (_: Exception) {
                // Un paquete corrupto no debe tumbar la radio.
            }
        }
    }

    private fun handle(packet: Lan.Packet) {
        val known = peers.containsKey(packet.nodeId)
        peers[packet.nodeId] = packet.name to System.currentTimeMillis()
        if (!known) WalkieLog.i("Radio wifi: se oye a ${packet.name} (${packet.nodeId.take(4)}…)")
        when (packet.type) {
            Lan.TYPE_CLAIM -> {
                if (talking && !Lan.hasPriority(id, packet.nodeId)) {
                    talking = false
                    listener.onPreempted(packet.name)
                }
                if (!talking) markSpeaking(packet.nodeId, packet.name)
            }
            Lan.TYPE_AUDIO -> {
                if (talking) return
                val sequence = Lan.sequenceOf(packet.payload)
                if (sequence == lastSequence && sequence != 0) return
                if (lastSequence in 1..65534 && sequence < lastSequence - 20) return // paquete viejo
                lastSequence = sequence
                markSpeaking(packet.nodeId, packet.name)
                speakerAt = System.currentTimeMillis()
                listener.onAudio(packet.payload)
            }
            Lan.TYPE_END -> {
                if (speaker == packet.nodeId) {
                    speaker = null
                    speakerName = null
                    listener.onPeerSilent(packet.name)
                }
            }
            Lan.TYPE_CHAT -> {
                val text = String(packet.payload, Charsets.UTF_8)
                WalkieLog.i("Radio wifi: mensaje de ${packet.name}")
                if (text.isNotBlank()) listener.onChat(packet.name, text)
            }
            Lan.TYPE_HEARTBEAT -> listener.onPeerCount(peers.size)
            Lan.TYPE_LEAVE -> {
                WalkieLog.i("Radio wifi: se va ${packet.name}")
                peers.remove(packet.nodeId)
                if (speaker == packet.nodeId) {
                    speaker = null
                    listener.onPeerSilent(packet.name)
                }
                listener.onPeerCount(peers.size)
            }
        }
    }

    private fun markSpeaking(nodeId: String, name: String) {
        if (speaker == nodeId) return
        speaker = nodeId
        speakerName = name
        speakerAt = System.currentTimeMillis()
        listener.onPeerSpeaking(name)
    }

    private fun heartbeatLoop() {
        var tick = 0
        while (running.get()) {
            try {
                Thread.sleep(2000)
            } catch (_: InterruptedException) {
                break
            }
            tick++
            send(Lan.TYPE_HEARTBEAT)
            if (talking) send(Lan.TYPE_CLAIM)
            // Quien lleva 7 s callado desaparece de la lista.
            val now = System.currentTimeMillis()
            val before = peers.size
            peers.entries.removeAll { now - it.value.second > 7000 }
            if (speaker != null && now - speakerAt > 4000) {
                val gone = speakerName ?: ""
                speaker = null
                listener.onPeerSilent(gone)
            }
            if (peers.size != before) {
                WalkieLog.i("Radio wifi: ${peers.size} compañero(s) en la wifi")
            }
            listener.onPeerCount(peers.size)
        }
    }
}

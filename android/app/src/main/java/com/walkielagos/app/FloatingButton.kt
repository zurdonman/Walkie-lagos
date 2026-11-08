package com.walkielagos.app

import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.provider.Settings
import android.util.TypedValue
import android.view.ContextThemeWrapper
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView

/**
 * Botón flotante sobre cualquier app: se mantiene pulsado para hablar y suelta
 * para escuchar, sin abrir Walkie Lagos. Es una capa del sistema (overlay) que
 * lleva [LanService] o [VoiceService], así el audio sigue en el servicio.
 *
 * Se puede arrastrar a un lado de la pantalla y se queda ahí guardado.
 */
class FloatingButton(private val context: Context) {

    interface Listener {
        fun onTalkStart()
        fun onTalkStop()
        fun onOpenApp()
    }

    var listener: Listener? = null

    /** Canal y estado que se muestran bajo el botón. */
    fun setLabel(text: String) {
        runCatching { label?.text = text }
    }

    fun setTalking(talking: Boolean) {
        runCatching {
            root?.alpha = if (talking) 1f else 0.9f
            circle?.background = circleBackground(if (talking) TALKING else IDLE)
        }
    }

    private var windowManager: WindowManager? = null
    private var root: LinearLayout? = null
    private var circle: TextView? = null
    private var label: TextView? = null
    private var params: WindowManager.LayoutParams? = null
    private var shown = false

    companion object {
        private const val IDLE = "#FFB300"
        private const val TALKING = "#FF3D00"
        private const val CHANNEL = "walkie"
        const val PREFS = "walkie"
        const val KEY_X = "floatX"
        const val KEY_Y = "floatY"

        /** Hace falta permiso de "mostrar sobre otras apps". */
        fun canShow(context: Context): Boolean =
            Build.VERSION.SDK_INT < Build.VERSION_CODES.M || Settings.canDrawOverlays(context)

        /** Manda a la pantalla donde se concede el permiso. */
        fun requestPermission(context: Context) {
            if (canShow(context)) return
            runCatching {
                context.startActivity(
                    Intent(
                        Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                        android.net.Uri.parse("package:${context.packageName}"),
                    ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                )
            }
        }
    }

    fun show(): Boolean {
        if (shown) return true
        if (!canShow(context)) return false
        return runCatching {
            val manager = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
            windowManager = manager

            val density = context.resources.displayMetrics.density
            fun dp(value: Int) = (value * density).toInt()

            val wrapper = ContextThemeWrapper(context, android.R.style.Theme_DeviceDefault)
            val box = LinearLayout(wrapper).apply {
                orientation = LinearLayout.VERTICAL
                gravity = Gravity.CENTER_HORIZONTAL
            }

            val button = TextView(wrapper).apply {
                text = "🎙️"
                textSize = 26f
                gravity = Gravity.CENTER
                background = circleBackground(IDLE)
                setTextColor(Color.parseColor("#201503"))
                contentDescription = context.getString(R.string.float_button)
                setOnTouchListener { view, event -> onTouch(view, event) }
            }
            val buttonSize = dp(64)
            box.addView(button, LinearLayout.LayoutParams(buttonSize, buttonSize))

            val text = TextView(wrapper).apply {
                textSize = 10f
                setTextColor(Color.WHITE)
                gravity = Gravity.CENTER
                setBackgroundColor(Color.parseColor("#99000000"))
                setPadding(dp(4), dp(1), dp(4), dp(1))
            }
            box.addView(text, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT))

            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val layoutParams = WindowManager.LayoutParams(
                WindowManager.LayoutParams.WRAP_CONTENT,
                WindowManager.LayoutParams.WRAP_CONTENT,
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                } else {
                    @Suppress("DEPRECATION")
                    WindowManager.LayoutParams.TYPE_PHONE
                },
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                    WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                PixelFormat.TRANSLUCENT,
            ).apply {
                gravity = Gravity.TOP or Gravity.START
                x = prefs.getInt(KEY_X, dp(8))
                y = prefs.getInt(KEY_Y, dp(220))
            }

            manager.addView(box, layoutParams)
            root = box
            circle = button
            label = text
            params = layoutParams
            shown = true
            true
        }.getOrDefault(false)
    }

    fun hide() {
        if (!shown) return
        shown = false
        runCatching { root?.let { windowManager?.removeView(it) } }
        root = null
        circle = null
        label = null
        params = null
    }

    private fun circleBackground(color: String): GradientDrawable = GradientDrawable().apply {
        shape = GradientDrawable.OVAL
        setColor(Color.parseColor(color))
        setStroke((2 * context.resources.displayMetrics.density).toInt(), Color.parseColor("#33FFFFFF"))
    }

    // ------------------------------------------------------------ pulsar y arrastrar

    private var downX = 0f
    private var downY = 0f
    private var startX = 0
    private var startY = 0
    private var dragging = false
    private var talkingNow = false
    private var downAt = 0L
    private val handler = android.os.Handler(android.os.Looper.getMainLooper())

    // Mantener pulsado un instante empieza a hablar; si se arrastra, no.
    private val holdToTalk = Runnable {
        if (!dragging) startTalking()
    }

    private fun onTouch(view: View, event: MotionEvent): Boolean {
        val layout = params ?: return false
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                downX = event.rawX
                downY = event.rawY
                startX = layout.x
                startY = layout.y
                dragging = false
                downAt = System.currentTimeMillis()
                view.alpha = 0.75f
                handler.postDelayed(holdToTalk, if (talkingNow) 0 else 180)
            }
            MotionEvent.ACTION_MOVE -> {
                val dx = event.rawX - downX
                val dy = event.rawY - downY
                if (!dragging && (kotlin.math.abs(dx) > 24 || kotlin.math.abs(dy) > 24)) {
                    dragging = true
                    handler.removeCallbacks(holdToTalk)
                    stopTalking()
                }
                if (dragging) {
                    layout.x = (startX + dx).toInt()
                    layout.y = (startY + dy).toInt()
                    runCatching { windowManager?.updateViewLayout(root, layout) }
                }
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                handler.removeCallbacks(holdToTalk)
                view.alpha = 1f
                if (dragging) {
                    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    prefs.edit().putInt(KEY_X, layout.x).putInt(KEY_Y, layout.y).apply()
                } else if (talkingNow) {
                    stopTalking()
                } else if (System.currentTimeMillis() - downAt < 350) {
                    // Toque corto: abrir la app para ver el chat.
                    listener?.onOpenApp()
                }
                dragging = false
            }
        }
        return true
    }

    /** Empieza a hablar (se mantiene pulsado el botón flotante). */
    private fun startTalking() {
        if (talkingNow) return
        talkingNow = true
        setTalking(true)
        listener?.onTalkStart()
    }

    fun stopTalking() {
        if (!talkingNow) return
        talkingNow = false
        handler.removeCallbacks(holdToTalk)
        setTalking(false)
        listener?.onTalkStop()
    }

    val isTalking: Boolean get() = talkingNow
}

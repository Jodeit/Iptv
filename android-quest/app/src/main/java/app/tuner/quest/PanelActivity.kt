package app.tuner.quest

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.KeyEvent
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONObject

/**
 * Tuner in a window: what the app icon opens. An ordinary 2D activity, so Horizon OS shows it as a panel you can move
 * and resize next to other apps, with no VR environment. The library is the hosted page in a WebView; ExoPlayer plays
 * onto a SurfaceView behind it, filling the window. "VR" hands over to [MainActivity] (the Spatial SDK theater:
 * passthrough or a dark cinema, 3D video) and carries on with whatever was playing.
 */
class PanelActivity : Activity() {
    private companion object {
        const val STEP_SEEK_MS = 10_000L
        const val NAVY = 0xFF0C111D.toInt()
        const val GOLD = 0xFFD9B97B.toInt()
        const val CREAM = 0xFFF3E7C6.toInt()
    }

    private val ui = Handler(Looper.getMainLooper())
    private lateinit var playback: Playback
    private lateinit var web: WebView
    private lateinit var video: SurfaceView
    private lateinit var bar: LinearLayout
    private lateinit var status: TextView
    private lateinit var playBtn: TextView
    private var videoW = 16
    private var videoH = 9
    private var lastPlay: JSONObject? = null // what is playing, to hand over to VR
    private val hideBar = Runnable { if (playing() && !libraryShown()) bar.visibility = View.GONE }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        DebugLog.init(this)
        DebugLog.log("panel: onCreate")
        playback = Playback(this, onState = { ui.post { updateStatus() } }, onVideoSize = { w, h -> ui.post { videoW = w; videoH = h; fitVideo() } })

        val root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        video = SurfaceView(this).apply {
            holder.addCallback(object : SurfaceHolder.Callback {
                override fun surfaceCreated(h: SurfaceHolder) = playback.setSurface(h.surface)
                override fun surfaceChanged(h: SurfaceHolder, f: Int, w: Int, ht: Int) {}
                override fun surfaceDestroyed(h: SurfaceHolder) = playback.clearSurface()
            })
            setOnClickListener { if (bar.visibility == View.VISIBLE) bar.visibility = View.GONE else showBar() }
        }
        root.addView(video, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT, Gravity.CENTER))
        root.addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> fitVideo() }
        web = makeWeb(this)
        root.addView(web, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
        bar = makeBar(this)
        root.addView(bar, FrameLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT, Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL).apply { bottomMargin = dp(18) })
        bar.visibility = View.GONE
        setContentView(root)
    }

    override fun onDestroy() {
        playback.release()
        web.destroy()
        super.onDestroy()
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()
    private fun playing() = lastPlay != null
    private fun libraryShown() = web.visibility == View.VISIBLE

    /** Letterbox: the picture keeps its shape whatever size the window is. */
    private fun fitVideo() {
        val root = video.parent as? View ?: return
        val pw = root.width; val ph = root.height
        if (pw == 0 || ph == 0 || videoW == 0 || videoH == 0) return
        val scale = minOf(pw.toFloat() / videoW, ph.toFloat() / videoH)
        val lp = video.layoutParams as FrameLayout.LayoutParams
        val w = (videoW * scale).toInt(); val h = (videoH * scale).toInt()
        if (lp.width != w || lp.height != h) { lp.width = w; lp.height = h; video.layoutParams = lp }
    }

    // ---------- Library ----------

    @SuppressLint("SetJavaScriptEnabled")
    private fun makeWeb(ctx: Context): WebView {
        val w = WebView(ctx)
        w.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            userAgentString = "$userAgentString TunerQuest"
        }
        w.setBackgroundColor(Color.parseColor("#EBDFB8"))
        w.addJavascriptInterface(Bridge(), "TunerQuest")
        w.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView, url: String) { DebugLog.log("panel: page loaded $url") }
            override fun onReceivedError(view: WebView, request: android.webkit.WebResourceRequest, error: android.webkit.WebResourceError) {
                if (request.isForMainFrame) DebugLog.log("panel: page error ${error.errorCode} ${error.description}")
            }
        }
        w.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(m: android.webkit.ConsoleMessage): Boolean {
                if (m.messageLevel() == android.webkit.ConsoleMessage.MessageLevel.ERROR) DebugLog.log("js error: ${m.message()} (${m.sourceId()}:${m.lineNumber()})")
                return true
            }
        }
        val url = pageUrl(intent)
        w.loadUrl(url)
        DebugLog.log("panel: loading $url")
        return w
    }

    /** What the page can call (on a WebView thread). Same interface as the VR activity's. */
    inner class Bridge {
        @JavascriptInterface
        fun play(json: String) {
            DebugLog.log("panel play: $json")
            val o = JSONObject(json)
            ui.post { startPlaying(o) }
        }
        @JavascriptInterface fun report(msg: String) { DebugLog.log(msg) }
        @JavascriptInterface fun stop() { ui.post { stopPlaying() } }
    }

    private fun startPlaying(o: JSONObject) {
        lastPlay = o
        val urls = o.getJSONArray("urls").let { a -> List(a.length()) { a.getString(it) } }
        status.text = o.optString("title")
        showLibrary(false)
        playback.play(urls, o.optBoolean("live"), (o.optDouble("startAt", 0.0) * 1000).toLong())
    }

    private fun stopPlaying() {
        playback.stop()
        lastPlay = null
        showLibrary(true)
        web.evaluateJavascript("document.dispatchEvent(new Event('questStopped'))", null)
    }

    private fun showLibrary(show: Boolean) {
        web.visibility = if (show) View.VISIBLE else View.GONE
        if (show) { bar.visibility = if (playing()) View.VISIBLE else View.GONE; web.requestFocus() } else showBar()
        libraryBtn?.text = if (show) "Picture" else "Library"
    }

    private fun showBar() {
        bar.visibility = View.VISIBLE
        ui.removeCallbacks(hideBar)
        ui.postDelayed(hideBar, 5000)
    }

    // ---------- VR ----------

    /** Hands over to the Spatial SDK theater (exclusive mode: this window closes), resuming what was playing. */
    private fun openVr() {
        val i = Intent(this, MainActivity::class.java).apply {
            action = Intent.ACTION_MAIN
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            intent?.getStringExtra("url")?.let { putExtra("url", it) }
            lastPlay?.let { o ->
                val resume = JSONObject(o.toString())
                if (!o.optBoolean("live")) resume.put("startAt", playback.positionMs / 1000.0)
                putExtra("play", resume.toString())
            }
        }
        DebugLog.log("panel: opening VR")
        startActivity(i)
        finishAndRemoveTask()
    }

    // ---------- Controls ----------

    private var libraryBtn: TextView? = null

    private fun makeBar(ctx: Context): LinearLayout {
        fun pill(fill: Int, stroke: Int = Color.TRANSPARENT) = GradientDrawable().apply {
            cornerRadius = dp(40).toFloat(); setColor(fill); if (stroke != Color.TRANSPARENT) setStroke(dp(1), stroke)
        }
        fun btn(label: String, accent: Boolean = false, onClick: (TextView) -> Unit) = TextView(ctx).apply {
            text = label; textSize = 17f; gravity = Gravity.CENTER; isClickable = true; isFocusable = true
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(if (accent) NAVY else CREAM)
            background = pill(if (accent) GOLD else Color.argb(60, 243, 231, 198), if (accent) Color.TRANSPARENT else Color.argb(90, 243, 231, 198))
            setPadding(dp(18), dp(10), dp(18), dp(10))
            layoutParams = LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply { setMargins(dp(5), 0, dp(5), 0) }
            setOnClickListener { onClick(this); if (playing()) showBar() }
        }
        status = TextView(ctx).apply {
            setTextColor(CREAM); textSize = 16f; typeface = Typeface.DEFAULT_BOLD; gravity = Gravity.CENTER
            maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END
        }
        playBtn = btn("Pause", accent = true) { playback.togglePause() }
        val library = btn("Library") { showLibrary(!libraryShown()) }
        libraryBtn = library
        val row = LinearLayout(ctx).apply {
            gravity = Gravity.CENTER_VERTICAL
            addView(btn("−10 s") { playback.seekBy(-STEP_SEEK_MS) })
            addView(playBtn)
            addView(btn("+10 s") { playback.seekBy(STEP_SEEK_MS) })
            addView(btn("Stop") { stopPlaying() })
            addView(library)
            addView(btn("VR") { openVr() })
        }
        return LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            background = pill(Color.argb(225, 12, 17, 29), Color.argb(70, 217, 185, 123)).also { it.cornerRadius = dp(30).toFloat() }
            setPadding(dp(20), dp(10), dp(20), dp(12))
            addView(status, LinearLayout.LayoutParams(MATCH_PARENT, dp(28)))
            addView(row)
        }
    }

    private fun updateStatus() {
        val title = lastPlay?.optString("title") ?: return
        status.text = playback.statusLine(title)
        playBtn.text = if (playback.isPlaying) "Pause" else "Play"
    }

    // Controllers: A play/pause, B library, X/Y seek. Back closes the picture before it closes the app.
    override fun dispatchKeyEvent(e: KeyEvent): Boolean {
        if (e.action == KeyEvent.ACTION_DOWN && e.repeatCount == 0 && playing()) {
            when (e.keyCode) {
                KeyEvent.KEYCODE_BUTTON_A -> { playback.togglePause(); showBar(); return true }
                KeyEvent.KEYCODE_BUTTON_B -> { showLibrary(!libraryShown()); return true }
                KeyEvent.KEYCODE_BUTTON_X -> { playback.seekBy(-STEP_SEEK_MS); showBar(); return true }
                KeyEvent.KEYCODE_BUTTON_Y -> { playback.seekBy(STEP_SEEK_MS); showBar(); return true }
            }
        }
        return super.dispatchKeyEvent(e)
    }

    @Deprecated("Activity back handling")
    override fun onBackPressed() {
        when {
            playing() && !libraryShown() -> showLibrary(true)
            web.canGoBack() -> web.goBack()
            else -> @Suppress("DEPRECATION") super.onBackPressed()
        }
    }
}

/**
 * The page the app loads. `adb shell am start -n app.tuner.quest/.PanelActivity --es url <url>` loads another one:
 * any https deployment, or a dev server on the headset itself (http://127.0.0.1:8080 from `npm start` in Termux),
 * so web changes can be tried without deploying.
 */
fun pageUrl(intent: Intent?): String {
    val extra = intent?.getStringExtra("url")
    val base = extra?.takeIf { it.startsWith("https://") || Regex("^http://(127\\.0\\.0\\.1|localhost)(:\\d+)?(/|$)").containsMatchIn(it) }
        ?: BuildConfig.APP_URL
    // ui=tuner: the page's designed interface (the TV app's look, touch-friendly) instead of the phone layout.
    val u = Uri.parse(base)
    return if (u.getQueryParameter("ui") == null) u.buildUpon().appendQueryParameter("ui", "tuner").build().toString() else base
}

package app.tuner.quest

import android.annotation.SuppressLint
import android.graphics.Color
import android.graphics.Typeface
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.LinearLayout
import android.widget.TextView
import com.meta.spatial.core.Entity
import com.meta.spatial.core.Pose
import com.meta.spatial.core.Quaternion
import com.meta.spatial.core.Vector2
import com.meta.spatial.core.Vector4
import com.meta.spatial.isdk.IsdkGrabConstraints
import com.meta.spatial.isdk.IsdkPanelDimensions
import com.meta.spatial.isdk.IsdkPanelGrabHandle
import com.meta.spatial.isdk.IsdkPanelResize
import com.meta.spatial.core.SpatialFeature
import com.meta.spatial.core.Vector3
import com.meta.spatial.runtime.ReferenceSpace
import com.meta.spatial.runtime.StereoMode
import com.meta.spatial.toolkit.AppSystemActivity
import com.meta.spatial.toolkit.DpPerMeterDisplayOptions
import com.meta.spatial.toolkit.MediaPanelRenderOptions
import com.meta.spatial.toolkit.MediaPanelSettings
import com.meta.spatial.toolkit.createPanelEntity
import com.meta.spatial.toolkit.PanelRegistration
import com.meta.spatial.toolkit.PixelDisplayOptions
import com.meta.spatial.toolkit.QuadShapeOptions
import com.meta.spatial.toolkit.Transform
import com.meta.spatial.toolkit.UIPanelSettings
import com.meta.spatial.toolkit.ViewPanelRegistration
import com.meta.spatial.toolkit.VideoSurfacePanelRegistration
import com.meta.spatial.toolkit.Visible
import com.meta.spatial.vr.LocomotionSystem
import com.meta.spatial.vr.VRFeature
import org.json.JSONObject

/**
 * Tuner for Quest: a native Meta Spatial SDK app.
 *
 *  - Browse: the hosted Tuner page in a WebView panel (channels, movies, search, guide). When it sees the
 *    `TunerQuest` bridge it hands playback to this app instead of its own <video> (see playQuest in js/main.js).
 *  - Play: Media3 ExoPlayer decodes onto a video-surface panel. That is the platform's own decoder path (HEVC, AV1,
 *    HLS, MPEG-TS, MKV) plus FFmpeg for AC-3/E-AC-3/DTS audio, and the surface goes to the compositor as a layer.
 *  - Space: passthrough (mixed reality) or a dark cinema, with a screen you can resize and move; SBS/TAB 3D video.
 */
class MainActivity : AppSystemActivity() {
    private companion object {
        const val PANEL_WEB = 1
        const val PANEL_VIDEO = 2
        const val PANEL_CONTROLS = 3
        const val VIEW_Z = 2f
        const val WEB_DIST = 1.5f
        const val WEB_DY = -0.05f
        const val BAR_DIST = 1.1f
        const val BAR_DY = -0.5f
        const val STEP_SEEK_MS = 10_000L
    }

    private val ui = Handler(Looper.getMainLooper())
    private lateinit var playback: Playback
    private var web: WebView? = null
    private var webEntity: Entity? = null
    private var controlsEntity: Entity? = null
    private var videoEntity: Entity? = null

    private var passthrough = true
    private var stereo = StereoMode.None
    private var stereoLabel = "2D"
    private var screenWidth = 2.6f     // metres
    private var distance = 3.0f        // metres in front of the viewer
    private var screenDy = 0.1f         // metres above eye level
    private var eye = 1.2f              // eye height above the floor, measured a moment after start
    private var title = ""
    private var statusView: TextView? = null

    override fun registerFeatures(): List<SpatialFeature> = listOf(VRFeature(this))

    override fun onCreate(savedInstanceState: Bundle?) {
        DebugLog.init(this)
        playback = Playback(this, onState = { updateStatus() })
        super.onCreate(savedInstanceState)
        DebugLog.log("onCreate done")
    }

    override fun registerPanels(): List<PanelRegistration> = also { DebugLog.log("registerPanels") }.let { listOf(
        ViewPanelRegistration(
            PANEL_WEB,
            { _, ctx -> try { makeWeb(ctx) } catch (e: Throwable) { DebugLog.log("web view failed: $e"); errorView(ctx, "Can't start the web view:\n$e") } },
            { UIPanelSettings(shape = QuadShapeOptions(width = 1.8f, height = 1.1f), display = DpPerMeterDisplayOptions(dpPerMeter = 650f)) },
            { v, _, _ -> DebugLog.log("web panel ready: view ${v.width}x${v.height}, attached=${v.isAttachedToWindow}") },
        ),
        ViewPanelRegistration(
            PANEL_CONTROLS,
            { _, ctx -> makeControls(ctx) },
            { UIPanelSettings(shape = QuadShapeOptions(width = 1.6f, height = 0.34f), display = DpPerMeterDisplayOptions(dpPerMeter = 600f)) },
        ),
        VideoSurfacePanelRegistration(
            PANEL_VIDEO,
            { _, surface -> playback.setSurface(surface) },
            {
                MediaPanelSettings(
                    shape = QuadShapeOptions(width = screenWidth, height = screenWidth * 9f / 16f),
                    display = PixelDisplayOptions(width = 1920, height = 1080),
                    rendering = MediaPanelRenderOptions(stereoMode = stereo),
                )
            },
        ),
    ) }

    override fun onSceneReady() {
        super.onSceneReady()
        DebugLog.log("onSceneReady")
        scene.setReferenceSpace(ReferenceSpace.LOCAL_FLOOR)
        scene.setViewOrigin(0f, 0f, VIEW_Z, 180f)
        // The thumbstick would otherwise walk the viewer through the scene (panels seem to slide the wrong way).
        try { systemManager.findSystem<LocomotionSystem>().enableLocomotion(false); DebugLog.log("locomotion off") } catch (e: Throwable) { DebugLog.log("locomotion: $e") }
        applyPassthrough()
        DebugLog.log("scene configured, creating entities")
        webEntity = Entity.createPanelEntity(PANEL_WEB, Transform(inFront(WEB_DIST, WEB_DY)), noRotation())
        controlsEntity = Entity.createPanelEntity(PANEL_CONTROLS, Transform(inFront(BAR_DIST, BAR_DY)), Visible(false), noRotation())
        DebugLog.log("entities created")
    }


    // Same layout as Meta's sample apps: the viewer is moved to z = VIEW_Z and turned around, so everything in front of
    // them sits at smaller z and an unrotated panel faces them.
    /** A pose [dist] metres ahead of the viewer and [dy] metres above (or below) eye level. */
    private fun inFront(dist: Float, dy: Float, pitch: Float = 0f, x: Float = 0f, yaw: Float = 180f) =
        Pose(Vector3(x, eye + dy, VIEW_Z - dist), Quaternion(pitch, yaw, 0f))

    /** Panels can be moved and resized by hand, but not turned: that keeps the screen level and facing you. */
    private fun noRotation() = IsdkGrabConstraints().apply { lockFlags = IsdkGrabConstraints.LockFlags.ROTATION }

    private var ticks = 0

    /** Puts a panel back to its fixed orientation if hand-grabbing turned it (the SDK's own rotation lock did not hold). */
    private fun holdUpright(e: Entity?, pitch: Float = 0f) {
        e ?: return
        val t = e.tryGetComponent<Transform>() ?: return
        val want = Quaternion(pitch, 180f, 0f)
        val q = t.transform.q
        val dot = Math.abs(q.w * want.w + q.x * want.x + q.y * want.y + q.z * want.z)
        if (dot < 0.9999f) {
            t.transform = Pose(t.transform.t, want)
            e.setComponent(t)
        }
    }

    override fun onSceneTick() {
        super.onSceneTick()
        holdUpright(webEntity)
        holdUpright(controlsEntity)
        holdUpright(videoEntity)
        if (++ticks == 90) { // diagnostics only
            try {
                val v = scene.getViewerPose()
                val f = v.q * Vector3(0f, 0f, 1f)
                DebugLog.log("viewer: pos=(${v.t.x}, ${v.t.y}, ${v.t.z}) looking=(${f.x}, ${f.y}, ${f.z})")
                if (v.t.y in 0.5f..2.3f) {
                    eye = v.t.y
                    webEntity?.setComponent(Transform(inFront(WEB_DIST, WEB_DY)))
                    controlsEntity?.setComponent(Transform(inFront(BAR_DIST, BAR_DY)))
                    moveScreen()
                }
            } catch (e: Throwable) { DebugLog.log("viewer pose failed: $e") }
        }
    }

    override fun onDestroy() {
        playback.release()
        web?.destroy()
        super.onDestroy()
    }

    // ---------- Browse ----------

    @SuppressLint("SetJavaScriptEnabled")
    private fun makeWeb(ctx: android.content.Context): View {
        val w = WebView(ctx)
        web = w
        w.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            userAgentString = "$userAgentString TunerQuest"
        }
        w.setBackgroundColor(Color.parseColor("#EBDFB8"))
        var events = 0
        w.setOnTouchListener { _, e -> if (events++ < 30 || e.actionMasked == android.view.MotionEvent.ACTION_DOWN) DebugLog.log("touch ${android.view.MotionEvent.actionToString(e.actionMasked)} at ${e.x.toInt()},${e.y.toInt()} (view ${w.width}x${w.height})"); false }
        w.setOnGenericMotionListener { _, e -> if (e.actionMasked != android.view.MotionEvent.ACTION_HOVER_MOVE && e.actionMasked != android.view.MotionEvent.ACTION_SCROLL) DebugLog.log("motion ${android.view.MotionEvent.actionToString(e.actionMasked)}"); false }
        w.setOnHoverListener { _, e -> if (events++ < 30) DebugLog.log("hover ${android.view.MotionEvent.actionToString(e.actionMasked)} at ${e.x.toInt()},${e.y.toInt()}"); false }
        w.addJavascriptInterface(Bridge(), "TunerQuest")
        w.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView, url: String) {
                DebugLog.log("page loaded: $url")
                // The page only hands playback to this app if its own code has the playQuest hook.
                view.evaluateJavascript("fetch('/js/main.js').then(r=>r.text()).then(t=>TunerQuest.report('page has the playQuest hook: '+t.includes('playQuest')))", null)
                view.evaluateJavascript("typeof window.TunerQuest") { DebugLog.log("bridge in page: $it") }
            }
            override fun onReceivedError(view: WebView, request: android.webkit.WebResourceRequest, error: android.webkit.WebResourceError) {
                if (request.isForMainFrame) DebugLog.log("page error: ${error.errorCode} ${error.description}")
            }
        }
        w.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(m: android.webkit.ConsoleMessage): Boolean {
                if (m.messageLevel() == android.webkit.ConsoleMessage.MessageLevel.ERROR) DebugLog.log("js error: ${m.message()} (${m.sourceId()}:${m.lineNumber()})")
                return true
            }
        }
        // `adb shell am start ... --es url https://...` loads another deployment (e.g. a branch preview) for testing.
        val base = intent?.getStringExtra("url")?.takeIf { it.startsWith("https://") } ?: BuildConfig.APP_URL
        // ui=tuner: the page's designed interface (the TV app's look, touch-friendly) instead of the phone layout.
        val pageUrl = Uri.parse(base).buildUpon().apply { if (Uri.parse(base).getQueryParameter("ui") == null) appendQueryParameter("ui", "tuner") }.build().toString()
        w.loadUrl(pageUrl)
        DebugLog.log("web view created, loading $pageUrl")
        return w
    }

    private fun errorView(ctx: android.content.Context, msg: String): View =
        TextView(ctx).apply { text = msg; setTextColor(Color.WHITE); setBackgroundColor(Color.parseColor("#802020")); textSize = 24f; setPadding(32, 32, 32, 32) }

    /** What the page can call. Runs on a WebView thread: hop to the UI thread for anything that touches the player. */
    inner class Bridge {
        /** {urls: [..], title, live, startAt (seconds), mode: "mono"|"xr3d"|"sbs"|"tab"} */
        @JavascriptInterface
        fun play(json: String) {
            val o = JSONObject(json)
            DebugLog.log("play: $json")
            val urls = o.getJSONArray("urls").let { a -> List(a.length()) { a.getString(it) } }
            ui.post {
                title = o.optString("title")
                setStereo(
                    when (o.optString("mode")) { "sbs" -> StereoMode.LeftRight; "tab" -> StereoMode.UpDown; else -> StereoMode.None },
                )
                showPlayer()
                playback.play(urls, o.optBoolean("live"), (o.optDouble("startAt", 0.0) * 1000).toLong())
            }
        }

        @JavascriptInterface fun report(msg: String) { DebugLog.log(msg) }

        @JavascriptInterface fun stop() { ui.post { stopPlayback() } }
    }

    // ---------- Space ----------

    private fun applyPassthrough() {
        scene.enablePassthrough(passthrough)
    }

    private fun setStereo(mode: StereoMode) {
        stereo = mode
        stereoLabel = when (mode) { StereoMode.LeftRight -> "SBS 3D"; StereoMode.UpDown -> "TAB 3D"; else -> "2D" }
    }

    /** (Re)creates the video panel: its stereo mode and size are fixed when the panel is made. */
    private fun showPlayer() {
        playback.clearSurface()
        videoEntity?.destroy()
        videoEntity = Entity.createPanelEntity(
            PANEL_VIDEO,
            Transform(inFront(distance, screenDy)),
            noRotation(),
            // Free-floating picture: the frame is drawn fully transparent (the edges still work as grab and resize handles),
            // and the default 1.5 m resize limit is far too small for a screen.
            IsdkPanelGrabHandle(color = Vector4(0f, 0f, 0f, 0f)),
            // The grab/resize box defaults to 0.75 x 1 m, far smaller than the picture; make it the size of the screen.
            IsdkPanelDimensions(Vector2(screenWidth, screenWidth * 9f / 16f)),
            IsdkPanelResize(minDimensions = Vector2(0.8f, 0.45f), maxDimensions = Vector2(14f, 8f), preserveAspectRatio = true),
        )
        setLibrary(false)
        controlsEntity?.setComponent(Visible(true))
        updateStatus()
    }

    private fun stopPlayback() {
        playback.stop()
        videoEntity?.destroy()
        videoEntity = null
        controlsEntity?.setComponent(Visible(false))
        setLibrary(true)
        web?.evaluateJavascript("document.dispatchEvent(new Event('questStopped'))", null)
    }

    private fun moveScreen() {
        videoEntity?.setComponent(Transform(inFront(distance, screenDy)))
    }

    // ---------- Controls ----------

    // Brand colours from the app: deep navy, warm gold, soft cream.
    private val NAVY = Color.parseColor("#0C111D")
    private val GOLD = Color.parseColor("#D9B97B")
    private val CREAM = Color.parseColor("#F3E7C6")

    private fun makeControls(ctx: android.content.Context): View {
        val d = ctx.resources.displayMetrics.density
        fun dp(v: Int) = (v * d).toInt()
        fun pill(fill: Int, stroke: Int = Color.TRANSPARENT) = android.graphics.drawable.GradientDrawable().apply {
            shape = android.graphics.drawable.GradientDrawable.RECTANGLE
            cornerRadius = dp(40).toFloat(); setColor(fill); if (stroke != Color.TRANSPARENT) setStroke(dp(1), stroke)
        }
        fun btn(label: String, accent: Boolean = false, onClick: (TextView) -> Unit) = TextView(ctx).apply {
            text = label; textSize = 17f; gravity = Gravity.CENTER; isClickable = true; isFocusable = true
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(if (accent) NAVY else CREAM)
            background = pill(if (accent) GOLD else Color.argb(60, 243, 231, 198), if (accent) Color.TRANSPARENT else Color.argb(90, 243, 231, 198))
            setPadding(dp(18), dp(10), dp(18), dp(10))
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { setMargins(dp(5), 0, dp(5), 0) }
            setOnClickListener { onClick(this) }
        }
        fun gap() = View(ctx).apply { layoutParams = LinearLayout.LayoutParams(dp(18), 1) }

        val status = TextView(ctx).apply {
            setTextColor(CREAM); textSize = 18f; typeface = Typeface.DEFAULT_BOLD; gravity = Gravity.CENTER_VERTICAL
            maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END
        }
        statusView = status
        val play = btn("Pause", accent = true) { playback.togglePause() }
        playButton = play

        val modeBtn = btn("2D") { }
        modeBtn.setOnClickListener {
            setStereo(when (stereo) { StereoMode.None -> StereoMode.LeftRight; StereoMode.LeftRight -> StereoMode.UpDown; else -> StereoMode.None })
            modeBtn.text = stereoLabel
            if (videoEntity != null) showPlayer()
        }
        val room = btn(if (passthrough) "Room" else "Dark") { }
        room.setOnClickListener { passthrough = !passthrough; room.text = if (passthrough) "Room" else "Dark"; applyPassthrough() }
        val library = btn(if (libraryShown) "Hide library" else "Library") { }
        libraryButton = library
        library.setOnClickListener { setLibrary(!libraryShown) }

        val transport = LinearLayout(ctx).apply {
            gravity = Gravity.CENTER_VERTICAL
            addView(btn("−10 s") { playback.seekBy(-STEP_SEEK_MS) })
            addView(play)
            addView(btn("+10 s") { playback.seekBy(STEP_SEEK_MS) })
            addView(btn("Stop") { stopPlayback() })
            addView(gap())
            addView(room); addView(modeBtn)
            addView(gap())
            addView(btn("Smaller") { screenWidth = (screenWidth * 0.85f).coerceAtLeast(1f); if (videoEntity != null) showPlayer() })
            addView(btn("Larger") { screenWidth = (screenWidth * 1.18f).coerceAtMost(12f); if (videoEntity != null) showPlayer() })
            addView(gap())
            addView(library)
        }
        return LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            background = pill(Color.argb(235, 12, 17, 29), Color.argb(70, 217, 185, 123)).also { it.cornerRadius = dp(34).toFloat() }
            setPadding(dp(26), dp(14), dp(26), dp(16))
            addView(status, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(34)))
            addView(transport)
        }
    }

    private var playButton: TextView? = null
    private var libraryButton: TextView? = null
    private var libraryShown = true // the library is up at launch

    private fun setLibrary(show: Boolean) {
        libraryShown = show
        webEntity?.setComponent(Visible(show))
        libraryButton?.text = if (show) "Hide library" else "Library"
    }

    // ---- Controller buttons (if the system passes them to the app; every key and stick event is logged to find out) ----
    //   A: play / pause    B: show / hide the library    X: back 10 s    Y: forward 10 s    stick left/right: seek
    private var lastStick = 0L

    override fun dispatchKeyEvent(e: android.view.KeyEvent): Boolean {
        if (e.action == android.view.KeyEvent.ACTION_DOWN && e.repeatCount == 0) {
            DebugLog.log("key ${android.view.KeyEvent.keyCodeToString(e.keyCode)}")
            when (e.keyCode) {
                android.view.KeyEvent.KEYCODE_BUTTON_A -> { playback.togglePause(); return true }
                android.view.KeyEvent.KEYCODE_BUTTON_B -> { setLibrary(!libraryShown); return true }
                android.view.KeyEvent.KEYCODE_BUTTON_X -> { playback.seekBy(-STEP_SEEK_MS); return true }
                android.view.KeyEvent.KEYCODE_BUTTON_Y -> { playback.seekBy(STEP_SEEK_MS); return true }
            }
        }
        return super.dispatchKeyEvent(e)
    }

    override fun dispatchGenericMotionEvent(e: android.view.MotionEvent): Boolean {
        if (e.source and android.view.InputDevice.SOURCE_JOYSTICK != 0 && e.actionMasked == android.view.MotionEvent.ACTION_MOVE) {
            val x = e.getAxisValue(android.view.MotionEvent.AXIS_X)
            val now = android.os.SystemClock.uptimeMillis()
            if (Math.abs(x) > 0.7f && now - lastStick > 350) {
                lastStick = now
                DebugLog.log("stick x=$x")
                playback.seekBy(if (x > 0) STEP_SEEK_MS else -STEP_SEEK_MS)
                return true
            }
        }
        return super.dispatchGenericMotionEvent(e)
    }

    private fun updateStatus() {
        ui.post {
            statusView?.text = playback.statusLine(title)
            playButton?.text = if (playback.isPlaying) "Pause" else "Play"
        }
    }
}

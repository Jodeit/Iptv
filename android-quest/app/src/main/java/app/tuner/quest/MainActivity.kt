package app.tuner.quest

import android.annotation.SuppressLint
import android.graphics.Color
import android.graphics.Typeface
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
import android.widget.Button
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
    private var screenWidth = 3.2f     // metres
    private var distance = 3.0f        // metres in front of the viewer
    private var screenY = 1.5f          // metres above the floor
    private var title = ""
    private var statusView: TextView? = null
    private var playPauseButton: Button? = null

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
            { UIPanelSettings(shape = QuadShapeOptions(width = 1.7f, height = 0.5f), display = DpPerMeterDisplayOptions(dpPerMeter = 600f)) },
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
        webEntity = Entity.createPanelEntity(PANEL_WEB, Transform(inFront(1.4f, 1.35f)), noRotation())
        controlsEntity = Entity.createPanelEntity(PANEL_CONTROLS, Transform(inFront(1.0f, 0.85f)), Visible(false), noRotation())
        DebugLog.log("entities created")
    }


    // Same layout as Meta's sample apps: the viewer is moved to z = VIEW_Z and turned around, so everything in front of
    // them sits at smaller z and an unrotated panel faces them.
    private fun inFront(dist: Float, y: Float, pitch: Float = 0f, x: Float = 0f, yaw: Float = 180f) =
        Pose(Vector3(x, y, VIEW_Z - dist), Quaternion(pitch, yaw, 0f))

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
        val pageUrl = intent?.getStringExtra("url")?.takeIf { it.startsWith("https://") } ?: BuildConfig.APP_URL
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
            Transform(inFront(distance, screenY)),
            noRotation(),
            // Free-floating picture: the frame is drawn fully transparent (the edges still work as grab and resize handles),
            // and the default 1.5 m resize limit is far too small for a screen.
            IsdkPanelGrabHandle(color = Vector4(0f, 0f, 0f, 0f)),
            // The grab/resize box defaults to 0.75 x 1 m, far smaller than the picture; make it the size of the screen.
            IsdkPanelDimensions(Vector2(screenWidth, screenWidth * 9f / 16f)),
            IsdkPanelResize(minDimensions = Vector2(0.8f, 0.45f), maxDimensions = Vector2(14f, 8f), preserveAspectRatio = true),
        )
        webEntity?.setComponent(Visible(false))
        controlsEntity?.setComponent(Visible(true))
        updateStatus()
    }

    private fun stopPlayback() {
        playback.stop()
        videoEntity?.destroy()
        videoEntity = null
        controlsEntity?.setComponent(Visible(false))
        webEntity?.setComponent(Visible(true))
        web?.evaluateJavascript("document.dispatchEvent(new Event('questStopped'))", null)
    }

    private fun moveScreen() {
        videoEntity?.setComponent(Transform(inFront(distance, screenY)))
    }

    // ---------- Controls ----------

    private fun makeControls(ctx: android.content.Context): View {
        fun btn(label: String, onClick: () -> Unit) = Button(ctx).apply {
            text = label; textSize = 20f; isAllCaps = false; setOnClickListener { onClick() }
        }
        val status = TextView(ctx).apply { setTextColor(Color.WHITE); textSize = 22f; typeface = Typeface.DEFAULT_BOLD; gravity = Gravity.CENTER; setPadding(16, 12, 16, 4) }
        statusView = status
        val pp = btn("Pause") { playback.togglePause() }
        playPauseButton = pp
        val row1 = LinearLayout(ctx).apply {
            gravity = Gravity.CENTER
            addView(btn("⏪ 10s") { playback.seekBy(-STEP_SEEK_MS) })
            addView(pp)
            addView(btn("10s ⏩") { playback.seekBy(STEP_SEEK_MS) })
            addView(btn("Stop") { stopPlayback() })
            addView(btn("Browse") { webEntity?.setComponent(Visible(true)) })
            addView(btn("Hide browser") { webEntity?.setComponent(Visible(false)) })
        }
        val modeBtn = btn("Mode: $stereoLabel") {}
        modeBtn.setOnClickListener {
            setStereo(when (stereo) { StereoMode.None -> StereoMode.LeftRight; StereoMode.LeftRight -> StereoMode.UpDown; else -> StereoMode.None })
            modeBtn.text = "Mode: $stereoLabel"
            if (videoEntity != null) showPlayer()
        }
        val ptBtn = btn(if (passthrough) "Passthrough: on" else "Passthrough: off") {}
        ptBtn.setOnClickListener {
            passthrough = !passthrough
            ptBtn.text = if (passthrough) "Passthrough: on" else "Passthrough: off"
            applyPassthrough()
        }
        val row2 = LinearLayout(ctx).apply {
            gravity = Gravity.CENTER
            addView(ptBtn)
            addView(modeBtn)
            addView(btn("Smaller") { screenWidth = (screenWidth * 0.85f).coerceAtLeast(1f); if (videoEntity != null) showPlayer() })
            addView(btn("Larger") { screenWidth = (screenWidth * 1.18f).coerceAtMost(12f); if (videoEntity != null) showPlayer() })
            addView(btn("Closer") { distance = (distance - 0.5f).coerceAtLeast(1f); moveScreen() })
            addView(btn("Farther") { distance = (distance + 0.5f).coerceAtMost(15f); moveScreen() })
            addView(btn("Up") { screenY += 0.2f; moveScreen() })
            addView(btn("Down") { screenY = (screenY - 0.2f).coerceAtLeast(0.2f); moveScreen() })
        }
        return LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.argb(230, 16, 16, 20))
            addView(status); addView(row1); addView(row2)
        }
    }

    private fun updateStatus() {
        ui.post {
            statusView?.text = playback.statusLine(title)
            playPauseButton?.text = if (playback.isPlaying) "Pause" else "Play"
        }
    }
}

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
import com.meta.spatial.core.SpatialFeature
import com.meta.spatial.core.Vector3
import com.meta.spatial.runtime.ReferenceSpace
import com.meta.spatial.runtime.StereoMode
import com.meta.spatial.toolkit.AppSystemActivity
import com.meta.spatial.toolkit.DpPerMeterDisplayOptions
import com.meta.spatial.toolkit.MediaPanelRenderOptions
import com.meta.spatial.toolkit.MediaPanelSettings
import com.meta.spatial.toolkit.Panel
import com.meta.spatial.toolkit.PanelRegistration
import com.meta.spatial.toolkit.PixelDisplayOptions
import com.meta.spatial.toolkit.QuadShapeOptions
import com.meta.spatial.toolkit.Transform
import com.meta.spatial.toolkit.UIPanelSettings
import com.meta.spatial.toolkit.ViewPanelRegistration
import com.meta.spatial.toolkit.VideoSurfacePanelRegistration
import com.meta.spatial.toolkit.Visible
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
        playback = Playback(this, onState = { updateStatus() })
        super.onCreate(savedInstanceState)
    }

    override fun registerPanels(): List<PanelRegistration> = listOf(
        ViewPanelRegistration(
            PANEL_WEB,
            { _, ctx -> makeWeb(ctx) },
            { UIPanelSettings(shape = QuadShapeOptions(width = 1.8f, height = 1.1f), display = DpPerMeterDisplayOptions(dpPerMeter = 650f)) },
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
    )

    override fun onSceneReady() {
        super.onSceneReady()
        scene.setReferenceSpace(ReferenceSpace.LOCAL_FLOOR)
        applyPassthrough()
        webEntity = Entity.create(Panel(PANEL_WEB), Transform(Pose(Vector3(0f, 1.35f, -1.4f), Quaternion())))
        controlsEntity = Entity.create(Panel(PANEL_CONTROLS), Transform(Pose(Vector3(0f, 0.6f, -1.2f), Quaternion(-25f, 0f, 0f))), Visible(false))
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
        w.addJavascriptInterface(Bridge(), "TunerQuest")
        w.webViewClient = object : WebViewClient() {}
        w.webChromeClient = WebChromeClient()
        w.loadUrl(BuildConfig.APP_URL)
        return w
    }

    /** What the page can call. Runs on a WebView thread: hop to the UI thread for anything that touches the player. */
    inner class Bridge {
        /** {urls: [..], title, live, startAt (seconds), mode: "mono"|"xr3d"|"sbs"|"tab"} */
        @JavascriptInterface
        fun play(json: String) {
            val o = JSONObject(json)
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
        videoEntity = Entity.create(Panel(PANEL_VIDEO), Transform(Pose(Vector3(0f, screenY, -distance), Quaternion())))
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
        videoEntity?.setComponent(Transform(Pose(Vector3(0f, screenY, -distance), Quaternion())))
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

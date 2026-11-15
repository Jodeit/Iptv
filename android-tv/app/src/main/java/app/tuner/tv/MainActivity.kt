package app.tuner.tv

import android.annotation.SuppressLint
import android.app.Activity
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout

/**
 * Full-screen WebView around the hosted Tuner page. The page detects the "TunerTV" user-agent
 * token and switches on its remote-control mode (js/tv.js). This class only has to:
 *  - keep the screen on and the video fullscreen,
 *  - let video autoplay and HTML5 fullscreen work,
 *  - forward media keys and Back to the page.
 */
class MainActivity : Activity() {
    private companion object { val PLASTER = Color.parseColor("#EBDFB8") }

    private lateinit var web: WebView
    private lateinit var root: FrameLayout
    private var customView: View? = null
    private var customViewCallback: WebChromeClient.CustomViewCallback? = null
    private var failed = false

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        root = FrameLayout(this).apply { setBackgroundColor(PLASTER) }
        web = WebView(this).apply {
            setBackgroundColor(PLASTER) // until the page paints (the page itself is black behind a playing picture)
            isFocusable = true
            isFocusableInTouchMode = true
        }
        root.addView(web, ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        setContentView(root)

        with(web.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW // plain-http streams
            loadWithOverviewMode = true
            userAgentString = "$userAgentString TunerTV"
        }
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)

        val appHost = Uri.parse(BuildConfig.APP_URL).host
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                // Stay on the app's own origin; there is no browser to hand other links to.
                return request.url.host != appHost && request.isForMainFrame
            }

            // The audio decoder is bundled in the APK: answer requests for it from there instead of the network
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                val u = request.url
                val path = u.path ?: ""
                if (request.method == "GET" && u.host == Uri.parse(BuildConfig.APP_URL).host && path.startsWith("/decoder/")) {
                    try {
                        val mime = if (path.endsWith(".js")) "text/javascript" else "application/octet-stream"
                        val headers = mapOf("Access-Control-Allow-Origin" to "*", "Cache-Control" to "public, max-age=31536000")
                        return WebResourceResponse(mime, null, 200, "OK", headers, assets.open(path.removePrefix("/")))
                    } catch (e: Exception) { /* not bundled: fall through to the network */ }
                }
                return super.shouldInterceptRequest(view, request)
            }

            override fun onPageFinished(view: WebView, url: String) {
                if (!failed) view.requestFocus()
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (!request.isForMainFrame) return
                failed = true
                view.loadDataWithBaseURL(
                    null,
                    "<body style='background:#000;color:#ddd;font:32px sans-serif;text-align:center;padding-top:20%'>" +
                        "Can't reach ${BuildConfig.APP_URL}<br><small>Check the network, then press OK to retry.</small></body>",
                    "text/html", "utf-8", null
                )
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onShowCustomView(view: View, callback: CustomViewCallback) {
                customView?.let { onHideCustomView() }
                customView = view
                customViewCallback = callback
                root.addView(view, ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
                web.visibility = View.GONE
                root.setBackgroundColor(Color.BLACK) // letterbox bars around a fullscreen video are black
            }

            override fun onHideCustomView() {
                customView?.let { root.removeView(it) }
                customView = null
                customViewCallback?.onCustomViewHidden()
                customViewCallback = null
                web.visibility = View.VISIBLE
                root.setBackgroundColor(PLASTER)
                web.requestFocus()
            }

            override fun onConsoleMessage(m: ConsoleMessage): Boolean = true
        }

        if (savedInstanceState != null) web.restoreState(savedInstanceState) else web.loadUrl(BuildConfig.APP_URL)
    }

    private fun js(code: String) = web.evaluateJavascript(code, null)

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        if (failed && (keyCode == KeyEvent.KEYCODE_DPAD_CENTER || keyCode == KeyEvent.KEYCODE_ENTER)) {
            failed = false
            web.loadUrl(BuildConfig.APP_URL)
            return true
        }
        val action = when (keyCode) {
            KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE -> "playpause"
            KeyEvent.KEYCODE_MEDIA_PLAY -> "play"
            KeyEvent.KEYCODE_MEDIA_PAUSE -> "pause"
            KeyEvent.KEYCODE_MEDIA_NEXT -> "next"
            KeyEvent.KEYCODE_MEDIA_PREVIOUS -> "prev"
            KeyEvent.KEYCODE_MEDIA_FAST_FORWARD -> "ff"
            KeyEvent.KEYCODE_MEDIA_REWIND -> "rw"
            else -> null
        }
        if (action != null) {
            js("window.tunerTV && window.tunerTV.key('$action')")
            return true
        }
        if (keyCode == KeyEvent.KEYCODE_BACK && event.repeatCount == 0) {
            if (customView != null) { web.webChromeClient?.onHideCustomView(); return true }
            // Close a panel / guide / gallery if one is open; otherwise leave the app.
            web.evaluateJavascript("window.tunerTV ? window.tunerTV.back() : false") { used ->
                if (used != "true") finish()
            }
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    override fun onResume() { super.onResume(); web.onResume() }
    override fun onPause() { web.onPause(); super.onPause() }
    override fun onDestroy() { web.destroy(); super.onDestroy() }
}

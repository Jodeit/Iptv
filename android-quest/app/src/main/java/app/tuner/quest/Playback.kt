package app.tuner.quest

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.view.Surface
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory

/**
 * ExoPlayer wrapper. Streams go straight from the provider (no CORS proxy, so none of its overhead). Several URLs
 * for one channel are tried in order when one fails. Extension audio decoders (FFmpeg) are preferred only when the
 * device has no decoder for the format, so normal AAC stays on the hardware path.
 */
class Playback(private val ctx: Context, private val onState: () -> Unit) {
    private val main = Handler(Looper.getMainLooper())
    private var player: ExoPlayer? = null
    private var surface: Surface? = null
    private var urls: List<String> = emptyList()
    private var index = 0
    private var live = false
    private var startAt = 0L
    private var error: String? = null

    val isPlaying get() = player?.playWhenReady == true

    private fun ensure(): ExoPlayer = player ?: run {
        val http = DefaultHttpDataSource.Factory()
            .setUserAgent("Tuner/Quest")
            .setAllowCrossProtocolRedirects(true)
            .setConnectTimeoutMs(15_000)
            .setReadTimeoutMs(20_000)
        val load = DefaultLoadControl.Builder()
            // A little more headroom than the default: IPTV servers stall, and the headset has the memory for it.
            .setBufferDurationsMs(20_000, 60_000, 2_500, 5_000)
            .build()
        val renderers = DefaultRenderersFactory(ctx)
            .setExtensionRendererMode(DefaultRenderersFactory.EXTENSION_RENDERER_MODE_ON)
            .setEnableDecoderFallback(true)
        ExoPlayer.Builder(ctx, renderers)
            .setMediaSourceFactory(DefaultMediaSourceFactory(http))
            .setLoadControl(load)
            .build().also { p ->
                p.setVideoSurface(surface)
                p.addListener(object : Player.Listener {
                    override fun onPlayerError(e: PlaybackException) {
                        DebugLog.log("player error ${e.errorCodeName} on ${urls.getOrNull(index)?.substringBefore('?')}: ${e.cause}")
                        if (index + 1 < urls.size) { index++; start() } else { error = e.errorCodeName; onState() }
                    }
                    override fun onPlaybackStateChanged(state: Int) = onState()
                    override fun onIsPlayingChanged(isPlaying: Boolean) = onState()
                })
                player = p
                tick()
            }
    }

    fun play(urls: List<String>, live: Boolean, startAtMs: Long) {
        this.urls = urls; this.live = live; this.startAt = startAtMs; index = 0; error = null
        start()
    }

    private fun start() {
        val p = ensure()
        val url = urls[index]
        val item = MediaItem.Builder().setUri(url).apply {
            // Extension-less Xtream live URLs are MPEG-TS; say so rather than let it guess.
            if (live && !Regex("\\.(m3u8|ts|mp4|mkv)(\\?|$)", RegexOption.IGNORE_CASE).containsMatchIn(url)) setMimeType(MimeTypes.VIDEO_MP2T)
        }.build()
        p.setMediaItem(item, if (live || startAt <= 0) C.TIME_UNSET else startAt)
        p.prepare()
        p.playWhenReady = true
        onState()
    }

    fun setSurface(s: Surface) { surface = s; player?.setVideoSurface(s) }
    fun clearSurface() { surface = null; player?.clearVideoSurface() }
    fun togglePause() { player?.let { it.playWhenReady = !it.playWhenReady }; onState() }
    fun seekBy(ms: Long) { player?.let { if (!live) it.seekTo((it.currentPosition + ms).coerceAtLeast(0)) } }
    fun stop() { player?.stop(); player?.clearMediaItems(); urls = emptyList() }

    fun release() { player?.release(); player = null }

    fun statusLine(title: String): String {
        val p = player ?: return title
        error?.let { return "$title · can't play this ($it)" }
        val state = when (p.playbackState) { Player.STATE_BUFFERING -> "buffering…"; Player.STATE_ENDED -> "ended"; else -> if (live) "live" else fmt(p.currentPosition) + " / " + fmt(p.duration) }
        val v = p.videoFormat
        val codec = v?.sampleMimeType?.substringAfter('/')?.uppercase().orEmpty()
        val size = if (v != null && v.height > 0) " · ${v.height}p $codec" else ""
        return "$title · $state$size"
    }

    private fun fmt(ms: Long): String {
        if (ms < 0 || ms == C.TIME_UNSET) return "--:--"
        val s = ms / 1000
        return if (s >= 3600) "%d:%02d:%02d".format(s / 3600, s / 60 % 60, s % 60) else "%d:%02d".format(s / 60, s % 60)
    }

    private fun tick() { onState(); main.postDelayed({ if (player != null) tick() }, 1000) }
}

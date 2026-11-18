package app.tuner.quest

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.provider.MediaStore
import android.util.Log

/**
 * Headsets without a computer attached have no logcat, so events are also written to Downloads/tuner-quest-log.txt
 * (open it in the Quest's Files app). The whole file is rewritten on each event, so it survives a crash.
 */
object DebugLog {
    private const val NAME = "tuner-quest-log.txt"
    private val text = StringBuilder()
    private var ctx: Context? = null
    private var uri: Uri? = null

    fun init(c: Context) {
        ctx = c.applicationContext
        text.setLength(0)
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { t, e ->
            log("CRASH on thread ${t.name}: ${Log.getStackTraceString(e)}")
            previous?.uncaughtException(t, e)
        }
        log("start ${BuildConfig.VERSION_NAME} sdk=${android.os.Build.VERSION.SDK_INT} device=${android.os.Build.MODEL} url=${BuildConfig.APP_URL}")
    }

    @Synchronized
    fun log(msg: String) {
        Log.i("TunerQuest", msg)
        text.append(java.text.SimpleDateFormat("HH:mm:ss.SSS", java.util.Locale.US).format(java.util.Date())).append(' ').append(msg).append('\n')
        flush()
    }

    private fun flush() {
        val c = ctx ?: return
        try {
            val r = c.contentResolver
            val target = uri ?: run {
                val base = MediaStore.Downloads.EXTERNAL_CONTENT_URI
                r.query(base, arrayOf(MediaStore.Downloads._ID), "${MediaStore.Downloads.DISPLAY_NAME}=?", arrayOf(NAME), null)?.use { q ->
                    if (q.moveToFirst()) android.content.ContentUris.withAppendedId(base, q.getLong(0)) else null
                } ?: r.insert(base, ContentValues().apply {
                    put(MediaStore.Downloads.DISPLAY_NAME, NAME)
                    put(MediaStore.Downloads.MIME_TYPE, "text/plain")
                    put(MediaStore.Downloads.RELATIVE_PATH, "Download")
                })
            } ?: return
            uri = target
            r.openOutputStream(target, "wt")?.use { it.write(text.toString().toByteArray()) }
        } catch (e: Throwable) {
            Log.w("TunerQuest", "log file: $e")
        }
    }
}

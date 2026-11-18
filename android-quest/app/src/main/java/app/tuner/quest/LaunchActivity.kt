package app.tuner.quest

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.widget.Toast

/**
 * Opens Tuner in Quest Browser and closes. WebXR (XR3D, immersive VR) only exists in the browser, not in an app's
 * WebView, so this is the whole app: a library icon for the page.
 */
class LaunchActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val view = Intent(Intent.ACTION_VIEW, Uri.parse(BuildConfig.APP_URL)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            startActivity(Intent(view).setPackage("com.oculus.browser"))
        } catch (_: ActivityNotFoundException) {
            try {
                startActivity(view)
            } catch (_: ActivityNotFoundException) {
                Toast.makeText(this, "No browser found. Open ${BuildConfig.APP_URL} in Quest Browser.", Toast.LENGTH_LONG).show()
            }
        }
        finish()
    }
}

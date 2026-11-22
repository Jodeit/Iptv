plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "app.tuner.tv"
    compileSdk = 34

    defaultConfig {
        applicationId = "app.tuner.tv"
        minSdk = 21
        targetSdk = 34
        versionCode = 1
        versionName = "0.2.0"
        val url = (project.findProperty("appUrl") as String).trimEnd('/') + "/"
        buildConfigField("String", "APP_URL", "\"$url\"")
    }

    buildFeatures { buildConfig = true }

    // The audio decoder (decoder/ at the repo root: FFmpeg built for WebAssembly, ~32 MB) ships inside the APK, so the
    // TV never has to download it. The app serves it to the page itself (see MainActivity.shouldInterceptRequest).
    val bundled = layout.buildDirectory.dir("generated/bundled-assets")
    val copyDecoder = tasks.register<Copy>("copyDecoder") {
        from(rootProject.file("../decoder"))
        into(bundled.map { it.dir("decoder") })
    }
    sourceSets.getByName("main").assets.srcDir(files(bundled).builtBy(copyDecoder))

    // Release builds are signed with a key that lives outside the repo, so a new APK installs over the old one.
    // CI decodes it from the TUNER_KEYSTORE_B64 secret; locally it defaults to ~/.tuner-signing/tuner.keystore.
    // Set TUNER_KEYSTORE / TUNER_KEY_PASSWORD (env or -P) to point elsewhere. Without the key, release builds fall
    // back to the debug key, which won't install over a build signed with the real key.
    val keystore = file((project.findProperty("TUNER_KEYSTORE") ?: System.getenv("TUNER_KEYSTORE")
        ?: "${System.getProperty("user.home")}/.tuner-signing/tuner.keystore") as String)
    val tunerPassword = (project.findProperty("TUNER_KEY_PASSWORD") ?: System.getenv("TUNER_KEY_PASSWORD")
        ?: keystore.resolveSibling("password.txt").takeIf { it.exists() }?.readText()?.trim()) as String?
    val signed = keystore.exists() && tunerPassword != null
    signingConfigs {
        create("tuner") {
            if (signed) {
                storeFile = keystore
                storePassword = tunerPassword
                keyAlias = "tuner"
                keyPassword = tunerPassword
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName(if (signed) "tuner" else "debug")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

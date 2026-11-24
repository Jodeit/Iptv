plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("com.meta.spatial.plugin")
}

android {
    namespace = "app.tuner.quest"
    compileSdk = 35

    defaultConfig {
        applicationId = "app.tuner.quest"
        minSdk = 34
        targetSdk = 34
        versionCode = 4
        versionName = "0.4.0"
        val url = (project.findProperty("appUrl") as String? ?: "https://iptv.jodeit.workers.dev").trimEnd('/') + "/"
        buildConfigField("String", "APP_URL", "\"$url\"")
        ndk { abiFilters += "arm64-v8a" }
    }

    buildFeatures { buildConfig = true }

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
    packaging { jniLibs { useLegacyPackaging = true } }
}

val spatial = "0.15.0"
val media3 = "1.9.0"

dependencies {
    implementation("com.meta.spatial:meta-spatial-sdk:$spatial")
    implementation("com.meta.spatial:meta-spatial-sdk-toolkit:$spatial")
    implementation("com.meta.spatial:meta-spatial-sdk-vr:$spatial")

    implementation("androidx.media3:media3-exoplayer:$media3")
    implementation("androidx.media3:media3-exoplayer-hls:$media3")
    implementation("androidx.media3:media3-datasource:$media3")
    // FFmpeg audio decoders (AC-3, E-AC-3, DTS, TrueHD, ...) that the Quest has no hardware decoder for.
    implementation("org.jellyfin.media3:media3-ffmpeg-decoder:$media3+1")
}

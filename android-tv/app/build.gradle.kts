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

    // One fixed key for every build (here, on a laptop, or on CI), so a new APK installs over the old one on the TV
    // without uninstalling first. This is a sideloaded personal app, not a published one, so the key lives in the repo
    // (a private one): do not reuse it for anything else.
    signingConfigs {
        create("tuner") {
            storeFile = file("../tuner.keystore")
            storePassword = "JgwFIl83JRMwUMXGvvAD"
            keyAlias = "tuner"
            keyPassword = "JgwFIl83JRMwUMXGvvAD"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("tuner")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

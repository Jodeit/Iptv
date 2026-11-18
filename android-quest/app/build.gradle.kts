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
        minSdk = 29
        targetSdk = 34
        versionCode = 2
        versionName = "0.2.0"
        val url = (project.findProperty("appUrl") as String? ?: "https://iptv.jodeit.workers.dev").trimEnd('/') + "/"
        buildConfigField("String", "APP_URL", "\"$url\"")
        ndk { abiFilters += "arm64-v8a" }
    }

    buildFeatures { buildConfig = true }

    // Same fixed key as the TV app: a personal sideloaded build, so updates install over the old one.
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

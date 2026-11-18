plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "app.tuner.quest"
    compileSdk = 34

    defaultConfig {
        applicationId = "app.tuner.quest"
        minSdk = 29
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"
        val url = (project.findProperty("appUrl") as String? ?: "https://iptv.jodeit.workers.dev").trimEnd('/') + "/"
        buildConfigField("String", "APP_URL", "\"$url\"")
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
}

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

    buildTypes {
        // Debug-signed on purpose: this is sideloaded, not published.
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("debug")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

import java.util.Properties

plugins {
    id("com.android.application")
    id("kotlin-android")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

val keyProperties = Properties()
val keyPropertiesFile = rootProject.file("key.properties")
if (keyPropertiesFile.exists()) {
    keyProperties.load(keyPropertiesFile.inputStream())
}

val releaseApplicationId =
    (keyProperties.getProperty("applicationId") ?: "com.voice2text.app").trim()

val hasReleaseSigning =
    keyPropertiesFile.exists() &&
        keyProperties.getProperty("storeFile")?.isNotBlank() == true &&
        keyProperties.getProperty("storePassword")?.isNotBlank() == true &&
        keyProperties.getProperty("keyAlias")?.isNotBlank() == true &&
        keyProperties.getProperty("keyPassword")?.isNotBlank() == true

android {
    namespace = "com.voice2text.app"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = JavaVersion.VERSION_17.toString()
    }

    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                storeFile = file(keyProperties.getProperty("storeFile"))
                storePassword = keyProperties.getProperty("storePassword")
                keyAlias = keyProperties.getProperty("keyAlias")
                keyPassword = keyProperties.getProperty("keyPassword")
            }
        }
    }

    defaultConfig {
        applicationId = releaseApplicationId
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    buildTypes {
        release {
            signingConfig =
                if (hasReleaseSigning) {
                    signingConfigs.getByName("release")
                } else {
                    // Fallback to debug signing for local release testing only.
                    signingConfigs.getByName("debug")
                }
        }
    }

    sourceSets {
        getByName("debug") {
            java.srcDir("../../benchmark/android/src/debug/kotlin")
        }
    }
}


dependencies {
    implementation(files("libs/sherpa-onnx.aar"))
}

flutter {
    source = "../.."
}

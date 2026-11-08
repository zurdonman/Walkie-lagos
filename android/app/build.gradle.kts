plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.walkielagos.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.walkielagos.app"
        minSdk = 26
        targetSdk = 35
        versionCode = 7
        versionName = "1.6"
    }

    // Clave propia para que las actualizaciones se instalen encima (con dos claves
    // distintas Android obliga a desinstalar). La acción de GitHub deja el archivo en
    // la ruta de la variable WALKIE_KEYSTORE; sin ella, se usa la clave de depuración.
    val keyStorePath: String? = System.getenv("WALKIE_KEYSTORE")
    signingConfigs {
        if (keyStorePath != null && file(keyStorePath).exists()) {
            create("walkie") {
                storeFile = file(keyStorePath)
                storeType = "pkcs12"
                storePassword = System.getenv("WALKIE_KEY_PASS") ?: "walkie2024"
                keyAlias = System.getenv("WALKIE_KEY_ALIAS") ?: "walkie"
                keyPassword = System.getenv("WALKIE_KEY_PASS") ?: "walkie2024"
                enableV1Signing = true
                enableV2Signing = true
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("walkie") ?: signingConfigs.getByName("debug")
        }
        debug {
            signingConfig = signingConfigs.findByName("walkie") ?: signingConfigs.getByName("debug")
        }
    }

    // Genera las clases Binding (ActivityMainBinding, ItemChatBinding) a partir de los layouts.
    buildFeatures {
        viewBinding = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    packaging {
        resources.excludes += setOf("META-INF/*.kotlin_module")
        jniLibs.useLegacyPackaging = true
    }

    // El modelo de voz son miles de archivos pequeños: si se comprimen, Android 11+
    // no puede abrirlos desde assets y la transcripción no arrancaría.
    androidResources {
        noCompress += listOf("mdl", "fst", "int", "txt", "conf", "dict", "symbols")
    }

    // El modelo de voz español (unos 40 MB) se copia a assets si está descargado;
    // si no, la app funciona igual, solo sin transcripción.
    sourceSets.getByName("main") {
        assets.srcDir("src/main/assets")
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.constraintlayout:constraintlayout:2.1.4")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    // Transcripción de voz a texto en el propio móvil, sin internet.
    implementation("com.alphacephei:vosk-android:0.3.47@aar") { isTransitive = true }
    // Vosk usa JNA por debajo; sin esto no resuelven sus tipos.
    implementation("net.java.dev.jna:jna:5.13.0@aar")
    testImplementation("junit:junit:4.13.2")
}

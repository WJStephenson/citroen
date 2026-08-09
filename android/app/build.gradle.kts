import java.util.Properties

plugins {
  id("com.android.application")
  id("org.jetbrains.kotlin.android")
}

/*
 * What the widget needs to reach the car, and what it authenticates with.
 *
 * None of it is in the repo. A desktop build reads android/secrets.properties
 * (git-ignored); CI reads the same keys from the environment, populated from
 * GitHub secrets — see .github/workflows/android.yml. A build with none of them
 * set still compiles and installs: the widget simply says it is not configured,
 * which is a better failure than a mysterious 403.
 *
 * The host is *not* here. It is a resource (res/values/config.xml) because the
 * TWA's intent filter and its asset-statement need it too, and one host in one
 * place is worth more than one fewer file.
 */
val secrets = Properties().apply {
  val file = rootProject.file("secrets.properties")
  if (file.exists()) file.inputStream().use { load(it) }
}

fun secret(key: String): String = secrets.getProperty(key) ?: System.getenv(key) ?: ""

/*
 * Release signing, for a key this repo never sees. Same rule as the secrets
 * above: a local keystore.properties, or CI's environment. Without either,
 * assembleRelease is simply not signed — `assembleDebug` still works, and
 * that is what a sideloaded build normally is.
 *
 * The key matters more than most: its SHA-256 fingerprint is what
 * assetlinks.json on citroen.knotworking.dev vouches for, so changing it means
 * re-publishing that file. See deploy/make-signing-key.sh.
 */
val keystoreProperties = Properties().apply {
  val file = rootProject.file("keystore.properties")
  if (file.exists()) file.inputStream().use { load(it) }
}

fun signing(key: String): String? =
  keystoreProperties.getProperty(key) ?: System.getenv(key)

android {
  namespace = "dev.knotworking.citroen"
  compileSdk = 35

  defaultConfig {
    applicationId = "dev.knotworking.citroen"
    // 26: the oldest release with adaptive icons and a modern JobScheduler,
    // which is what WorkManager wants under it.
    minSdk = 26
    targetSdk = 35
    versionCode = 1
    versionName = "1.0.0"

    buildConfigField("String", "VIN", "\"${secret("CITROEN_VIN")}\"")
    buildConfigField("String", "CF_ACCESS_CLIENT_ID", "\"${secret("CF_ACCESS_CLIENT_ID")}\"")
    buildConfigField("String", "CF_ACCESS_CLIENT_SECRET", "\"${secret("CF_ACCESS_CLIENT_SECRET")}\"")
  }

  signingConfigs {
    val storeFilePath = signing("KEYSTORE_FILE")
    if (storeFilePath != null && file(storeFilePath).exists()) {
      create("release") {
        storeFile = file(storeFilePath)
        storePassword = signing("KEYSTORE_PASSWORD")
        keyAlias = signing("KEY_ALIAS") ?: "citroen"
        keyPassword = signing("KEY_PASSWORD") ?: signing("KEYSTORE_PASSWORD")
      }
    }
  }

  buildTypes {
    release {
      isMinifyEnabled = true
      isShrinkResources = true
      proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
      signingConfig = signingConfigs.findByName("release")
    }
    debug {
      // So a debug build can sit alongside a release one while testing the
      // widget, rather than uninstalling to swap between them.
      applicationIdSuffix = ".debug"
      isMinifyEnabled = false
    }
  }

  buildFeatures {
    buildConfig = true
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }

  kotlinOptions {
    jvmTarget = "17"
  }

  sourceSets["main"].java.srcDirs("src/main/kotlin")
  sourceSets["test"].java.srcDirs("src/test/kotlin")
}

dependencies {
  // The TWA host: launches the PWA in Chrome without browser chrome, and
  // delegates its Web Push notifications so they arrive under this app's name.
  implementation("com.google.androidbrowserhelper:androidbrowserhelper:2.6.2")
  // The widget's refresh loop. Nothing else — the fetch is HttpURLConnection
  // and org.json, both in the platform, so there is no HTTP or JSON library
  // here to go stale.
  implementation("androidx.work:work-runtime-ktx:2.10.0")

  // The payload reader runs on the JVM — it touches no Android class, which is
  // the point of keeping it apart from the provider. Android stubs org.json in
  // unit tests, so the real one is supplied here.
  testImplementation("junit:junit:4.13.2")
  testImplementation("org.json:json:20240303")
}

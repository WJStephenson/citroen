/*
 * The Android wrapper: one APK holding the PWA and the home screen widget.
 *
 * `google()` here resolves through dl.google.com, which is where both the
 * Android Gradle Plugin and androidbrowserhelper live. Nothing else in this
 * repo needs it — the web app is built by Vite and knows nothing about any of
 * this.
 */

pluginManagement {
  repositories {
    google()
    mavenCentral()
    gradlePluginPortal()
  }
}

dependencyResolutionManagement {
  repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
  repositories {
    google()
    mavenCentral()
  }
}

rootProject.name = "citroen"
include(":app")

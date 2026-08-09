# WorkManager instantiates workers by class name, out of its own database, so
# nothing in the code references ChargeWorker's constructor and the shrinker
# would happily remove it.
-keep class * extends androidx.work.ListenableWorker {
    public <init>(android.content.Context, androidx.work.WorkerParameters);
}

# The TWA launcher and the notification delegation service are named in the
# manifest rather than in code. AGP keeps manifest-referenced classes, but
# these two arrive from a library and are the difference between an app that
# launches and one that crashes on the home screen, so they are pinned here
# rather than left to inference.
-keep class com.google.androidbrowserhelper.trusted.LauncherActivity { *; }
-keep class com.google.androidbrowserhelper.trusted.DelegationService { *; }

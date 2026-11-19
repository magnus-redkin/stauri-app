package com.magnus.stauri_app

import android.util.Log

/**
 * Native entry points called from Kotlin.
 *
 * Registered by signature from `JNI_OnLoad` in `credentials_android.rs`, so the class and
 * method names here must match the constants there. Every method returns a value instead of
 * throwing: a Java exception crosses JNI as `Java exception thrown`, which tells Rust
 * nothing about the cause.
 *
 * The password crosses JNI as a Java string, so a copy stays in the Java heap until the
 * garbage collector runs. That is the same exposure as the webview the password comes from;
 * the vault's job is to keep it out of reach at rest.
 */
object RustBridge {
    private const val TAG = "stauri"

    /**
     * Asks the system to unlock the phone.
     *
     * @return `true` when the prompt was launched; the answer is delivered by the JVM
     *   calling back into Rust through [credentialUnlocked].
     */
    external fun credentialUnlocked(granted: Boolean)

    /** Loads the Rust library, which registers the methods above. */
    fun ensureLoaded() {
        try {
            System.loadLibrary("tauri_app_lib")
        } catch (e: UnsatisfiedLinkError) {
            // Tauri loads it before the activity starts; reaching this means the build is
            // broken, and logging is all that can be done from here.
            Log.e(TAG, "credential: cannot load the Rust library", e)
        }
    }
}

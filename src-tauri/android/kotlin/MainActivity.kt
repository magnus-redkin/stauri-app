package com.magnus.stauri_app

import android.os.Bundle
import androidx.activity.enableEdgeToEdge

/**
 * Main activity.
 *
 * @remarks
 * Nothing beyond Tauri is wired here any more. The entry flow used to ask the Android
 * Keystore for the profile password, which needed an activity to show the system prompt
 * and to receive its result. The PIN the user sets now derives the key itself, so no
 * system prompt is involved and this class is plain again.
 */
class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }
}

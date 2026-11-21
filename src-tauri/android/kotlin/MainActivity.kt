package com.magnus.stauri_app

import android.os.Bundle
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

/**
 * Main activity.
 *
 * @remarks
 * The entry flow used to ask the Android Keystore for the profile password; the PIN the
 * user sets now derives the key itself, so nothing beyond Tauri is wired here any more.
 */
class MainActivity : TauriActivity() {
  /**
   * Keeps the content inside the safe area.
   *
   * @remarks
   * The activity is edge to edge, and Android 15 enforces that for any app with a recent
   * target SDK, so the window would otherwise draw under the status bar and the
   * navigation buttons — the bottom menu ended up behind them. `env(safe-area-inset-*)`
   * in CSS is not reported by every WebView build, and a fallback tuned for the gesture
   * pill is too small for a three-button bar.
   *
   * The inset is applied to the root view rather than to the WebView: the activity's
   * content layout consumes the insets before they reach the child, so a listener on the
   * WebView never sees anything but zeros. The area outside the padding is painted with
   * the window background.
   */
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    ViewCompat.setOnApplyWindowInsetsListener(window.decorView) { view, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
      )
      view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      insets
    }
  }
}

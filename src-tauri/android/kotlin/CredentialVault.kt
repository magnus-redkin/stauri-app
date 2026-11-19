package com.magnus.stauri_app

import android.app.Activity
import android.app.Application
import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import java.security.KeyStore
import java.security.UnrecoverableKeyException
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Keeps the profile password sealed under a key that the Android Keystore owns.
 *
 * The key material never leaves the keystore: this object only asks it to encrypt or
 * decrypt. A copy of the sealed blob on another phone is useless, because the key that
 * opens it is bound to this device and, once the screen lock is changed, gone for good.
 *
 * # Unlocking
 *
 * The key is created with a short validity window (`setUserAuthenticationValiditySeconds`)
 * rather than per-use authentication. The window opens when the user unlocks the phone and
 * closes again shortly after, which is what the plan asks for: the screen-lock PIN is
 * enough, no separate application PIN.
 *
 * `AUTH_DEVICE_CREDENTIAL` as a per-use parameter needs API 30 and a `CryptoObject` the
 * system does not reliably return for a PIN, so the window is used on every supported
 * version (minSdk 24). The trade-off is deliberate and stated in the plan: while the phone
 * is unlocked the password can be read without another prompt.
 *
 * # Answers are values, not exceptions
 *
 * Every method returns a string or a boolean. A thrown exception would cross JNI as
 * `Java exception thrown`, which tells the Rust side nothing about *why*; the calling
 * code needs to distinguish "unlock the phone" from "the key is gone".
 */
object CredentialVault {
    private const val TAG = "stauri"
    private const val KEYSTORE = "AndroidKeyStore"
    private const val KEY_ALIAS_PREFIX = "stauri-profile-"
    private const val TRANSFORMATION = "AES/GCM/NoPadding"
    private const val GCM_TAG_BITS = 128

    /** Reply prefix understood by `credentials_android.rs`. */
    private const val ERROR_PREFIX = "ERROR:"
    /** The phone must be unlocked before the key can be used. */
    private const val NEEDS_UNLOCK = "needs_unlock"
    /** The key was invalidated (screen lock changed) and nothing can open it. */
    private const val INVALIDATED = "invalidated"

    /**
     * How long after the phone is unlocked the key stays usable, in seconds.
     *
     * Long enough to unlock and land on the profile list; short enough that an unattended,
     * already-unlocked phone does not hand the password to whoever picks it up.
     */
    private const val AUTH_VALIDITY_SECONDS = 30

    /** Request code used by [requestUnlock]; `MainActivity` matches on it. */
    const val UNLOCK_REQUEST = 4711

    /**
     * Application context, needed only for the screen-lock question.
     *
     * Set from [MainActivity] before anything else runs; the keystore work itself needs no
     * context at all.
     */
    @Volatile
    private var appContext: Context? = null

    /** Activity that can show the system prompt, tracked by [track]. */
    @Volatile
    private var currentActivity: Activity? = null

    /** Stores the context used by [hasScreenLock]. */
    @JvmStatic
    fun attach(context: Context) {
        appContext = context.applicationContext ?: context
    }

    /**
     * Registers this object as an activity lifecycle callback.
     *
     * The unlock prompt is a system activity, and only an activity can start one. Tracking
     * the live one avoids holding a reference after it is destroyed.
     */
    @JvmStatic
    fun install(application: Application) {
        attach(application)
        application.registerActivityLifecycleCallbacks(object :
            Application.ActivityLifecycleCallbacks {
            override fun onActivityResumed(activity: Activity) {
                currentActivity = activity
            }

            override fun onActivityPaused(activity: Activity) {
                if (currentActivity === activity) currentActivity = null
            }

            override fun onActivityCreated(activity: Activity, state: Bundle?) {}
            override fun onActivityStarted(activity: Activity) {}
            override fun onActivityStopped(activity: Activity) {}
            override fun onActivitySaveInstanceState(activity: Activity, state: Bundle) {}
            override fun onActivityDestroyed(activity: Activity) {
                if (currentActivity === activity) currentActivity = null
            }
        })
    }

    /**
     * Seals a password for one profile.
     *
     * @return `v1:<iv>:<ciphertext>`, or `ERROR:<tag>:<message>`.
     */
    @JvmStatic
    @Synchronized
    fun seal(keyUid: String, plaintext: String): String = try {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, keyFor(keyUid))
        val body = cipher.doFinal(plaintext.toByteArray(Charsets.UTF_8))
        "v1:${Base64.encodeToString(cipher.iv, Base64.NO_WRAP)}:" +
            Base64.encodeToString(body, Base64.NO_WRAP)
    } catch (e: Exception) {
        failure(e)
    }

    /**
     * Opens a blob produced by [seal].
     *
     * @return the password, or `ERROR:<tag>:<message>`.
     */
    @JvmStatic
    @Synchronized
    fun open(keyUid: String, sealed: String): String = try {
        val parts = sealed.split(":")
        // A blob from a newer format must fail loudly rather than be parsed as garbage.
        require(parts.size == 3 && parts[0] == "v1") { "unknown sealed format" }
        val iv = Base64.decode(parts[1], Base64.NO_WRAP)
        val body = Base64.decode(parts[2], Base64.NO_WRAP)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, keyFor(keyUid), GCMParameterSpec(GCM_TAG_BITS, iv))
        String(cipher.doFinal(body), Charsets.UTF_8)
    } catch (e: Exception) {
        failure(e)
    }

    /** Whether a key already exists for this profile. Needs no authentication. */
    @JvmStatic
    @Synchronized
    fun hasKey(keyUid: String): Boolean = try {
        keyStore().containsAlias(aliasOf(keyUid))
    } catch (e: Exception) {
        Log.w(TAG, "credential: hasKey failed", e)
        false
    }

    /** Drops the key of a profile, so the stored password can never be opened again. */
    @JvmStatic
    @Synchronized
    fun forget(keyUid: String) {
        try {
            keyStore().deleteEntry(aliasOf(keyUid))
        } catch (e: Exception) {
            Log.w(TAG, "credential: cannot delete key", e)
        }
    }

    /**
     * Whether the phone has a screen lock at all.
     *
     * Without one the scheme cannot work: a key that requires authentication could never
     * be used, and `createConfirmDeviceCredentialIntent` returns `null`.
     */
    @JvmStatic
    fun hasScreenLock(): Boolean {
        val context = appContext ?: return false
        val manager = context.getSystemService(Context.KEYGUARD_SERVICE) as? KeyguardManager
            ?: return false
        return manager.isKeyguardSecure
    }

    /**
     * Shows the system prompt that unlocks the phone.
     *
     * @return `true` when the prompt was launched. The answer arrives in
     *   [onUnlockResult], not here: the prompt is an activity that finishes later.
     */
    @JvmStatic
    fun requestUnlock(): Boolean {
        val activity = currentActivity ?: return false
        val manager = activity.getSystemService(Context.KEYGUARD_SERVICE) as? KeyguardManager
            ?: return false
        if (!manager.isKeyguardSecure) return false
        val intent: Intent = manager.createConfirmDeviceCredentialIntent(
            activity.getString(R.string.app_name),
            activity.getString(R.string.unlock_to_open_profile)
        ) ?: return false
        @Suppress("DEPRECATION")
        activity.startActivityForResult(intent, UNLOCK_REQUEST)
        return true
    }

    /** Handles the result of [requestUnlock] in the activity that started it. */
    @JvmStatic
    fun onUnlockResult(requestCode: Int, resultCode: Int) {
        if (requestCode != UNLOCK_REQUEST) return
        RustBridge.credentialUnlocked(resultCode == Activity.RESULT_OK)
    }

    private fun aliasOf(keyUid: String): String = "$KEY_ALIAS_PREFIX$keyUid"

    private fun keyStore(): KeyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }

    /**
     * Returns the profile's key, creating it on first use.
     *
     * Creation also requires the phone to be unlocked, which is why [seal] can answer
     * `needs_unlock` on a freshly installed application too.
     */
    private fun keyFor(keyUid: String): SecretKey {
        val alias = aliasOf(keyUid)
        val existing = try {
            keyStore().getEntry(alias, null) as? KeyStore.SecretKeyEntry
        } catch (e: UnrecoverableKeyException) {
            // The entry is there but the key behind it is gone: re-creating it would make
            // the stored blob permanently unreadable, so report it instead.
            throw e
        }
        existing?.let { return it.secretKey }

        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        val builder = KeyGenParameterSpec.Builder(
            alias,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            // The password may be used only shortly after the phone was unlocked: that is
            // the whole point of "the PIN protects it".
            .setUserAuthenticationRequired(true)
            // Re-enrolling a fingerprint must not destroy the profile: the screen lock,
            // not the biometric set, is what guards the key here.
            .setInvalidatedByBiometricEnrollment(false)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            builder.setUserAuthenticationParameters(
                AUTH_VALIDITY_SECONDS,
                KeyProperties.AUTH_DEVICE_CREDENTIAL
            )
        } else {
            @Suppress("DEPRECATION")
            builder.setUserAuthenticationValidityDurationSeconds(AUTH_VALIDITY_SECONDS)
        }

        generator.init(builder.build())
        return generator.generateKey()
    }

    /**
     * Turns a keystore exception into the `ERROR:` reply.
     *
     * The two cases the Rust side acts on are separated by name rather than by message
     * text, which is not stable across Android versions.
     */
    private fun failure(e: Exception): String {
        val name = e.javaClass.name
        return when {
            name.contains("UserNotAuthenticated") ->
                "$ERROR_PREFIX$NEEDS_UNLOCK:$name"
            name.contains("KeyPermanentlyInvalidated") ||
                name.contains("UnrecoverableKey") ||
                name.contains("InvalidKey") ->
                "$ERROR_PREFIX$INVALIDATED:$name"
            else -> "$ERROR_PREFIX:failed:${e.message ?: name}"
        }
    }
}

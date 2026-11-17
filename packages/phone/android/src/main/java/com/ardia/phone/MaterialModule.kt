package com.ardia.phone

import android.app.WallpaperColors
import android.app.WallpaperManager
import android.content.ComponentCallbacks
import android.content.Context
import android.content.res.Configuration
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

internal object MaterialScheme {
    val dynamic: Boolean get() = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S

    fun hex(color: Color): String = String.format("#%06X", color.toArgb() and 0xFFFFFF)

    fun roles(scheme: ColorScheme): Map<String, String> = linkedMapOf(
        "primary" to hex(scheme.primary),
        "onPrimary" to hex(scheme.onPrimary),
        "primaryContainer" to hex(scheme.primaryContainer),
        "onPrimaryContainer" to hex(scheme.onPrimaryContainer),
        "inversePrimary" to hex(scheme.inversePrimary),
        "secondary" to hex(scheme.secondary),
        "onSecondary" to hex(scheme.onSecondary),
        "secondaryContainer" to hex(scheme.secondaryContainer),
        "onSecondaryContainer" to hex(scheme.onSecondaryContainer),
        "tertiary" to hex(scheme.tertiary),
        "onTertiary" to hex(scheme.onTertiary),
        "tertiaryContainer" to hex(scheme.tertiaryContainer),
        "onTertiaryContainer" to hex(scheme.onTertiaryContainer),
        "background" to hex(scheme.background),
        "onBackground" to hex(scheme.onBackground),
        "surface" to hex(scheme.surface),
        "onSurface" to hex(scheme.onSurface),
        "surfaceVariant" to hex(scheme.surfaceVariant),
        "onSurfaceVariant" to hex(scheme.onSurfaceVariant),
        "surfaceTint" to hex(scheme.surfaceTint),
        "surfaceBright" to hex(scheme.surfaceBright),
        "surfaceDim" to hex(scheme.surfaceDim),
        "surfaceContainer" to hex(scheme.surfaceContainer),
        "surfaceContainerHigh" to hex(scheme.surfaceContainerHigh),
        "surfaceContainerHighest" to hex(scheme.surfaceContainerHighest),
        "surfaceContainerLow" to hex(scheme.surfaceContainerLow),
        "surfaceContainerLowest" to hex(scheme.surfaceContainerLowest),
        "inverseSurface" to hex(scheme.inverseSurface),
        "inverseOnSurface" to hex(scheme.inverseOnSurface),
        "error" to hex(scheme.error),
        "onError" to hex(scheme.onError),
        "errorContainer" to hex(scheme.errorContainer),
        "onErrorContainer" to hex(scheme.onErrorContainer),
        "outline" to hex(scheme.outline),
        "outlineVariant" to hex(scheme.outlineVariant),
        "scrim" to hex(scheme.scrim),
    )

    fun of(context: Context): Map<String, Map<String, String>>? {
        if (!dynamic) return null
        return mapOf("light" to roles(dynamicLightColorScheme(context)), "dark" to roles(dynamicDarkColorScheme(context)))
    }

    fun nightOf(configuration: Configuration): Int = configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK
}

class MaterialModule : Module() {
    private val main = Handler(Looper.getMainLooper())
    private var wallpaperListener: WallpaperManager.OnColorsChangedListener? = null
    private var configurationListener: ComponentCallbacks? = null

    private fun context(): Context? = appContext.reactContext?.applicationContext

    private fun startWatching() {
        val context = context() ?: return
        if (MaterialScheme.dynamic && wallpaperListener == null) {
            val listener = WallpaperManager.OnColorsChangedListener { _: WallpaperColors?, _: Int -> sendEvent(CHANGE, mapOf("reason" to "wallpaper")) }
            runCatching { WallpaperManager.getInstance(context).addOnColorsChangedListener(listener, main) }.onSuccess { wallpaperListener = listener }
        }
        if (configurationListener == null) {
            var night = MaterialScheme.nightOf(context.resources.configuration)
            val listener = object : ComponentCallbacks {
                override fun onConfigurationChanged(configuration: Configuration) {
                    val next = MaterialScheme.nightOf(configuration)
                    if (next == night) return
                    night = next
                    sendEvent(CHANGE, mapOf("reason" to "night"))
                }

                @Deprecated("Deprecated in Java")
                override fun onLowMemory() = Unit
            }
            context.registerComponentCallbacks(listener)
            configurationListener = listener
        }
    }

    private fun stopWatching() {
        val context = context() ?: return
        wallpaperListener?.let { listener -> runCatching { WallpaperManager.getInstance(context).removeOnColorsChangedListener(listener) } }
        wallpaperListener = null
        configurationListener?.let(context::unregisterComponentCallbacks)
        configurationListener = null
    }

    override fun definition() = ModuleDefinition {
        Name("ArdiaPhoneMaterial")

        Constants { mapOf("dynamic" to MaterialScheme.dynamic) }

        Events(CHANGE)

        Function("schemes") { context()?.let(MaterialScheme::of) }

        OnStartObserving { main.post { startWatching() } }

        OnStopObserving { main.post { stopWatching() } }

        OnDestroy { main.post { stopWatching() } }
    }

    private companion object {
        const val CHANGE = "onSchemeChange"
    }
}

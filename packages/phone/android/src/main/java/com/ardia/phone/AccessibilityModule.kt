package com.ardia.phone

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Rect
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.View
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.ScrollView
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView

class AccessibilityModule : Module() {
    private val requests by lazy { FocusRequests(Handler(Looper.getMainLooper()), SystemClock::uptimeMillis) }

    override fun definition() = ModuleDefinition {
        Name("ArdiaPhoneAccessibility")

        AsyncFunction("focusView") { tag: Int -> requests.start { runCatching { appContext.findView<View>(tag) }.getOrNull() } }.runOnQueue(Queues.MAIN)

        AsyncFunction("cancelFocus") { request: Int -> requests.cancel(request) }.runOnQueue(Queues.MAIN)

        OnDestroy {
            requests.cancelAll()
        }

        AsyncFunction("announce") { text: String ->
            val window = appContext.currentActivity?.window?.decorView ?: return@AsyncFunction
            ScreenReaderFocus.announce(window, text)
        }.runOnQueue(Queues.MAIN)

        View(ScrollActionsView::class) {
            Name("ScrollActions")
            Events("onScrollAction")
            Prop("canScrollForward") { view: ScrollActionsView, value: Boolean? -> view.canScrollForward = value == true }
            Prop("canScrollBackward") { view: ScrollActionsView, value: Boolean? -> view.canScrollBackward = value == true }
        }
    }
}

internal class FocusRequests(private val handler: Handler, private val clock: () -> Long) {
    companion object {
        const val RETRY_EVERY_MS = 16L
        const val GIVE_UP_AFTER_MS = 500L
    }

    private var lastId = 0
    private val pending = HashMap<Int, Runnable>()

    val waiting: Int get() = pending.size

    fun start(resolve: () -> View?): Int {
        val id = ++lastId
        val deadline = clock() + GIVE_UP_AFTER_MS
        val attempt = object : Runnable {
            override fun run() {
                if (pending[id] !== this) return
                if (ScreenReaderFocus.focus(resolve()) || clock() >= deadline) {
                    pending.remove(id)
                    return
                }
                handler.postDelayed(this, RETRY_EVERY_MS)
            }
        }
        pending[id] = attempt
        attempt.run()
        return id
    }

    fun cancel(id: Int) {
        pending.remove(id)?.let(handler::removeCallbacks)
    }

    fun cancelAll() {
        pending.values.forEach(handler::removeCallbacks)
        pending.clear()
    }
}

internal object ScreenReaderFocus {
    fun ready(view: View?): Boolean = view != null && view.isAttachedToWindow && view.isLaidOut

    fun reachable(view: View): Boolean {
        if (!view.isImportantForAccessibility || !view.isShown || !view.getGlobalVisibleRect(Rect())) return false
        var parent = view.parent
        while (parent is View) {
            if (parent.importantForAccessibility == View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS) return false
            parent = parent.parent
        }
        return true
    }

    fun focus(view: View?): Boolean = ready(view) && reachable(view!!) && view.performAccessibilityAction(AccessibilityNodeInfo.ACTION_ACCESSIBILITY_FOCUS, null)

    @Suppress("DEPRECATION")
    fun announce(view: View, text: String) {
        if (text.isNotBlank()) view.announceForAccessibility(text)
    }
}

@SuppressLint("ViewConstructor")
class ScrollActionsView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
    private val onScrollAction by EventDispatcher()

    var sink: (String) -> Unit = { direction -> onScrollAction(mapOf("direction" to direction)) }

    var canScrollForward = false
    var canScrollBackward = false

    init {
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) =
        setMeasuredDimension(MeasureSpec.getSize(widthMeasureSpec), MeasureSpec.getSize(heightMeasureSpec))

    override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) = Unit

    override fun getAccessibilityClassName(): CharSequence = ScrollView::class.java.name

    override fun onInitializeAccessibilityNodeInfo(info: AccessibilityNodeInfo) {
        super.onInitializeAccessibilityNodeInfo(info)
        info.isScrollable = canScrollForward || canScrollBackward
        if (canScrollForward) info.addAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_FORWARD)
        if (canScrollBackward) info.addAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_BACKWARD)
    }

    override fun performAccessibilityAction(action: Int, arguments: Bundle?): Boolean = when {
        action == AccessibilityNodeInfo.ACTION_SCROLL_FORWARD && canScrollForward -> {
            sink("forward")
            true
        }
        action == AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD && canScrollBackward -> {
            sink("backward")
            true
        }
        else -> super.performAccessibilityAction(action, arguments)
    }
}

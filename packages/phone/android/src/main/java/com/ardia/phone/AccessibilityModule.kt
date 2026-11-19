package com.ardia.phone

import android.annotation.SuppressLint
import android.content.Context
import android.os.Bundle
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
    private fun focusWhenReady(tag: Int, framesLeft: Int) {
        val view = runCatching { appContext.findView<View>(tag) }.getOrNull()
        if (ScreenReaderFocus.focus(view) || framesLeft <= 0) return
        val waiter = view ?: appContext.currentActivity?.window?.decorView ?: return
        waiter.postOnAnimation { focusWhenReady(tag, framesLeft - 1) }
    }

    override fun definition() = ModuleDefinition {
        Name("ArdiaPhoneAccessibility")

        AsyncFunction("focusView") { tag: Int -> focusWhenReady(tag, ScreenReaderFocus.FRAMES_TO_WAIT) }.runOnQueue(Queues.MAIN)

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

internal object ScreenReaderFocus {
    const val FRAMES_TO_WAIT = 2

    fun ready(view: View?): Boolean = view != null && view.isAttachedToWindow && view.isLaidOut

    fun focus(view: View?): Boolean = ready(view) && view!!.performAccessibilityAction(AccessibilityNodeInfo.ACTION_ACCESSIBILITY_FOCUS, null)

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

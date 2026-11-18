package com.ardia.phone

import android.content.Context
import android.view.GestureDetector
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.platform.ViewCompositionStrategy
import com.facebook.react.uimanager.events.NativeGestureUtil
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView

class MenuItemRecord : Record {
    @Field val id: String = ""

    @Field val title: String = ""

    @Field val subtitle: String? = null

    @Field val systemImage: String? = null

    @Field val destructive: Boolean = false

    @Field val disabled: Boolean = false

    @Field val checked: Boolean = false

    @Field val inline: Boolean = false

    @Field val children: List<MenuItemRecord>? = null
}

class MenuAppearanceRecord : Record {
    @Field val dark: Boolean? = null

    @Field val scheme: Map<String, String>? = null
}

class ActionSheetActionRecord : Record {
    @Field val id: String = ""

    @Field val title: String = ""

    @Field val destructive: Boolean = false

    @Field val cancel: Boolean = false
}

class ActionSheetRecord : Record {
    @Field val title: String? = null

    @Field val message: String? = null

    @Field val actions: List<ActionSheetActionRecord> = emptyList()

    @Field val appearance: MenuAppearanceRecord? = null
}

internal object NativeMenuRules {
    const val DRAWN_ARGUMENT = "ArdiaDrawnMenus"

    data class Item(val id: String, val title: String, val subtitle: String?, val destructive: Boolean, val disabled: Boolean, val checked: Boolean, val children: List<Row>?, val systemImage: String? = null)

    sealed interface Row {
        val group: Int
    }

    data class Header(val title: String, override val group: Int) : Row

    data class Action(val item: Item, override val group: Int) : Row

    data class MenuItemShape(val id: String, val title: String, val subtitle: String? = null, val destructive: Boolean = false, val disabled: Boolean = false, val checked: Boolean = false, val inline: Boolean = false, val children: List<MenuItemShape>? = null, val systemImage: String? = null)

    fun shape(record: MenuItemRecord): MenuItemShape =
        MenuItemShape(record.id, record.title, record.subtitle, record.destructive, record.disabled, record.checked, record.inline, record.children?.map(::shape), record.systemImage)

    fun rows(items: List<MenuItemShape>): List<Row> {
        val rows = mutableListOf<Row>()
        var group = 0
        for (item in items) {
            val children = item.children
            if (children != null && item.inline) {
                group += 1
                if (item.title.isNotEmpty()) rows += Header(item.title, group)
                rows += rows(children).map { child -> if (child is Action) child.copy(group = group) else (child as Header).copy(group = group) }
                group += 1
                continue
            }
            val nested = children?.let(::rows)
            rows += Action(Item(item.id, item.title, item.subtitle, item.destructive, item.disabled, item.checked, nested, item.systemImage), group)
        }
        return rows
    }

    data class Sheet(val buttons: List<ActionSheetActionShape>, val listed: List<ActionSheetActionShape>, val cancelTitle: String)

    data class ActionSheetActionShape(val id: String, val title: String, val destructive: Boolean = false, val cancel: Boolean = false)

    fun sheet(actions: List<ActionSheetActionShape>, defaultCancel: String = "Cancel"): Sheet {
        val choices = actions.filterNot { it.cancel }
        val cancelTitle = actions.firstOrNull { it.cancel }?.title ?: defaultCancel
        return if (choices.size <= 2) Sheet(choices, emptyList(), cancelTitle) else Sheet(emptyList(), choices, cancelTitle)
    }

    fun nativeMenus(arguments: Map<String, Any>): Boolean = arguments[DRAWN_ARGUMENT] != true

    fun isDark(context: Context, dark: Boolean?): Boolean =
        dark ?: ((context.resources.configuration.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK) == android.content.res.Configuration.UI_MODE_NIGHT_YES)
}

class NativeContextMenuView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
    private val onSelect by EventDispatcher()
    private val onOpen by EventDispatcher()
    private val onClose by EventDispatcher()

    internal var items: List<NativeMenuRules.MenuItemShape> = emptyList()
    var trigger: String = "longPress"
    var dark: Boolean? = null
    var scheme: Map<String, String>? = null
    private var host: ComposeView? = null
    private var expanded: MutableState<Boolean>? = null

    private val gestures = GestureDetector(
        context,
        object : GestureDetector.SimpleOnGestureListener() {
            override fun onDown(event: MotionEvent): Boolean = true

            override fun onSingleTapUp(event: MotionEvent): Boolean {
                if (trigger != "tap") return false
                show(event, null, null)
                return true
            }
        },
    ).apply { setIsLongpressEnabled(false) }

    internal val opensOnItsOwnTimer: Boolean get() = gestures.isLongpressEnabled

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) =
        setMeasuredDimension(MeasureSpec.getSize(widthMeasureSpec), MeasureSpec.getSize(heightMeasureSpec))

    override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) = Unit

    override fun dispatchTouchEvent(event: MotionEvent): Boolean {
        if (items.isNotEmpty()) gestures.onTouchEvent(event)
        return super.dispatchTouchEvent(event)
    }

    fun showFromCode(pressX: Double?, pressY: Double?) {
        val density = resources.displayMetrics.density
        if (pressX == null || pressY == null) return show(null, null, null)
        performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
        show(null, (pressX * density).toFloat(), (pressY * density).toFloat())
    }

    private fun show(event: MotionEvent?, pressX: Float?, pressY: Float?) {
        if (items.isEmpty() || host != null) return
        val content = rootView.findViewById<View>(android.R.id.content) as? FrameLayout ?: return
        if (event != null) {
            NativeGestureUtil.notifyNativeGestureStarted(this, event)
            parent?.requestDisallowInterceptTouchEvent(true)
        }
        val here = IntArray(2).also(::getLocationInWindow)
        val origin = IntArray(2).also(content::getLocationInWindow)
        val bounds = MaterialMenuRules.anchor(here[0] - origin[0], here[1] - origin[1], width, height, resources.displayMetrics.density, pressX, pressY)
        val colors = MaterialScheme.colorScheme(appContext.currentActivity ?: context, NativeMenuRules.isDark(context, dark), scheme)
        val rows = NativeMenuRules.rows(items)
        val open = mutableStateOf(true)
        val view = ComposeView(context).apply {
            setViewCompositionStrategy(ViewCompositionStrategy.DisposeOnDetachedFromWindow)
            importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
            setContent {
                MaterialMenu(colors, open, rows, onPick = { id ->
                    onSelect(mapOf("id" to id))
                    close()
                }, onDismiss = ::close)
            }
        }
        content.addView(view, FrameLayout.LayoutParams(bounds.width, bounds.height).apply {
            leftMargin = bounds.left
            topMargin = bounds.top
        })
        host = view
        expanded = open
        onOpen(emptyMap())
    }

    private fun close() {
        val open = expanded ?: return
        if (!open.value) return
        open.value = false
        expanded = null
        onClose(emptyMap())
        val view = host
        postDelayed({
            (view?.parent as? ViewGroup)?.removeView(view)
            if (host === view) host = null
        }, MaterialMenuRules.EXIT_MS)
    }

    fun dismissMenu() {
        close()
    }

    override fun onDetachedFromWindow() {
        close()
        host?.let { (it.parent as? ViewGroup)?.removeView(it) }
        host = null
        super.onDetachedFromWindow()
    }
}

class MenusModule : Module() {
    private fun nativeMenusShown(): Boolean = NativeMenuRules.nativeMenus(LaunchExtras.arguments(LaunchExtras.of(appContext.currentActivity?.intent)))

    override fun definition() = ModuleDefinition {
        Name("ArdiaPhoneMenus")

        Constants {
            val shown = nativeMenusShown()
            mapOf("hasContextMenu" to shown, "hasActionSheet" to shown)
        }

        AsyncFunction("actionSheet") { options: ActionSheetRecord, promise: Promise ->
            val activity = appContext.currentActivity
            val content = activity?.findViewById<View>(android.R.id.content) as? FrameLayout
            if (activity == null || activity.isFinishing || content == null) {
                promise.resolve(null)
                return@AsyncFunction
            }
            val colors = MaterialScheme.colorScheme(activity, NativeMenuRules.isDark(activity, options.appearance?.dark), options.appearance?.scheme)
            val sheet = NativeMenuRules.sheet(options.actions.map { NativeMenuRules.ActionSheetActionShape(it.id, it.title, it.destructive, it.cancel) })
            val view = ComposeView(activity).apply { setViewCompositionStrategy(ViewCompositionStrategy.DisposeOnDetachedFromWindow) }
            var answered = false
            val answer = { id: String? ->
                if (!answered) {
                    answered = true
                    promise.resolve(id)
                    content.post { content.removeView(view) }
                }
            }
            view.setContent { MaterialSheetDialog(colors, options.title, options.message, sheet, answer) }
            content.addView(view, FrameLayout.LayoutParams(0, 0))
        }.runOnQueue(Queues.MAIN)

        View(NativeContextMenuView::class) {
            Events("onSelect", "onOpen", "onClose")

            Prop("items") { view: NativeContextMenuView, items: List<MenuItemRecord> -> view.items = items.map(NativeMenuRules::shape) }

            Prop("trigger") { view: NativeContextMenuView, value: String? -> view.trigger = if (value == "tap") "tap" else "longPress" }

            Prop("fixedOrder") { _: NativeContextMenuView, _: Boolean? -> }

            Prop("appearance") { view: NativeContextMenuView, value: MenuAppearanceRecord? ->
                view.dark = value?.dark
                view.scheme = value?.scheme
            }

            AsyncFunction("show") { view: NativeContextMenuView, pressX: Double?, pressY: Double? -> view.showFromCode(pressX, pressY) }.runOnQueue(Queues.MAIN)
        }
    }
}

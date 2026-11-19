package com.ardia.phone

import android.app.Activity
import android.os.Bundle
import android.os.Looper
import android.view.View
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityManager
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.FrameLayout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ScreenReaderFocusTest {
    private val activity: Activity = Robolectric.buildActivity(Activity::class.java).setup().visible().get()

    private val row = View(activity).apply {
        importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
        contentDescription = "Archive"
    }

    @Before
    fun screenReaderOn() {
        val manager = activity.getSystemService(AccessibilityManager::class.java)
        shadowOf(manager).setEnabled(true)
        shadowOf(manager).setTouchExplorationEnabled(true)
    }

    @Test
    fun aViewThatIsMissingOrNotYetLaidOutIsNotFocusedSoTheModuleWaitsAFrameAndTriesAgain() {
        assertFalse(ScreenReaderFocus.focus(null))
        assertFalse(ScreenReaderFocus.focus(row))
    }

    @Test
    fun aLaidOutViewIsAskedForTheScreenReadersFocusWithTheAccessibilityFocusAction() {
        val asked = mutableListOf<Int>()
        val target = object : View(activity) {
            override fun performAccessibilityAction(action: Int, arguments: Bundle?): Boolean {
                asked += action
                return action == AccessibilityNodeInfo.ACTION_ACCESSIBILITY_FOCUS
            }
        }
        assertFalse("a view not yet attached waits", ScreenReaderFocus.focus(target))
        assertTrue("nothing is asked of a view that isn't ready", asked.isEmpty())
        activity.setContentView(FrameLayout(activity).apply { addView(target, 200, 100) })
        shadowOf(Looper.getMainLooper()).idle()
        val decor = activity.window.decorView
        decor.measure(View.MeasureSpec.makeMeasureSpec(1080, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(2400, View.MeasureSpec.EXACTLY))
        decor.layout(0, 0, 1080, 2400)
        assertTrue("an attached view", target.isAttachedToWindow)
        assertTrue("a laid-out view", target.isLaidOut)
        assertTrue("an attached, laid-out view is ready", ScreenReaderFocus.ready(target))
        assertTrue(ScreenReaderFocus.focus(target))
        assertEquals(listOf(AccessibilityNodeInfo.ACTION_ACCESSIBILITY_FOCUS), asked)
    }

    @Test
    fun anAnnouncementReachesTheScreenReaderAsAnAnnouncementEvent() {
        activity.setContentView(FrameLayout(activity).apply { addView(row, 200, 100) })
        shadowOf(Looper.getMainLooper()).idle()
        val manager = activity.getSystemService(AccessibilityManager::class.java)
        ScreenReaderFocus.announce(activity.window.decorView, "Close 3 Tabs? They’ll stay in your Archive.")
        assertTrue(shadowOf(manager).sentAccessibilityEvents.any { it.eventType == AccessibilityEvent.TYPE_ANNOUNCEMENT && it.text.joinToString().contains("Close 3 Tabs?") })
    }
}

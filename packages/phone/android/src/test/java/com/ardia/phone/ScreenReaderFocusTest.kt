package com.ardia.phone

import android.app.Activity
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
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
import java.time.Duration

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
        val target = recording(asked)
        assertFalse("a view not yet attached waits", ScreenReaderFocus.focus(target))
        assertTrue("nothing is asked of a view that isn't ready", asked.isEmpty())
        activity.setContentView(FrameLayout(activity).apply { addView(target, 200, 100) })
        layOut()
        assertTrue("an attached view", target.isAttachedToWindow)
        assertTrue("a laid-out view", target.isLaidOut)
        assertTrue("an attached, laid-out view is ready", ScreenReaderFocus.ready(target))
        assertTrue(ScreenReaderFocus.focus(target))
        assertEquals(listOf(AccessibilityNodeInfo.ACTION_ACCESSIBILITY_FOCUS), asked)
    }

    @Test
    fun aViewUnderAHiddenOverlayOrNotImportantIsNeverFocused() {
        val asked = mutableListOf<Int>()
        val target = recording(asked)
        val closing = FrameLayout(activity).apply { addView(target, 200, 100) }
        activity.setContentView(closing)
        layOut()
        closing.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        assertFalse("under a parent hiding its descendants", ScreenReaderFocus.focus(target))
        closing.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_AUTO
        target.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        assertFalse("not important for accessibility", ScreenReaderFocus.focus(target))
        target.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
        target.visibility = View.INVISIBLE
        assertFalse("not visible", ScreenReaderFocus.focus(target))
        assertTrue(asked.isEmpty())
    }

    @Test
    fun aRequestRetriesOnTheMainHandlerUntilItsViewIsReadyAndEndsThere() {
        val asked = mutableListOf<Int>()
        val target = recording(asked)
        val requests = FocusRequests(Handler(Looper.getMainLooper()), SystemClock::uptimeMillis)
        var looked = 0
        requests.start {
            looked += 1
            if (looked < 3) null else target
        }
        activity.setContentView(FrameLayout(activity).apply { addView(target, 200, 100) })
        layOut()
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(100))
        assertEquals(listOf(AccessibilityNodeInfo.ACTION_ACCESSIBILITY_FOCUS), asked)
        assertEquals(0, requests.waiting)
        assertEquals(3, looked)
    }

    @Test
    fun aCancelledRequestNeverLooksAgain() {
        val requests = FocusRequests(Handler(Looper.getMainLooper()), SystemClock::uptimeMillis)
        var looked = 0
        val id = requests.start {
            looked += 1
            null
        }
        requests.cancel(id)
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(1))
        assertEquals(1, looked)
        assertEquals(0, requests.waiting)
    }

    @Test
    fun aRequestGivesUpAfterItsTimeAndTeardownDropsEveryRequest() {
        val requests = FocusRequests(Handler(Looper.getMainLooper()), SystemClock::uptimeMillis)
        var looked = 0
        requests.start {
            looked += 1
            null
        }
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(2))
        assertEquals(0, requests.waiting)
        val tries = looked
        assertTrue(tries > 1)
        requests.start { null }
        requests.start { null }
        assertEquals(2, requests.waiting)
        requests.cancelAll()
        assertEquals(0, requests.waiting)
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(1))
        assertEquals(tries, looked)
    }

    @Test
    fun destroyingFromAnotherThreadWhileARequestRetriesStopsItThereAndRefusesNewOnes() {
        val requests = FocusRequests(Handler(Looper.getMainLooper()), SystemClock::uptimeMillis)
        var looked = 0
        requests.start {
            looked += 1
            null
        }
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(40))
        val before = looked
        var failure: Throwable? = null
        val teardown = Thread {
            try {
                requests.destroy()
            } catch (thrown: Throwable) {
                failure = thrown
            }
        }
        teardown.start()
        teardown.join()
        assertEquals(null, failure)
        assertTrue(requests.destroyed)
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(1))
        assertEquals(before, looked)
        assertEquals(0, requests.waiting)
        assertEquals(0, requests.start { looked += 1; null })
        assertEquals(before, looked)
    }

    @Test
    fun anAnnouncementReachesTheScreenReaderAsAnAnnouncementEvent() {
        activity.setContentView(FrameLayout(activity).apply { addView(row, 200, 100) })
        shadowOf(Looper.getMainLooper()).idle()
        val manager = activity.getSystemService(AccessibilityManager::class.java)
        ScreenReaderFocus.announce(activity.window.decorView, "Close 3 Tabs? They’ll stay in your Archive.")
        assertTrue(shadowOf(manager).sentAccessibilityEvents.any { it.eventType == AccessibilityEvent.TYPE_ANNOUNCEMENT && it.text.joinToString().contains("Close 3 Tabs?") })
    }

    private fun recording(asked: MutableList<Int>): View = object : View(activity) {
        init {
            importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
        }

        override fun performAccessibilityAction(action: Int, arguments: Bundle?): Boolean {
            asked += action
            return action == AccessibilityNodeInfo.ACTION_ACCESSIBILITY_FOCUS
        }
    }

    private fun layOut() {
        shadowOf(Looper.getMainLooper()).idle()
        val decor = activity.window.decorView
        decor.measure(View.MeasureSpec.makeMeasureSpec(1080, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(2400, View.MeasureSpec.EXACTLY))
        decor.layout(0, 0, 1080, 2400)
    }
}

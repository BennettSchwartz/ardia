package com.ardia.phone

import android.widget.Button
import android.widget.EditText
import android.webkit.WebView
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class StrayKeyboardTest {
    private val context = RuntimeEnvironment.getApplication()

    @Test
    fun aTextFieldThatLosesFocusToNothingLeavesNoKeyboardBehind() {
        assertTrue("My Filters' field removed with the page while the keyboard was up", StrayKeyboard.leftTyping(EditText(context), null))
        assertTrue("focus moved to a plain button", StrayKeyboard.leftTyping(EditText(context), Button(context)))
    }

    @Test
    fun movingBetweenFieldsOrIntoThePageKeepsTheKeyboard() {
        assertFalse("from one field to the next", StrayKeyboard.leftTyping(EditText(context), EditText(context)))
        assertFalse("into a web page, whose own inputs take the keyboard", StrayKeyboard.leftTyping(EditText(context), WebView(context)))
        assertFalse("focus that never was in a text field", StrayKeyboard.leftTyping(Button(context), null))
    }
}

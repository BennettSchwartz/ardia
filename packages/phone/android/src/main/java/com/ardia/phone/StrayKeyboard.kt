package com.ardia.phone

import android.app.Activity
import android.content.Context
import android.view.View
import android.view.ViewTreeObserver
import android.view.inputmethod.InputMethodManager
import android.webkit.WebView

object StrayKeyboard {
    internal fun takesTyping(view: View?): Boolean = view != null && (view.onCheckIsTextEditor() || view is WebView)

    internal fun leftTyping(before: View?, after: View?): Boolean = before?.onCheckIsTextEditor() == true && !takesTyping(after)

    fun install(activity: Activity) {
        val decor = activity.window?.decorView ?: return
        val watch = ViewTreeObserver.OnGlobalFocusChangeListener { before, after ->
            if (!leftTyping(before, after)) return@OnGlobalFocusChangeListener
            decor.post {
                if (takesTyping(activity.currentFocus)) return@post
                val inputMethods = activity.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager ?: return@post
                inputMethods.hideSoftInputFromWindow(decor.windowToken, 0)
            }
        }
        decor.viewTreeObserver.addOnGlobalFocusChangeListener(watch)
    }
}

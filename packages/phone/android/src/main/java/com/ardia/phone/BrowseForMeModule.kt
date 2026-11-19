package com.ardia.phone

import android.content.Context
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class BrowseForMeModule : Module() {
    private val context: Context get() = appContext.reactContext ?: throw CodedException("ERR_NO_CONTEXT", "The app context is gone", null)

    private val host: BrowseForMeHost get() = BrowseForMeHost.get(context)

    override fun definition() = ModuleDefinition {
        Name("ArdiaPhoneBrowseForMe")

        Events("onBrowseForMe")

        OnCreate {
            android.os.Handler(android.os.Looper.getMainLooper()).post {
                host.sink = { event -> sendEvent("onBrowseForMe", event) }
            }
        }

        OnDestroy {
            android.os.Handler(android.os.Looper.getMainLooper()).post { BrowseForMeHost.get(context).sink = null }
        }

        AsyncFunction("isConnected") { -> host.account.isConnected }.runOnQueue(Queues.MAIN)

        AsyncFunction("open") { query: String ->
            val activity = appContext.currentActivity ?: throw CodedException("ERR_NO_ACTIVITY", "Ardia isn't on screen", null)
            host.open(activity, query)
        }.runOnQueue(Queues.MAIN)

        AsyncFunction("account") { -> host.accountPayload() }.runOnQueue(Queues.MAIN)

        AsyncFunction("connect") Coroutine { ->
            withContext(Dispatchers.Main.immediate) {
                val activity = appContext.currentActivity ?: throw CodedException("ERR_NO_ACTIVITY", "Ardia isn't on screen", null)
                host.account.signIn(activity)
            }
        }

        AsyncFunction("disconnect") Coroutine { ->
            withContext(Dispatchers.Main.immediate) { host.account.disconnect() }
        }

        AsyncFunction("chooseModel") { slug: String -> host.account.choose(slug) }.runOnQueue(Queues.MAIN)

        AsyncFunction("chooseEffort") { effort: String? -> host.account.chooseEffort(effort?.takeIf { it.isNotEmpty() }) }.runOnQueue(Queues.MAIN)

        AsyncFunction("clearProblem") { -> host.account.clearProblem() }.runOnQueue(Queues.MAIN)

        AsyncFunction("openUsage") { -> host.openLink(ChatGPTAccount.USAGE_URL) }.runOnQueue(Queues.MAIN)
    }
}

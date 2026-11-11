package io.github.whatmekota.playhound.usb

import java.util.concurrent.ConcurrentHashMap

/**
 * The open USB ports' last word: what each sends when the app closes or the
 * notification's Panic is pressed and the page cannot answer (TCode that
 * homes every axis, set by the page through setPanic). Process-wide, so the
 * session service can reach it after the activity has gone.
 */
object SerialPanic {
    private val actions = ConcurrentHashMap<String, () -> Unit>()

    fun register(id: String, action: () -> Unit) {
        actions[id] = action
    }

    fun unregister(id: String) {
        actions.remove(id)
    }

    /** How many ports there are to stop. */
    val count: Int get() = actions.size

    /** Send every port its panic bytes. Never throws. */
    fun fire() {
        for (a in actions.values) {
            try {
                a()
            }
            catch (_: Throwable) {
            }
        }
    }
}

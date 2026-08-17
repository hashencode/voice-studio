package com.voice2text.app.importing

class SharedMediaRequestQueue(
    private val capacity: Int = 8,
) {
    private val pending = ArrayDeque<String>()

    init {
        require(capacity > 0) { "capacity must be positive" }
    }

    @Synchronized
    fun offer(uri: String): Boolean {
        if (uri.isBlank() || uri in pending || pending.size >= capacity) {
            return false
        }
        pending.addLast(uri)
        return true
    }

    @Synchronized
    fun poll(): String? = pending.removeFirstOrNull()

    @Synchronized
    fun hasPending(): Boolean = pending.isNotEmpty()
}

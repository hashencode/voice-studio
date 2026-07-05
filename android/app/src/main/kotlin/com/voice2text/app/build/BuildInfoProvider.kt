package com.voice2text.app.build

import android.content.Context

class BuildInfoProvider(
    private val context: Context,
) {
    fun getBuildInfo(): Map<String, Any> {
        val pkg = context.packageManager.getPackageInfo(context.packageName, 0)
        return hashMapOf(
            "packageName" to context.packageName,
            "versionName" to (pkg.versionName ?: ""),
            "lastUpdateTimeMs" to pkg.lastUpdateTime,
        )
    }
}

package com.voice2text.app.companion

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build
import android.util.Base64
import androidx.core.content.ContextCompat
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.net.InetAddress
import java.util.concurrent.ConcurrentHashMap

class CompanionPlatformPlugin(
    private val context: Context,
    messenger: BinaryMessenger,
) {
    private val channel = MethodChannel(messenger, CHANNEL)
    private val credentialStore = CompanionCredentialStore(context)
    private val nsdManager =
        context.getSystemService(Context.NSD_SERVICE) as NsdManager
    private val discovered = ConcurrentHashMap<String, Map<String, Any>>()
    private var discoveryListener: NsdManager.DiscoveryListener? = null

    init {
        channel.setMethodCallHandler(::handle)
    }

    fun dispose() {
        stopDiscovery()
        channel.setMethodCallHandler(null)
    }

    private fun handle(
        call: MethodCall,
        result: MethodChannel.Result,
    ) {
        try {
            when (call.method) {
                "putCredential" -> {
                    credentialStore.put(
                        call.requireString("key"),
                        Base64.decode(call.requireString("value"), Base64.NO_WRAP),
                    )
                    result.success(null)
                }
                "getCredential" -> {
                    val value = credentialStore.get(call.requireString("key"))
                    result.success(
                        value?.let { Base64.encodeToString(it, Base64.NO_WRAP) },
                    )
                }
                "deleteCredential" -> {
                    credentialStore.delete(call.requireString("key"))
                    result.success(null)
                }
                "deleteAllCredentials" -> {
                    credentialStore.deleteAll()
                    result.success(null)
                }
                "startDiscovery" -> startDiscovery(result)
                "listDiscoveredDesktops" ->
                    result.success(discovered.values.sortedBy { it["deviceName"].toString() })
                "stopDiscovery" -> {
                    stopDiscovery()
                    result.success(null)
                }
                else -> result.notImplemented()
            }
        } catch (error: IllegalArgumentException) {
            result.error("COMPANION_INVALID_ARGUMENT", error.message, null)
        } catch (_: CompanionCredentialUnavailableException) {
            result.error(
                "COMPANION_CREDENTIAL_UNAVAILABLE",
                "配对凭据已失效，请重新配对",
                null,
            )
        } catch (_: SecurityException) {
            result.error(
                "LOCAL_NETWORK_PERMISSION_DENIED",
                "未获准访问本地网络；录音和本机功能不受影响",
                null,
            )
        }
    }

    private fun startDiscovery(result: MethodChannel.Result) {
        if (!hasLocalNetworkPermission()) {
            result.error(
                "LOCAL_NETWORK_PERMISSION_DENIED",
                "未获准访问本地网络；录音和本机功能不受影响",
                null,
            )
            return
        }
        if (discoveryListener != null) {
            result.success(mapOf("started" to true, "alreadyRunning" to true))
            return
        }
        discovered.clear()
        val listener =
            object : NsdManager.DiscoveryListener {
                override fun onDiscoveryStarted(serviceType: String) = Unit

                override fun onServiceFound(serviceInfo: NsdServiceInfo) {
                    if (serviceInfo.serviceType != SERVICE_TYPE) return
                    resolve(serviceInfo)
                }

                override fun onServiceLost(serviceInfo: NsdServiceInfo) {
                    discovered.remove(serviceInfo.serviceName)
                }

                override fun onDiscoveryStopped(serviceType: String) = Unit

                override fun onStartDiscoveryFailed(
                    serviceType: String,
                    errorCode: Int,
                ) {
                    stopDiscovery()
                }

                override fun onStopDiscoveryFailed(
                    serviceType: String,
                    errorCode: Int,
                ) {
                    stopDiscovery()
                }
            }
        discoveryListener = listener
        nsdManager.discoverServices(
            SERVICE_TYPE,
            NsdManager.PROTOCOL_DNS_SD,
            listener,
        )
        result.success(mapOf("started" to true, "alreadyRunning" to false))
    }

    @Suppress("DEPRECATION")
    private fun resolve(serviceInfo: NsdServiceInfo) {
        nsdManager.resolveService(
            serviceInfo,
            object : NsdManager.ResolveListener {
                override fun onResolveFailed(
                    serviceInfo: NsdServiceInfo,
                    errorCode: Int,
                ) = Unit

                override fun onServiceResolved(resolved: NsdServiceInfo) {
                    val host: InetAddress = resolved.host ?: return
                    val attributes = resolved.attributes
                    val deviceId =
                        attributes["deviceId"]?.toString(Charsets.UTF_8) ?: return
                    val fingerprint =
                        attributes["fingerprint"]?.toString(Charsets.UTF_8) ?: return
                    val capability =
                        attributes["capability"]?.toString(Charsets.UTF_8) ?: return
                    if (capability != "audio-transfer/v2") return
                    discovered[resolved.serviceName] =
                        mapOf(
                            "deviceId" to deviceId,
                            "deviceName" to resolved.serviceName,
                            "host" to host.hostAddress.orEmpty(),
                            "port" to resolved.port,
                            "fingerprint" to fingerprint,
                            "capability" to capability,
                        )
                }
            },
        )
    }

    private fun stopDiscovery() {
        val listener = discoveryListener ?: return
        discoveryListener = null
        runCatching { nsdManager.stopServiceDiscovery(listener) }
    }

    private fun hasLocalNetworkPermission(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true
        return ContextCompat.checkSelfPermission(
            context,
            Manifest.permission.NEARBY_WIFI_DEVICES,
        ) == PackageManager.PERMISSION_GRANTED
    }

    private fun MethodCall.requireString(name: String): String =
        argument<String>(name)?.takeIf { it.isNotBlank() }
            ?: throw IllegalArgumentException("$name is required")

    companion object {
        const val CHANNEL = "voice2text/companion"
        private const val SERVICE_TYPE = "_voice2text-media._tcp."
    }
}

package com.cavalry.smsrelay

import android.content.Context
import java.net.URI
import org.json.JSONArray
import org.json.JSONObject

data class RelayConfig(
    val endpoint: String,
    val token: String,
    val sender: String,
    val enabled: Boolean
)

data class PendingSms(
    val id: String,
    val message: String,
    val receivedAt: String
)

object RelaySettings {
    private const val PREFS = "relay_settings"
    private const val KEY_ENDPOINT = "endpoint"
    private const val KEY_TOKEN = "token"
    private const val KEY_SENDER = "sender"
    private const val KEY_ENABLED = "enabled"
    private const val KEY_QUEUE = "pending_sms"

    private fun prefs(context: Context) =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun load(context: Context): RelayConfig {
        val preferences = prefs(context)
        return RelayConfig(
            endpoint = preferences.getString(KEY_ENDPOINT, DEFAULT_ENDPOINT) ?: DEFAULT_ENDPOINT,
            token = preferences.getString(KEY_TOKEN, "") ?: "",
            sender = preferences.getString(KEY_SENDER, "MPESA") ?: "MPESA",
            enabled = preferences.getBoolean(KEY_ENABLED, false)
        )
    }

    fun save(context: Context, config: RelayConfig) {
        prefs(context).edit()
            .putString(KEY_ENDPOINT, config.endpoint.trim())
            .putString(KEY_TOKEN, config.token)
            .putString(KEY_SENDER, config.sender.trim())
            .putBoolean(KEY_ENABLED, config.enabled)
            .apply()
    }

    fun isValidEndpoint(value: String): Boolean {
        return try {
            val uri = URI(value)
            uri.scheme == "https" &&
                uri.host == "script.google.com" &&
                uri.path.startsWith("/macros/s/") &&
                uri.path.endsWith("/exec")
        } catch (_: Exception) {
            false
        }
    }

    @Synchronized
    fun enqueue(context: Context, sms: PendingSms) {
        val queue = readQueue(context)
        if (queue.none { it.id == sms.id }) {
            queue.add(sms)
            writeQueue(context, queue)
        }
    }

    @Synchronized
    fun pending(context: Context): List<PendingSms> = readQueue(context)

    @Synchronized
    fun remove(context: Context, id: String) {
        val queue = readQueue(context).filterNot { it.id == id }
        writeQueue(context, queue)
    }

    private fun readQueue(context: Context): MutableList<PendingSms> {
        val raw = prefs(context).getString(KEY_QUEUE, "[]") ?: "[]"
        val json = JSONArray(raw)
        return MutableList(json.length()) { index ->
            val item = json.getJSONObject(index)
            PendingSms(item.getString("id"), item.getString("message"), item.getString("receivedAt"))
        }
    }

    private fun writeQueue(context: Context, queue: List<PendingSms>) {
        val json = JSONArray()
        queue.forEach { sms ->
            json.put(JSONObject()
                .put("id", sms.id)
                .put("message", sms.message)
                .put("receivedAt", sms.receivedAt))
        }
        prefs(context).edit().putString(KEY_QUEUE, json.toString()).apply()
    }

    const val DEFAULT_ENDPOINT =
        "https://script.google.com/macros/s/AKfycbx9xaPSdNyEa51Lws0iEBobfHrh4ZqAw4R5QO5YJi680D1B-S1HlRdrTxMi5QdXTccXEA/exec"
}

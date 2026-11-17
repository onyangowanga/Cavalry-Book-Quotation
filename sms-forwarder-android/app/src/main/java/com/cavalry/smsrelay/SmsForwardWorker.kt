package com.cavalry.smsrelay

import android.content.Context
import android.util.Log
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import org.json.JSONObject

class SmsForwardWorker(
    context: Context,
    params: WorkerParameters
) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val config = RelaySettings.load(applicationContext)
        if (!config.enabled) return Result.success()
        if (!RelaySettings.isValidEndpoint(config.endpoint) || config.token.isBlank()) {
            Log.e(TAG, "Forwarding configuration is invalid; pending messages were retained.")
            return Result.failure()
        }

        return try {
            for (sms in RelaySettings.pending(applicationContext)) {
                if (!send(config, sms)) return Result.retry()
                RelaySettings.remove(applicationContext, sms.id)
            }
            Result.success()
        } catch (error: Exception) {
            Log.e(TAG, "Forwarding failed; pending messages will be retried.", error)
            Result.retry()
        }
    }

    private fun send(config: RelayConfig, sms: PendingSms): Boolean {
        val connection = URL(config.endpoint).openConnection() as HttpURLConnection
        try {
            connection.requestMethod = "POST"
            connection.connectTimeout = 15000
            connection.readTimeout = 15000
            connection.doOutput = true
            connection.setRequestProperty(
                "Content-Type",
                "application/x-www-form-urlencoded; charset=UTF-8"
            )

            val body = listOf(
                "action" to "receive_payment_sms",
                "message" to sms.message,
                "receivedAt" to sms.receivedAt,
                "token" to config.token
            ).joinToString("&") { (key, value) ->
                "${encode(key)}=${encode(value)}"
            }
            connection.outputStream.use { output ->
                output.write(body.toByteArray(Charsets.UTF_8))
            }

            val responseStream = if (connection.responseCode in 200..299) {
                connection.inputStream
            } else {
                connection.errorStream ?: return false
            }
            val response = BufferedReader(InputStreamReader(responseStream, Charsets.UTF_8))
                .use { it.readText() }
            return connection.responseCode in 200..299 &&
                JSONObject(response).optString("status") == "success"
        } finally {
            connection.disconnect()
        }
    }

    private fun encode(value: String): String = URLEncoder.encode(value, "UTF-8")

    companion object {
        const val WORK_NAME = "cavalry_sms_forward"
        private const val TAG = "CavalrySmsRelay"
    }
}

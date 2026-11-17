package com.cavalry.smsrelay

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony
import android.util.Log
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import java.security.MessageDigest
import java.time.Instant

class SmsReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return

        val config = RelaySettings.load(context)
        if (!config.enabled || config.token.isBlank() || config.sender.isBlank()) return

        val parts = Telephony.Sms.Intents.getMessagesFromIntent(intent)
        if (parts.isEmpty()) return

        val sender = parts.first().displayOriginatingAddress.orEmpty().trim()
        if (!sender.equals(config.sender, ignoreCase = true)) return

        val message = parts.joinToString(separator = "") { it.messageBody.orEmpty() }.trim()
        if (message.isBlank()) return

        val receivedAt = Instant.ofEpochMilli(parts.first().timestampMillis).toString()
        val id = sha256("$sender\n$receivedAt\n$message")
        try {
            RelaySettings.enqueue(context, PendingSms(id, message, receivedAt))
            val request = OneTimeWorkRequestBuilder<SmsForwardWorker>()
                .setConstraints(
                    Constraints.Builder()
                        .setRequiredNetworkType(NetworkType.CONNECTED)
                        .build()
                )
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork(
                SmsForwardWorker.WORK_NAME,
                ExistingWorkPolicy.APPEND_OR_REPLACE,
                request
            )
        } catch (error: Exception) {
            Log.e(TAG, "Could not queue an incoming payment SMS for forwarding.", error)
        }
    }

    private fun sha256(value: String): String =
        MessageDigest.getInstance("SHA-256")
            .digest(value.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }

    companion object {
        private const val TAG = "CavalrySmsRelay"
    }
}

package com.cavalry.smsrelay

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.os.Bundle
import android.view.ViewGroup
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager

class MainActivity : Activity() {
    private lateinit var endpointField: EditText
    private lateinit var tokenField: EditText
    private lateinit var senderField: EditText
    private lateinit var enabledToggle: CheckBox
    private lateinit var statusText: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        buildScreen()
        loadForm()
    }

    override fun onResume() {
        super.onResume()
        if (::statusText.isInitialized) updateStatus()
    }

    private fun buildScreen() {
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(24), dp(20), dp(24))
        }
        val scroll = ScrollView(this).apply { addView(content) }

        content.addView(text("Cavalry SMS Relay", 24f, true))
        content.addView(text(
            "Forwards matching SMS messages to your private payment-review inbox. " +
                "Forwarded messages do not confirm or record a payment.",
            15f
        ), margin(top = 8, bottom = 20))

        endpointField = input("HTTPS webhook URL")
        content.addView(endpointField)
        tokenField = input("SMS_FORWARDER_TOKEN").apply {
            inputType = android.text.InputType.TYPE_CLASS_TEXT or
                android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD
        }
        content.addView(tokenField)
        senderField = input("Allowed SMS sender (for example, MPESA)")
        content.addView(senderField)

        enabledToggle = CheckBox(this).apply {
            text = "Forward messages from this sender"
            textSize = 16f
        }
        content.addView(enabledToggle, margin(top = 16))

        content.addView(Button(this).apply {
            text = "Save settings"
            setOnClickListener { saveSettings() }
        }, margin(top = 12))

        statusText = text("", 14f)
        content.addView(statusText, margin(top = 16))
        content.addView(text(
            "Privacy: messages are checked against the sender name on this phone. " +
                "Only matching messages are queued for HTTPS forwarding. Pending messages " +
                "remain on this phone until the server accepts them.",
            13f
        ), margin(top = 20))
        setContentView(scroll)
    }

    private fun loadForm() {
        val config = RelaySettings.load(this)
        endpointField.setText(config.endpoint)
        tokenField.setText(config.token)
        senderField.setText(config.sender)
        enabledToggle.isChecked = config.enabled
        updateStatus()
    }

    private fun saveSettings() {
        val endpoint = endpointField.text.toString().trim()
        val token = tokenField.text.toString()
        val sender = senderField.text.toString().trim()
        if (!RelaySettings.isValidEndpoint(endpoint) || token.isBlank() || sender.isBlank()) {
            Toast.makeText(
                this,
                "Enter the Apps Script web app URL, token, and sender name.",
                Toast.LENGTH_LONG
            ).show()
            return
        }

        val wantsEnabled = enabledToggle.isChecked
        if (wantsEnabled && !hasSmsPermission()) {
            requestPermissions(arrayOf(Manifest.permission.RECEIVE_SMS), SMS_PERMISSION_REQUEST)
            return
        }
        persist(endpoint, token, sender, wantsEnabled)
    }

    private fun persist(endpoint: String, token: String, sender: String, enabled: Boolean) {
        RelaySettings.save(this, RelayConfig(endpoint, token, sender, enabled))
        if (enabled) enqueuePendingWork()
        updateStatus()
        Toast.makeText(this, "Settings saved.", Toast.LENGTH_SHORT).show()
    }

    private fun enqueuePendingWork() {
        val request = OneTimeWorkRequestBuilder<SmsForwardWorker>()
            .setConstraints(
                Constraints.Builder()
                    .setRequiredNetworkType(NetworkType.CONNECTED)
                    .build()
            )
            .build()
        WorkManager.getInstance(this).enqueueUniqueWork(
            SmsForwardWorker.WORK_NAME,
            ExistingWorkPolicy.APPEND_OR_REPLACE,
            request
        )
    }

    private fun updateStatus() {
        val config = RelaySettings.load(this)
        val permission = hasSmsPermission()
        val queued = try {
            RelaySettings.pending(this).size
        } catch (_: Exception) {
            statusText.text = "Could not read the pending message queue."
            return
        }
        val state = when {
            !config.enabled -> "Forwarding is off."
            !permission -> "SMS permission is missing. Save settings to enable it."
            else -> "Forwarding is on for sender “${config.sender}”."
        }
        statusText.text = "$state\nMessages waiting to send: $queued"
    }

    private fun hasSmsPermission(): Boolean =
        checkSelfPermission(Manifest.permission.RECEIVE_SMS) == PackageManager.PERMISSION_GRANTED

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != SMS_PERMISSION_REQUEST) return
        if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) {
            persist(
                endpointField.text.toString().trim(),
                tokenField.text.toString(),
                senderField.text.toString().trim(),
                true
            )
        } else {
            enabledToggle.isChecked = false
            Toast.makeText(this, "SMS permission is needed to forward messages.", Toast.LENGTH_LONG).show()
            updateStatus()
        }
    }

    private fun text(value: String, size: Float, bold: Boolean = false) =
        TextView(this).apply {
            text = value
            textSize = size
            if (bold) setTypeface(typeface, android.graphics.Typeface.BOLD)
        }

    private fun input(hintText: String) = EditText(this).apply {
        hint = hintText
        textSize = 15f
        setSingleLine(true)
        layoutParams = margin(top = 8)
    }

    private fun margin(top: Int = 0, bottom: Int = 0) =
        LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ).apply {
            topMargin = dp(top)
            bottomMargin = dp(bottom)
        }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    companion object {
        private const val SMS_PERMISSION_REQUEST = 41
    }
}

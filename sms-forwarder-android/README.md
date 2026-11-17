# Cavalry SMS Relay

A private-install Android app that forwards SMS messages only when the sender exactly matches the configured sender ID (default: `MPESA`). It sends messages to the existing Apps Script payment-SMS inbox using HTTPS form data. The inbox is for manual review only; forwarding never marks an invoice as paid.

## Configure the server

In the Apps Script project, set the Script Property `SMS_FORWARDER_TOKEN` to a long, unique secret. Deploy the updated web app and confirm its URL is the endpoint shown in the app.

The token is entered on the phone and is not included in this project. The Android app's private preferences store it locally. Do not use this app on a shared or rooted phone.

## Build and install privately

1. Open this `sms-forwarder-android` folder in Android Studio, or run `gradlew.bat assembleDebug` from this folder on Windows.
2. Allow Android Studio to install the Android SDK it requests (JDK 17, Android SDK 34).
3. Build and install the `app` run configuration on your Android phone. The debug APK is written to `app/build/outputs/apk/debug/app-debug.apk`.
4. On the phone, enter the endpoint, the same Script Property secret, and the exact sender ID shown on a real M-Pesa confirmation.
5. Enable forwarding and grant SMS permission. Send a small test payment and confirm it appears in the app's Admin dashboard under **Forwarded payment SMS**.

The app only accepts the configured Apps Script web-app URL on `script.google.com`, queues messages while offline, and retries forwarding when network access returns. A queued message is removed only after the server returns a success response. The server's message/time deduplication makes retries safe.

## Important

SMS contents can include personal and financial information. The Android app and webhook can access matching messages, so restrict the sender rule and protect the token. Android may pause background work under battery-saver settings; exempt the app from battery optimization if forwarding is delayed. Google Play restricts SMS permissions, so this project is intended for private installation, not Play Store publication.

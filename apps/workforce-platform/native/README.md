# Capacitor native shell (foundation only)

This project reuses the React/Vite SPA from `../client` and packages its static build from `../public/app`.

## Build prerequisites

- Node.js `>=22.20.0 <25`
- Android Studio + Android SDK for Android builds
- Xcode and Apple signing configuration on macOS for iOS builds
- A deployed HTTPS API origin for the eventual native client

Install this workspace's dependencies (`npm ci`), generate the platform project once with `npm run add:android` and/or `npm run add:ios`, then configure `VITE_API_BASE_URL` to the clean HTTPS origin of the Node API and run `npm run sync`. The native Vite build rejects non-HTTPS, path-qualified, credentialed or localhost API URLs. It never falls back to `localhost` or `127.0.0.1`.

The current SPA intentionally disables native sign-in. The web API uses same-origin, HttpOnly cookie sessions; a native token/refresh/revocation contract and an audited Keychain/Android Keystore storage plugin have not yet been implemented. Do not add credentials to `localStorage`, enable native account mutations, or ship signed apps until that security work and the matching API-origin/CORS tests are accepted.

The generated `android/` and `ios/` directories are not committed by default. No platform SDK build, signing, store upload, push-notification setup or production API has been verified in this repository.

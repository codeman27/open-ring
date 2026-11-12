# Open Ring (PWA)

**Live:** <https://open-ring.cody-roof.com>. On an Android phone, open it in Chrome and choose
*Install app* (or menu → *Add to Home screen*). Nothing else is needed on the phone: no developer
mode or Chrome flags. After the first load it works offline.

A cloud-free Oura ring app that runs in Chrome on Android and talks to the ring
directly over **Web Bluetooth**. Data never leaves the phone; it is stored in the
browser's IndexedDB.

It is a thin web shell over [open_oura](../open_oura): the protocol layer
(`oura-protocol`: packet framing, app-auth AES, request builders, history-batch
decoding and every event-body decoder) is compiled to WebAssembly, and
`src/client.ts` is a line-for-line port of `oura-link`'s `OuraClient` (handshake,
auth, extended/legacy history drain, features, live HR) onto Web Bluetooth. A
future native Android app can reuse the same Rust crate through JNI.

## Layout

| Path | What |
| --- | --- |
| `wasm/` | Rust `oura-wasm` crate: `wasm-bindgen` exports over `open_oura/crates/oura-protocol` |
| `src/ble.ts` | Web Bluetooth transport (`RingLink`), `transactUntil`, redacted protocol log |
| `src/client.ts` | `OuraClient` port (auth, pairing, time sync, history drain, features, live HR) |
| `src/session.ts` | Workflows: probe, pair, import key, sync, features, live HR |
| `src/db.ts` | IndexedDB store: rings, raw events (idempotent), sync cursor, readings, export |
| `src/timeline.ts` | Ring-clock → wall-clock dating and nightly/daily metrics |
| `src/App.tsx` | UI (Preact) |

## Develop

Prerequisites: Node 20+, Rust with `rustup target add wasm32-unknown-unknown`, and
`cargo install wasm-pack`. `open_oura` must sit next to this folder.

```bash
npm install
npm run dev          # builds the WASM module, then serves http://localhost:5173
npm test             # vitest (client + timeline) and the Rust bridge tests
npm run build        # type-check + production PWA in dist/
```

### Testing local changes on your phone: `npm run dev:phone`

Only needed for trying unreleased changes; the live site needs none of this.
Web Bluetooth only works on a secure origin (HTTPS or `http://localhost`), so a
plain LAN address won't work. `dev:phone` serves on all interfaces and, if a phone
is attached over `adb`, runs `adb reverse tcp:5173 tcp:5173` so **the phone's own
`http://localhost:5173`** reaches this machine.

1. On the phone: Settings → About phone → tap *Build number* 7× to enable
   Developer options. Then Developer options → **Wireless debugging** → on.
2. Tap *Pair device with pairing code*, then on this machine:
   ```bash
   ~/Android/Sdk/platform-tools/adb pair <ip>:<pairing-port>   # enter the 6-digit code
   ~/Android/Sdk/platform-tools/adb connect <ip>:<port>         # port shown on the Wireless debugging screen
   ```
   (A USB cable with USB debugging works too.)
3. `npm run dev:phone`, then open `http://localhost:5173` in Chrome on the phone.

No adb? Open `chrome://flags/#unsafely-treat-insecure-origin-as-secure` on the
phone, add the `http://<LAN-IP>:5173` URL the script prints, enable, relaunch
Chrome.

## Using it with your ring

1. **Check connection** (safe, read-only): reads firmware, serial and capabilities.
   While the ring is still paired to the Oura app, the phone's existing Bluetooth
   bond is reused, so this verifies that Web Bluetooth can reach the ring without
   changing anything.
2. **Pair**: the ring's app key can't be read from the Oura app without root, so
   the ring is factory-reset (Oura app → My Devices → Factory reset, after *Back
   up all data*) and this app installs its own key. Then **do not** set the ring
   up again in the Oura app; that would install Oura's key and lock this app out
   (see `open_oura/docs/factory-reset.md`).
3. **Back up the key** (Ring tab → Download .key). It is the only way back in
   without another factory reset, and it also works with the open_oura CLI
   (`oura --key-file oura-<serial>.key sync`).
4. **Sync** whenever you open the app. The ring buffers several days of history.

## Deployment

Every change that ships bumps `version` in `package.json` (`npm version patch|minor
--no-git-tag-version`). The app shows `v<version> · <commit> · built <time>` at the
bottom of every screen and at the top of the Bluetooth log, so you can confirm which
build the phone is running.

Pushing to `main` runs `.github/workflows/deploy.yml`: it checks out open_oura at a
pinned commit beside this repo, builds the WASM bridge, runs the tests, builds, and
syncs `dist/` to a private S3 bucket behind CloudFront (stack `open-ring-site`,
template `deploy/infra.yml`). The CSP allows `'wasm-unsafe-eval'` (required to
instantiate WebAssembly) and `Permissions-Policy` grants `bluetooth=(self)`.

## Limits of the PWA (vs. a native app)

- Sync only runs while the app is open (no background sync).
- Chrome may show the device picker once per app launch.
- Readiness/Sleep scores are not computed (Oura's models are proprietary); the app
  shows the underlying signals: HRV, lowest HR, SpO2, breathing, skin temperature,
  time in bed, daytime HR, MET.
- Event dating uses the nearest `time_sync`/`rtc_beacon` anchor; open_health's full
  reboot-epoch handling isn't ported yet.

// `npm run dev:phone`: serve the app to an Android phone for Web Bluetooth testing.
//
// Web Bluetooth only works in a secure context (HTTPS or http://localhost), so a
// plain LAN URL is not enough. Preferred path: `adb reverse` makes the phone's
// own http://localhost:5173 reach this machine (USB or Wireless debugging), which
// Chrome treats as secure. Fallback: open the LAN URL after allowing it in
// chrome://flags/#unsafely-treat-insecure-origin-as-secure.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir, networkInterfaces } from 'node:os';
import { join } from 'node:path';

const PORT = 5173;

function findAdb() {
  const candidates = [
    process.env.ANDROID_HOME && join(process.env.ANDROID_HOME, 'platform-tools', 'adb'),
    join(homedir(), 'Android', 'Sdk', 'platform-tools', 'adb'),
    'adb',
  ].filter(Boolean);
  for (const c of candidates) {
    if (c === 'adb' || existsSync(c)) {
      const r = spawnSync(c, ['version'], { encoding: 'utf8' });
      if (r.status === 0) return c;
    }
  }
  return null;
}

const lanIps = Object.values(networkInterfaces())
  .flat()
  .filter((i) => i && i.family === 'IPv4' && !i.internal)
  .map((i) => i.address);

const vite = spawn('npx', ['vite', '--host', '0.0.0.0', '--port', String(PORT)], { stdio: 'inherit' });
const stop = () => vite.kill('SIGINT');
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
vite.on('exit', (code) => process.exit(code ?? 0));

const line = '─'.repeat(64);
const adb = findAdb();
let reversed = false;
if (adb) {
  const devices = spawnSync(adb, ['devices'], { encoding: 'utf8' }).stdout
    .split('\n')
    .slice(1)
    .filter((l) => /\tdevice$/.test(l));
  if (devices.length) {
    reversed = spawnSync(adb, ['reverse', `tcp:${PORT}`, `tcp:${PORT}`]).status === 0;
  }
}

setTimeout(() => {
  console.log(`\n${line}`);
  if (reversed) {
    console.log(`📱 Phone connected over adb. On the phone, open in Chrome:\n\n     http://localhost:${PORT}\n`);
  } else {
    console.log('📱 To test on your Android phone (Web Bluetooth needs a secure origin):\n');
    console.log('  Option A (recommended): connect the phone with adb (USB, or Settings →');
    console.log('    Developer options → Wireless debugging → "Pair device with pairing code",');
    console.log('    then `adb pair <ip:port>` and `adb connect <ip:port>`), and rerun');
    console.log(`    \`npm run dev:phone\`. Then open http://localhost:${PORT} on the phone.`);
    console.log(adb ? '' : '    (adb not found: install Android platform-tools.)');
    console.log('  Option B: same Wi-Fi, no adb. In phone Chrome open');
    console.log('    chrome://flags/#unsafely-treat-insecure-origin-as-secure, add the URL');
    console.log('    below, set it to Enabled, relaunch Chrome, then open it:\n');
    for (const ip of lanIps) console.log(`     http://${ip}:${PORT}`);
  }
  console.log(`${line}\n`);
}, 1500);

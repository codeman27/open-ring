import { render } from 'preact';
import { App } from './App';
import { ready } from './wasm';
import { protocolLog } from './ble';
import { versionLabel } from './version';
import './styles.css';

protocolLog.push('info', `Open Ring ${versionLabel()}`);

// Updates wait for the user: an automatic reload mid-pairing or mid-sync would
// drop the Bluetooth link. The new service worker takes over immediately
// (skipWaiting + clientsClaim), so offer a reload once it controls the page.
if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) window.dispatchEvent(new CustomEvent('open-ring:update', { detail: () => window.location.reload() }));
  });
  navigator.serviceWorker.register('/sw.js').then((reg) => {
    // Check for a new version whenever the app comes back to the foreground.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reg.update().catch(() => undefined);
    });
  }, () => undefined);
}

ready().then(
  () => render(<App />, document.getElementById('app')!),
  (e) => {
    document.getElementById('app')!.textContent = `Failed to load the protocol module: ${e}`;
  },
);

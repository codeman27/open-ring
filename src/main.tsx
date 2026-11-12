import { render } from 'preact';
import { registerSW } from 'virtual:pwa-register';
import { App } from './App';
import { ready } from './wasm';
import { protocolLog } from './ble';
import { versionLabel } from './version';
import './styles.css';

protocolLog.push('info', `Open Ring ${versionLabel()}`);

// Updates wait for the user: an automatic reload mid-pairing or mid-sync would
// drop the Bluetooth link.
const updateSW = registerSW({
  immediate: true,
  onNeedRefresh() {
    window.dispatchEvent(new CustomEvent('open-ring:update', { detail: () => updateSW(true) }));
  },
});

ready().then(
  () => render(<App />, document.getElementById('app')!),
  (e) => {
    document.getElementById('app')!.textContent = `Failed to load the protocol module: ${e}`;
  },
);

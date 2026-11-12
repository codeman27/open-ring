import { render } from 'preact';
import { registerSW } from 'virtual:pwa-register';
import { App } from './App';
import { ready } from './wasm';
import { protocolLog } from './ble';
import { versionLabel } from './version';
import './styles.css';

protocolLog.push('info', `Open Ring ${versionLabel()}`);

registerSW({ immediate: true });

ready().then(
  () => render(<App />, document.getElementById('app')!),
  (e) => {
    document.getElementById('app')!.textContent = `Failed to load the protocol module: ${e}`;
  },
);

import { render } from 'preact';
import { registerSW } from 'virtual:pwa-register';
import { App } from './App';
import { ready } from './wasm';
import './styles.css';

registerSW({ immediate: true });

ready().then(
  () => render(<App />, document.getElementById('app')!),
  (e) => {
    document.getElementById('app')!.textContent = `Failed to load the protocol module: ${e}`;
  },
);

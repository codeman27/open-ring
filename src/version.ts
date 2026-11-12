declare const __APP_VERSION__: string;
declare const __APP_COMMIT__: string;
declare const __APP_BUILT__: string;

export const APP_VERSION = __APP_VERSION__;
export const APP_COMMIT = __APP_COMMIT__;
export const APP_BUILT = __APP_BUILT__;

/** e.g. "v0.2.0 · 8ebd4f6 · Nov 12, 10:10 AM" */
export function versionLabel(): string {
  const built = new Date(APP_BUILT).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return `v${APP_VERSION} · ${APP_COMMIT} · built ${built}`;
}

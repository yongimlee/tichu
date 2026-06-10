import type { CapacitorConfig } from '@capacitor/cli';

// Capacitor wraps the built web client (web/dist) into a native Android shell.
// webDir points at Vite's build output. The app loads from a local scheme
// (https://localhost on Android) and connects to the deployed game server over
// the network — see web/.env.mobile (VITE_SERVER_URL) and the server's CORS
// allowlist in server/src/index.ts.
const config: CapacitorConfig = {
  appId: 'com.tichu.app',
  appName: 'Tichu',
  webDir: 'dist',
};

export default config;

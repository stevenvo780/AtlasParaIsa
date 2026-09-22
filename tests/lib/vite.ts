import { createServer } from 'vite';

/** Browser fixtures load source modules but never edit them or exercise HMR.
 * Watching the repository also watches active laboratory SQLite/WAL files;
 * their events can starve test timers before a browser even starts. */
export function createBrowserTestServer() {
  return createServer({
    configFile: false,
    optimizeDeps: { entries: ['index.html'] },
    server: { host: '127.0.0.1', port: 0, watch: null },
    logLevel: 'error',
  });
}

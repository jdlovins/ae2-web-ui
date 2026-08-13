import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { existsSync, createReadStream } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mockApi } from './mock/mockApi.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Set AE2_TARGET to proxy the API to a real server instead of the mock, e.g.
//   AE2_TARGET=http://127.0.0.1:65500 npm run dev
const TARGET = process.env.AE2_TARGET;
const API_ROUTES = ['/grids', '/items', '/list', '/get', '/order', '/job', '/cancelcpu', '/trackinghistory', '/gettracking', '/gridsettings', '/icon', '/auth'];

// The gateway service (../gateway). Independent of AE2_TARGET: it is
// our own service, not the mod, so it is proxied in both mock and live modes.
const GATEWAY_TARGET = process.env.AE2_GATEWAY || 'http://127.0.0.1:8081';

// Dev-only: serve /icons/<file>.png from ./icons, mirroring what nginx does in
// production (`try_files $uri =404`). Generate the pack with `npm run icons`.
//
// A missing icon MUST 404 rather than return a placeholder: ItemIcon.svelte
// relies on <img onerror> to fall back to a glyph, and a 200 response silently
// defeats that — a missing icon then renders as a blank/black box in dev while
// behaving correctly in production.
function devIcons() {
  const dir = resolve(__dirname, 'icons');
  return {
    name: 'dev-icons',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url || !req.url.startsWith('/icons/')) return next();
        const name = decodeURIComponent(req.url.slice('/icons/'.length).split('?')[0]);
        if (name.includes('..') || name.includes('/')) { res.statusCode = 400; return res.end(); }
        const file = resolve(dir, name);
        if (!existsSync(file)) { res.statusCode = 404; return res.end(); }
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'no-cache');
        createReadStream(file).pipe(res);
      });
    },
  };
}

export default defineConfig({
  plugins: [svelte(), devIcons(), ...(TARGET ? [] : [mockApi()])],
  server: {
    port: 5273,
    proxy: {
      '/history': { target: GATEWAY_TARGET, changeOrigin: true },
      ...(TARGET ? Object.fromEntries(API_ROUTES.map((r) => [r, { target: TARGET, changeOrigin: true }])) : {}),
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});

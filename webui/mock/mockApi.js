// Vite dev plugin: serves the mod's JSON API from canned data so the whole UI
// can be built and reviewed without a live Minecraft server. It mirrors the
// {status:"OK", data:...} envelope and the exact routes of AE2Controller.
import { ITEMS, GRIDS, CPUS, cpuDetail, craftingPlan, HISTORY, trackingData, PLACEHOLDER_PNG } from './data.js';

function ok(res, data) {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ status: 'OK', data }));
}
function fail(res, status, data = '') {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ status, data }));
}

// Simulate the async crafting-plan calculation: a job is "done" ~800ms after order.
const jobs = new Map();
let jobSeq = 500;
let forceOne401 = false; // toggled by /__mock/expire to exercise silent re-auth

export function mockApi() {
  return {
    name: 'ae2-mock-api',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url, 'http://localhost');
        const p = url.pathname;
        const q = url.searchParams;

        // Only intercept API routes; let Vite serve the app + assets.
        const apiRoutes = ['/grids', '/items', '/list', '/get', '/order', '/job', '/cancelcpu', '/trackinghistory', '/gettracking', '/gridsettings', '/icon', '/auth', '/__mock/expire'];
        if (!apiRoutes.includes(p)) return next();

        res.setHeader('Access-Control-Allow-Origin', '*');

        if (p === '/__mock/expire') { forceOne401 = true; res.end('will 401 once'); return; }

        if (p === '/auth') {
          // POST body: username=Admin&password=...&remember=on
          let body = '';
          req.on('data', (c) => (body += c));
          req.on('end', () => {
            const params = new URLSearchParams(body);
            const pw = params.get('password') || '';
            if (pw === 'wrong') { res.statusCode = 400; res.end('invalidpassword'); return; }
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ token: 'mock-token-' + Date.now(), username: 'Admin', isAdmin: true, isOutdated: false }));
          });
          return;
        }

        if (forceOne401) { forceOne401 = false; res.statusCode = 401; res.end(); return; }

        switch (p) {
          case '/grids':
            return ok(res, GRIDS);
          case '/items':
            return ok(res, ITEMS);
          case '/list':
            return ok(res, CPUS);
          case '/get':
            return ok(res, cpuDetail(q.get('cpu')));
          case '/cancelcpu':
            return ok(res, 'cancelled');
          case '/gridsettings': {
            const grid = GRIDS.find((g) => String(g.key) === q.get('grid'));
            const track = q.get('track') === '1';
            if (grid) grid.isTrackingEnabled = track;
            return ok(res, { isTracked: track });
          }
          case '/order': {
            const id = ++jobSeq;
            jobs.set(id, Date.now());
            return ok(res, { jobID: id });
          }
          case '/job': {
            const id = Number(q.get('id'));
            if (q.has('cancel')) { jobs.delete(id); return ok(res, 'cancelled'); }
            if (q.has('submit')) { jobs.delete(id); return ok(res, 'submitted'); }
            const started = jobs.get(id) || 0;
            if (Date.now() - started < 800) return ok(res, { isDone: false });
            return ok(res, craftingPlan());
          }
          case '/trackinghistory':
            return ok(res, HISTORY);
          case '/gettracking':
            return ok(res, trackingData(q.get('id')));
          case '/icon': {
            const hashes = (q.get('items') || '').split(',').filter(Boolean);
            return ok(res, hashes.map((hc) => ({ hashcode: Number(hc), pngData: PLACEHOLDER_PNG })));
          }
          default:
            return fail(res, 'NOT_FOUND', p);
        }
      });
    },
  };
}

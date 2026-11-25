// Human-run smoke test: imports the dashboards into a Grafana instance and runs every
// panel and variable query against Prometheus through Grafana's datasource proxy.
//
//   GRAFANA_URL=https://<host> GRAFANA_TOKEN=<service-account-token> PROM_DS_UID=<uid> \
//     node observability/grafana/tools/smoke-test.mjs [--no-import] [--folder "gh-aw (test)"]
//
// Exit code is non-zero when any query returns an ERROR. NO DATA is reported but is not an
// error (Tier B panels are expected to have none). Zero dependencies; Node 18+.
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allMetricNames } from '../definitions/common.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const DASH_DIR = join(here, '..', 'dashboards');

const { GRAFANA_URL, GRAFANA_TOKEN, PROM_DS_UID } = process.env;
const args = process.argv.slice(2);
const folderTitle = args.includes('--folder') ? args[args.indexOf('--folder') + 1] : 'gh-aw (test)';
const doImport = !args.includes('--no-import');

if (!GRAFANA_URL || !GRAFANA_TOKEN || !PROM_DS_UID) {
  console.error('Set GRAFANA_URL, GRAFANA_TOKEN and PROM_DS_UID.');
  process.exit(2);
}
const base = GRAFANA_URL.replace(/\/$/, '');

async function api(path, init = {}) {
  const res = await fetch(base + path, {
    ...init,
    headers: {
      Authorization: `Bearer ${GRAFANA_TOKEN}`,
      'Content-Type': 'application/json',
      // Lets requests through the ngrok interstitial.
      'ngrok-skip-browser-warning': '1',
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status}: ${typeof body === 'string' ? body.slice(0, 200) : JSON.stringify(body).slice(0, 300)}`);
  return body;
}

async function ensureFolder(title) {
  const folders = await api('/api/folders');
  const found = folders.find((f) => f.title === title);
  if (found) return found.uid;
  return (await api('/api/folders', { method: 'POST', body: JSON.stringify({ title }) })).uid;
}

// Substitute dashboard variables so queries can run outside the dashboard UI.
function expand(expr, vars) {
  return expr
    .replace(/\$__range/g, vars.range)
    .replace(/\$__rate_interval/g, '5m')
    .replace(/\$\{?slo_window\}?/g, '7d')
    .replace(/\$\{?(price_[a-z_]+)\}?/g, (_, n) => vars.textbox[n] ?? '0')
    .replace(/\$\{?(workflow|job|engine|model|result)\}?/g, '.*');
}

async function runQuery(expr, vars) {
  const now = Date.now();
  const body = {
    from: String(now - 7 * 24 * 3600 * 1000),
    to: String(now),
    queries: [{ refId: 'A', datasource: { type: 'prometheus', uid: PROM_DS_UID }, expr: expand(expr, vars), instant: true, range: false, intervalMs: 60000, maxDataPoints: 100 }],
  };
  try {
    const res = await api('/api/ds/query', { method: 'POST', body: JSON.stringify(body) });
    const r = res.results?.A;
    if (r?.error) return { status: 'ERROR', detail: r.error };
    const frames = r?.frames ?? [];
    const rows = frames.reduce((n, f) => n + (f.data?.values?.[0]?.length ?? 0), 0);
    return rows > 0 ? { status: 'OK', detail: `${frames.length} series` } : { status: 'NO DATA', detail: '' };
  } catch (e) {
    return { status: 'ERROR', detail: e.message };
  }
}

async function listMetricNames() {
  try {
    const res = await api(`/api/datasources/proxy/uid/${PROM_DS_UID}/api/v1/label/__name__/values`);
    return (res.data ?? []).filter((n) => /^(gh_aw_|gen_ai_)/.test(n));
  } catch (e) {
    console.error(`(could not list metric names: ${e.message})`);
    return null;
  }
}

const files = readdirSync(DASH_DIR).filter((f) => f.endsWith('.json')).sort();
const rows = [];
let errors = 0;
const vars = { range: '7d', textbox: {} };

if (doImport) {
  const folderUid = await ensureFolder(folderTitle);
  for (const f of files) {
    const dashboard = JSON.parse(readFileSync(join(DASH_DIR, f), 'utf8'));
    // Point the $ds variable at the chosen datasource so the imported dashboard works as-is.
    const ds = dashboard.templating.list.find((v) => v.name === 'ds');
    ds.current = { text: PROM_DS_UID, value: PROM_DS_UID };
    await api('/api/dashboards/db', { method: 'POST', body: JSON.stringify({ dashboard, folderUid, overwrite: true, message: 'gh-aw smoke test import' }) });
    console.log(`imported ${dashboard.title} -> ${base}/d/${dashboard.uid}`);
  }
}

for (const f of files) {
  const dashboard = JSON.parse(readFileSync(join(DASH_DIR, f), 'utf8'));
  for (const v of dashboard.templating.list.filter((v) => v.type === 'query')) {
    // label_values(metric{...}, label) -> series selector query on the metric
    const m = v.definition.match(/label_values\(([^,]+(?:\{[^}]*\})?),\s*([a-z_]+)\)/);
    const r = await runQuery(`count by (${m[2]}) (${m[1]})`, vars);
    rows.push({ dashboard: dashboard.title, panel: `variable $${v.name}`, tier: '-', ...r });
  }
  const panels = dashboard.panels.flatMap((p) => (p.type === 'row' ? p.panels : [p]));
  for (const p of panels) {
    const tier = /Tier B/.test(p.description) ? 'B' : 'A';
    for (const t of p.targets) {
      const r = await runQuery(t.expr, vars);
      if (r.status === 'ERROR') errors++;
      rows.push({ dashboard: dashboard.title, panel: p.title + (p.targets.length > 1 ? ` [${t.refId}]` : ''), tier, ...r });
    }
  }
}

console.log('\nStatus   Tier  Dashboard / Panel');
for (const r of rows) {
  const expected = r.status === 'NO DATA' && r.tier === 'B' ? ' (expected: Tier B)' : '';
  console.log(`${r.status.padEnd(8)} ${r.tier.padEnd(5)} ${r.dashboard} / ${r.panel}${r.detail ? ` - ${r.detail}` : ''}${expected}`);
}

const present = await listMetricNames();
if (present) {
  const known = allMetricNames();
  console.log('\nName map check (metrics expected by the dashboards):');
  for (const [n, { tier }] of known) console.log(`${present.includes(n) ? 'present' : 'MISSING'}  ${tier}  ${n}`);
  const extra = present.filter((n) => !known.has(n));
  if (extra.length) console.log(`\nOther gh_aw_* / gen_ai_* series in Prometheus (not used): ${extra.join(', ')}`);
}

const summary = { ok: 0, 'NO DATA': 0, ERROR: 0 };
for (const r of rows) summary[r.status === 'OK' ? 'ok' : r.status]++;
console.log(`\nSummary: ${summary.ok} OK, ${summary['NO DATA']} NO DATA, ${summary.ERROR} ERROR`);
process.exit(errors ? 1 : 0);

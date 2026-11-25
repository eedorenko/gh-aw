import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { generateAll, generateAlerts, buildDashboard, DEFINITIONS, DASHBOARD_DIR, ALERTS_FILE } from './generate.mjs';
import { SLIS, SLI_BY_ID, FACTORS, thresholdSteps, fleetExpr, gaugeSteps, gaugeLabel, gaugeSlis } from '../definitions/slo.mjs';
import { allMetricNames, ALIAS_NAMES, LABELS, VARIABLE_NAMES, TEXTBOX_VARIABLES, METRICS } from '../definitions/common.mjs';

const dashboards = DEFINITIONS.map((def) => ({ def, json: buildDashboard(def) }));

function flattenPanels(dashboard) {
  const out = [];
  for (const p of dashboard.panels) {
    if (p.type === 'row') {
      for (const c of p.panels) out.push({ panel: c, row: p.title });
    } else {
      out.push({ panel: p, row: null });
    }
  }
  return out;
}

const queriesOf = (panel) => panel.targets.map((t) => t.expr);

test('committed dashboard JSON is fresh', () => {
  const files = readdirSync(DASHBOARD_DIR).filter((f) => f.endsWith('.json')).sort();
  const expected = generateAll();
  assert.deepEqual(files, expected.map((e) => e.file).sort());
  for (const { file, content } of expected) {
    assert.equal(readFileSync(join(DASHBOARD_DIR, file), 'utf8'), content, `${file} is stale; run tools/generate.mjs`);
  }
});

test('generator output is deterministic', () => {
  assert.deepEqual(generateAll(), generateAll());
});

test('committed alert rules are fresh', () => {
  assert.equal(readFileSync(ALERTS_FILE, 'utf8'), generateAlerts(), 'alerts.rules.yml is stale; run tools/generate.mjs');
});

test('seven dashboards (1 glance, 5 scan, 1 commit) with unique uid and title', () => {
  assert.equal(dashboards.length, 7);
  assert.equal(new Set(dashboards.map((d) => d.json.uid)).size, 7);
  assert.equal(new Set(dashboards.map((d) => d.json.title)).size, 7);
  assert.deepEqual(dashboards.map((d) => d.json.uid).sort(), [
    'gh-aw-slo-availability', 'gh-aw-slo-cost', 'gh-aw-slo-overview', 'gh-aw-slo-quality',
    'gh-aw-slo-responsiveness', 'gh-aw-slo-throughput', 'gh-aw-workflow-drilldown',
  ]);
  for (const f of Object.values(FACTORS)) assert.ok(dashboards.some((d) => d.json.uid === f.uid), f.uid);
});

const byUid = (uid) => dashboards.find((d) => d.json.uid === uid).json;

test('SLI table: every SLI has a factor, query, and a coherent SLO', () => {
  assert.equal(SLIS.length, 15);
  assert.equal(new Set(SLIS.map((s) => s.id)).size, SLIS.length);
  for (const s of SLIS) {
    assert.ok(FACTORS[s.factor], `${s.id} factor`);
    assert.equal(typeof s.expr, 'function');
    if (s.informational) continue;
    assert.ok(['min', 'max'].includes(s.dir), `${s.id} dir`);
    assert.equal(typeof s.slo, 'number', `${s.id} slo`);
    if (s.amber !== undefined) {
      // Amber sits on the "bad" side of the SLO: lower for floors, higher for ceilings.
      assert.ok(s.dir === 'min' ? s.amber < s.slo : s.amber > s.slo, `${s.id} amber must be beyond the SLO`);
    }
  }
});

test('SLO thresholds from the spec', () => {
  const t = (id) => [SLI_BY_ID.get(id).dir, SLI_BY_ID.get(id).slo, SLI_BY_ID.get(id).amber];
  assert.deepEqual(t('A2'), ['max', 0.02, 0.04]);
  assert.deepEqual(t('R1'), ['max', 1200, 1500]);
  assert.deepEqual(t('T1'), ['min', 0.6, 0.4]);
  assert.deepEqual(t('T2'), ['min', 0.5, 0.3]);
  assert.deepEqual(t('Q1'), ['min', 0.95, 0.9]);
  assert.deepEqual(t('Q2'), ['min', 0.9, 0.8]);
  assert.deepEqual(t('Q3'), ['max', 0.05, 0.1]);
  assert.deepEqual(t('C1'), ['max', 1.5, 2]);
  assert.deepEqual(t('C2'), ['max', 2, 3]);
  assert.deepEqual(t('C3'), ['min', 0.4, 0.2]);
});

test('threshold steps colour the right side of the SLO', () => {
  const floor = thresholdSteps(SLI_BY_ID.get('Q1'));
  assert.equal(floor.base, 'red');
  assert.deepEqual(floor.steps, [[0.9, 'orange'], [0.95, 'green']]);
  const ceiling = thresholdSteps(SLI_BY_ID.get('Q3'));
  assert.equal(ceiling.base, 'green');
  assert.equal(ceiling.steps[0][1], 'orange');
  assert.ok(ceiling.steps[0][0] > 0.05, 'value exactly at the SLO still counts as met');
  assert.equal(ceiling.steps[1][1], 'red');
  const count = thresholdSteps(SLI_BY_ID.get('A4'));
  assert.deepEqual(count.steps, [[1, 'red']]);
  assert.equal(thresholdSteps(SLI_BY_ID.get('A3')), null);
});

test('glance: telemetry banner plus five factor gauges showing the worst SLI value, each linking to its scan dashboard', () => {
  const glance = byUid('gh-aw-slo-overview');
  assert.equal(glance.panels.length, 6, 'banner + 5 factor panels, nothing else');
  const banner = glance.panels.filter((p) => p.title.startsWith('Telemetry health'));
  assert.equal(banner.length, 1, 'A4 banner');
  assert.equal(banner[0].gridPos.y, 0, 'banner is row 0');
  const factors = glance.panels.filter((p) => p !== banner[0]);
  assert.deepEqual(factors.map((p) => p.title), Object.values(FACTORS).map((f) => f.label));
  assert.equal(new Set(factors.map((p) => p.gridPos.y)).size, 1, 'factor panels share one row');
  assert.ok(factors.every((p) => p.gridPos.y >= banner[0].gridPos.h), 'factor row is below the banner');
  for (const [factor, f] of Object.entries(FACTORS)) {
    const p = factors.find((x) => x.title === f.label);
    assert.equal(p.type, 'gauge', `${p.title} is a gauge`);
    assert.ok(p.fieldConfig.defaults.links[0].url.includes(f.uid), `${p.title} links to its scan dashboard`);
    const slis = gaugeSlis(factor);
    assert.equal(p.targets.length, slis.length, `${p.title}: one query per SLI`);
    assert.equal(p.fieldConfig.overrides.length, slis.length, `${p.title}: one override per SLI`);
    slis.forEach((s, i) => {
      const ref = String.fromCharCode(65 + i);
      assert.equal(p.targets[i].refId, ref);
      assert.equal(p.targets[i].legendFormat, gaugeLabel(s), `${s.id} legend names the SLI and its SLO`);
      const o = p.fieldConfig.overrides.find((x) => x.matcher.id === 'byFrameRefID' && x.matcher.options === ref);
      assert.ok(o, `${p.title}: override for ${s.id}`);
      const prop = (id) => o.properties.find((x) => x.id === id).value;
      assert.equal(prop('unit'), s.suffix ? `suffix:${s.suffix}` : s.unit, `${s.id} unit`);
      assert.deepEqual([prop('min'), prop('max')], s.range);
      const steps = prop('thresholds').steps;
      assert.ok(steps.length >= 2, `${s.id} has colour boundaries, not just a base colour`);
      assert.equal(steps[0].color, s.dir === 'min' ? 'red' : 'green', `${s.id} base colour`);
      assert.equal(steps.at(-1).color, s.dir === 'min' ? 'green' : 'red', `${s.id} far-side colour`);
    });
    // Panel defaults (what shows when an override cannot match) already carry real scale and thresholds.
    const d = p.fieldConfig.defaults;
    assert.deepEqual([d.min, d.max], slis[0].range, `${p.title}: default range matches its first SLI`);
    assert.ok(d.thresholds.steps.length >= 2, `${p.title}: default thresholds have boundaries`);
  }
});

test('gauge steps: red at breach, yellow when approaching, SLO value itself is not breached', () => {
  const q1 = gaugeSteps(SLI_BY_ID.get('Q1'));
  assert.deepEqual(q1, { base: 'red', steps: [[0.95, 'yellow'], [0.97, 'green']] });
  const r1 = gaugeSteps(SLI_BY_ID.get('R1'));
  assert.equal(r1.base, 'green');
  assert.equal(r1.steps[0][1], 'yellow');
  assert.equal(r1.steps[1][1], 'red');
  assert.ok(r1.steps[1][0] > 1200, 'exactly 20 min still counts as met');
  assert.ok(r1.steps[0][0] < 1200, 'yellow starts before the SLO');
  assert.deepEqual(gaugeSteps(SLI_BY_ID.get('A4')).steps.map((x) => x[1]), ['red']);
});

test('gauge margins: warn sits inside the SLO side, ranges contain SLO and warn', () => {
  for (const s of SLIS.filter((x) => !x.informational)) {
    assert.ok(Array.isArray(s.range) && s.range[0] < s.range[1], `${s.id} range`);
    assert.ok(s.slo >= s.range[0] && s.slo <= s.range[1], `${s.id} range holds the SLO`);
    if (s.warn !== undefined) {
      assert.ok(s.dir === 'min' ? s.warn > s.slo : s.warn < s.slo, `${s.id} warn is on the good side of the SLO`);
      assert.ok(s.warn >= s.range[0] && s.warn <= s.range[1], `${s.id} range holds warn`);
    }
  }
});

test('scan: every panel traces to SLI ids of its own factor; each table is sorted worst-first', () => {
  for (const [factor, f] of Object.entries(FACTORS)) {
    const json = byUid(f.uid);
    const panels = flattenPanels(json).map((x) => x.panel);
    assert.ok(panels.some((p) => p.type === 'table'), `${f.uid} has a per-workflow table`);
    assert.ok(panels.some((p) => p.type === 'timeseries' && p.targets.some((t) => t.legendFormat === 'SLO' || /^[A-Z]\d /.test(t.legendFormat))), `${f.uid} has an SLI vs SLO time series`);
    for (const p of panels) {
      const m = p.description.match(/SLI: ([A-Z0-9, ]+)\./);
      assert.ok(m, `${f.uid}/${p.title} has no SLI trace`);
      for (const id of m[1].split(',').map((x) => x.trim())) {
        assert.ok(SLI_BY_ID.has(id), `${p.title}: unknown SLI ${id}`);
        assert.equal(SLI_BY_ID.get(id).factor, factor, `${p.title}: SLI ${id} belongs to another factor`);
      }
    }
    const table = panels.find((p) => p.title.includes('SLIs per workflow'));
    assert.ok(table.options.sortBy.length === 1, `${f.uid} table sorted`);
    assert.ok(table.fieldConfig.overrides.some((o) => o.properties.some((x) => x.id === 'links')), `${f.uid} workflow column links to the drilldown`);
  }
});

test('scan SLI-vs-SLO series draw the SLO as a dashed line', () => {
  const q = byUid('gh-aw-slo-quality');
  const p = flattenPanels(q).map((x) => x.panel).find((x) => x.title.startsWith('Q1 '));
  assert.ok(p.targets.some((t) => t.expr === 'vector(0.95)' && t.legendFormat === 'SLO'));
  assert.ok(p.fieldConfig.overrides.some((o) => o.matcher.options === 'SLO' && o.properties.some((x) => x.id === 'custom.lineStyle')));
});

test('commit: drilldown has workflow/job/model variables and links out to GitHub Actions', () => {
  const d = byUid('gh-aw-workflow-drilldown');
  const names = d.templating.list.map((v) => v.name);
  for (const n of ['workflow', 'job', 'model', 'gh_repo']) assert.ok(names.includes(n), n);
  assert.ok(d.links.some((l) => l.url === 'https://github.com/${gh_repo}/actions'));
  const exprs = flattenPanels(d).flatMap(({ panel }) => queriesOf(panel)).join('\n');
  for (const needle of [LABELS.errorType, 'gh_aw_tool_status', 'gh_aw_safe_output_type', 'gh_aw_agent_turns']) assert.ok(exprs.includes(needle), needle);
});

test('every dashboard carries the gh-aw tag and a dashboards link for navigation', () => {
  for (const { json } of dashboards) {
    assert.ok(json.tags.includes('gh-aw'));
    assert.ok(json.links.some((l) => l.type === 'dashboards' && l.tags.includes('gh-aw')));
  }
});

test('SLO window variable is defined wherever $slo_window is used', () => {
  for (const { json } of dashboards) {
    const text = JSON.stringify(json.panels);
    if (text.includes('$slo_window')) assert.ok(json.templating.list.some((v) => v.name === 'slo_window' && v.query === '7d'), json.uid);
  }
});

test('alerts: one rule per SLI alert, thresholds come from the SLI table', () => {
  const yaml = generateAlerts();
  const withAlert = SLIS.filter((s) => s.alert);
  assert.deepEqual(withAlert.map((s) => s.alert.name).sort(), [
    'GhAwFleetSilent', 'GhAwHighFailureRate', 'GhAwHighIncompleteRate', 'GhAwSlowAgentJobs', 'GhAwTelemetryBroken', 'GhAwTimedOutJobs', 'GhAwTokenBurnSpike',
  ].sort());
  for (const s of withAlert) {
    const block = yaml.split('      - alert: ').find((b) => b.startsWith(s.alert.name));
    assert.ok(block, s.alert.name);
    assert.match(block, new RegExp(`sli: ${s.id}`));
    assert.ok(block.includes(` ${s.dir === 'min' ? '<' : '>'} ${s.slo}`), `${s.alert.name} uses the SLO threshold`);
    assert.ok(!block.includes('$'), `${s.alert.name} has no dashboard variables`);
  }
  assert.ok(!/gh_aw_ai_credits_usage_total/.test(yaml), 'no alerts on Tier B metrics');
});

test('alert rules where a quiet fleet would misfire require a minimum job count', () => {
  const yaml = generateAlerts();
  for (const s of SLIS.filter((x) => x.alert?.minJobs)) {
    const block = yaml.split('      - alert: ').find((b) => b.startsWith(s.alert.name));
    assert.match(block, />= \d+\)/, `${s.alert.name} needs a job-count guard`);
  }
});

test('fleet queries carry no $workflow filter (glance is fleet level)', () => {
  for (const s of SLIS) assert.ok(!fleetExpr(s).includes('$workflow'), s.id);
});

for (const { def, json } of dashboards) {
  const panels = flattenPanels(json);

  test(`${def.uid}: unique panel ids and no overlapping gridPos`, () => {
    const ids = json.panels.flatMap((p) => [p.id, ...(p.panels ?? []).map((c) => c.id)]);
    assert.equal(new Set(ids).size, ids.length);
    // Top-level (visible) panels must not overlap; collapsed children are laid out under their row.
    const visible = json.panels;
    for (let i = 0; i < visible.length; i++) {
      for (let j = i + 1; j < visible.length; j++) {
        const a = visible[i].gridPos;
        const b = visible[j].gridPos;
        const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        assert.ok(!overlap, `${visible[i].title} overlaps ${visible[j].title}`);
      }
    }
    for (const { panel } of panels) assert.ok(panel.gridPos.x + panel.gridPos.w <= 24, panel.title);
  });

  test(`${def.uid}: every panel has description, unit, datasource variable and noValue`, () => {
    for (const { panel } of panels) {
      assert.match(panel.description, /^Question: .+/, panel.title);
      assert.match(panel.description, /Tier [AB]/, panel.title);
      assert.ok(panel.fieldConfig.defaults.unit, `${panel.title} unit`);
      assert.equal(panel.fieldConfig.defaults.noValue, 'No data');
      assert.equal(panel.datasource.uid, '${ds}');
      for (const t of panel.targets) assert.equal(t.datasource.uid, '${ds}');
    }
  });

  test(`${def.uid}: every $variable used in queries is defined`, () => {
    const defined = new Set(json.templating.list.map((v) => v.name));
    const builtin = new Set(['__range', '__rate_interval', '__interval', '__field', '__data', 'ds']);
    for (const { panel } of panels) {
      for (const expr of queriesOf(panel)) {
        for (const m of expr.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)) {
          assert.ok(defined.has(m[1]) || builtin.has(m[1]), `${panel.title}: undefined variable $${m[1]}`);
        }
      }
    }
    for (const v of json.templating.list) {
      if (v.type !== 'query') continue;
      for (const m of v.definition.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)) {
        assert.ok(defined.has(m[1]), `variable ${v.name} uses undefined $${m[1]}`);
      }
    }
    for (const name of def.variables) {
      assert.ok(VARIABLE_NAMES.includes(name) || name in TEXTBOX_VARIABLES, `unknown variable ${name}`);
    }
  });

  test(`${def.uid}: metrics come from the name map; no alias names; tier B only in tier B row`, () => {
    const known = allMetricNames();
    for (const { panel, row } of panels) {
      for (const expr of queriesOf(panel)) {
        const names = expr.match(/\b(?:gh_aw|gen_ai)_[a-z0-9_]+\b/g) ?? [];
        const metrics = names.filter((n) => !Object.values(LABELS).includes(n) && !n.endsWith('_name') && !n.endsWith('_id') && !n.endsWith('_type') && !n.endsWith('_status') && !n.endsWith('_model'));
        for (const n of metrics) {
          assert.ok(known.has(n), `${panel.title}: unknown metric ${n}`);
          assert.ok(!ALIAS_NAMES.some((a) => n.startsWith(a)), `${panel.title}: alias ${n}`);
          if (known.get(n).tier === 'B') assert.equal(row, 'Tier B: not emitted yet', `${panel.title}: tier B metric outside tier B row`);
        }
      }
      if (row === 'Tier B: not emitted yet') assert.equal(panel.description.includes('Tier B'), true);
    }
  });

  test(`${def.uid}: PromQL sanity`, () => {
    for (const { panel } of panels) {
      for (const expr of queriesOf(panel)) {
        const stripped = expr.replace(/"[^"]*"/g, '""');
        for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}']]) {
          assert.equal(stripped.split(open).length, stripped.split(close).length, `${panel.title}: unbalanced ${open}${close} in ${expr}`);
        }
        for (const m of expr.matchAll(/histogram_quantile\([^,]+,\s*(.{0,40})/g)) {
          assert.match(m[1], /^sum by \(le/, `${panel.title}: histogram_quantile must wrap sum by (le)`);
        }
        const knownLabels = new Set([...Object.values(LABELS), 'kind']);
        for (const m of expr.matchAll(/\bby \(([^)]*)\)/g)) {
          for (const l of m[1].split(',').map((s) => s.trim())) assert.ok(knownLabels.has(l), `${panel.title}: unknown label ${l}`);
        }
        assert.ok(!/gh_aw_tool_status=~?"success"/.test(expr), `${panel.title}: tool status is "ok"/"error", not "success"`);
        // `increase(...)` / `rate(...)` need a range selector.
        for (const m of expr.matchAll(/\b(?:increase|rate)\(([^()]*(?:\{[^}]*\})?[^()]*)\)/g)) {
          assert.match(m[1], /\[[^\]]+\]/, `${panel.title}: missing range in ${m[0]}`);
        }
      }
    }
  });

  test(`${def.uid}: stat and table panels never map null to zero`, () => {
    for (const { panel } of panels) {
      if (['stat', 'gauge', 'table', 'bargauge', 'piechart'].includes(panel.type)) {
        assert.ok(!('nullValueMode' in panel.options) && !('nullValueMode' in panel.fieldConfig.defaults));
      }
    }
  });
}

test('tool-call success uses status "ok"; failures use "error"', () => {
  const exprs = dashboards.flatMap(({ json }) => flattenPanels(json).flatMap(({ panel }) => queriesOf(panel)));
  assert.ok(exprs.some((e) => e.includes('gh_aw_tool_status="ok"')));
});

test('input counter is never used as non-cache input without subtracting cache', () => {
  const cost = byUid('gh-aw-slo-cost');
  const panel = flattenPanels(cost).find(({ panel: p }) => p.title === 'Tokens per hour by type').panel;
  assert.match(panel.targets[0].expr, /clamp_min\(.*cache_read.*cache_write/);
});

test('workflow-level dashboards link to GitHub Actions via $gh_repo', () => {
  for (const { json } of dashboards) {
    assert.ok(json.links.some((l) => l.url === 'https://github.com/${gh_repo}/actions'));
  }
});

test('metrics map covers every metric declared by definitions', () => {
  assert.ok(Object.values(METRICS).every((m) => ['A', 'B'].includes(m.tier)));
  assert.equal(METRICS.toolCalls.base, 'gh_aw_tool_calls_total');
});

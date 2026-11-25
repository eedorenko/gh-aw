// Builds importable Grafana dashboard JSON (schema 39) from the definitions in ./definitions.
//   node generate.mjs           write dashboards/*.json
//   node generate.mjs --check   fail if committed JSON differs from generator output
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VARIABLES, TEXTBOX_VARIABLES, VARIABLE_NAMES, ACTIONS_LINK } from '../definitions/common.mjs';
import { SLO_DASHBOARDS } from '../definitions/slo-dashboards.mjs';
import drilldown from '../definitions/workflow-drilldown.mjs';
import { alertRulesYaml } from '../definitions/slo.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const DASHBOARD_DIR = join(here, '..', 'dashboards');
export const ALERTS_FILE = join(here, '..', 'alerts', 'alerts.rules.yml');
export const DEFINITIONS = [...SLO_DASHBOARDS, drilldown];

const DS = { type: 'prometheus', uid: '${ds}' };
const GRID_WIDTH = 24;

export function panelDescription(panel) {
  const tier = panel.tier === 'B' ? 'Tier B: not emitted by gh-aw yet' : 'Tier A: emitted by gh-aw';
  const lines = [`Question: ${panel.question}`, `Metrics: ${tier}.`];
  if (panel.slis?.length) lines.push(`SLI: ${panel.slis.join(', ')}.`);
  if (panel.ignores) lines.push(`Ignores variables: ${panel.ignores}.`);
  if (panel.note) lines.push(panel.note);
  return lines.join('\n');
}

function fieldConfig(panel) {
  const defaults = {
    unit: panel.unit,
    // Missing is not zero: never map null to 0.
    noValue: 'No data',
    color: { mode: ['stat', 'gauge'].includes(panel.viz) && panel.thresholds ? 'thresholds' : 'palette-classic' },
  };
  if (panel.min !== undefined) defaults.min = panel.min;
  if (panel.max !== undefined) defaults.max = panel.max;
  if (panel.decimals !== undefined) defaults.decimals = panel.decimals;
  if (panel.thresholds) {
    defaults.thresholds = {
      mode: 'absolute',
      steps: [{ color: panel.thresholdBase ?? 'green', value: null }, ...panel.thresholds.map(([value, color]) => ({ color, value }))],
    };
  }
  if (panel.mappings) defaults.mappings = panel.mappings;
  const links = panel.links ?? (panel.link ? [panel.link] : []);
  if (links.length) defaults.links = links;
  const custom = {};
  if (panel.viz === 'timeseries') {
    Object.assign(custom, { drawStyle: 'line', lineWidth: 1, fillOpacity: panel.stack ? 20 : 8, showPoints: 'never', spanNulls: false });
    if (panel.stack) custom.stacking = { mode: 'normal', group: 'A' };
  }
  if (Object.keys(custom).length) defaults.custom = custom;
  return { defaults, overrides: [] };
}

function options(panel) {
  switch (panel.viz) {
    case 'stat':
      return {
        reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false },
        colorMode: panel.thresholds ? 'background' : 'none',
        graphMode: panel.sparkline ? 'area' : 'none',
        textMode: panel.textMode || 'auto',
        orientation: 'auto',
      };
    case 'gauge':
      return {
        reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false },
        showThresholdMarkers: true,
        showThresholdLabels: true,
        orientation: 'auto',
        minVizHeight: 75,
        minVizWidth: 75,
        sizing: 'auto',
      };
    case 'bargauge':
      return {
        reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false },
        displayMode: 'gradient',
        orientation: 'horizontal',
        showUnfilled: true,
      };
    case 'piechart':
      return {
        reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false },
        pieType: 'donut',
        legend: { displayMode: 'table', placement: 'right', values: ['value'] },
      };
    case 'heatmap':
      return {
        calculate: false,
        cellGap: 1,
        color: { mode: 'scheme', scheme: 'Spectral', scale: 'exponential', exponent: 0.5, steps: 64, reverse: false },
        yAxis: { axisPlacement: 'left', unit: panel.unit },
        legend: { show: true },
        tooltip: { show: true, yHistogram: false },
        rowsFrame: { layout: 'auto' },
      };
    case 'table':
      return { showHeader: true, cellHeight: 'sm', sortBy: panel.sortBy ? [panel.sortBy] : [] };
    case 'timeseries':
      return {
        legend: { displayMode: 'list', placement: 'bottom', showLegend: true },
        tooltip: { mode: 'multi', sort: 'desc' },
      };
    default:
      throw new Error(`unknown viz: ${panel.viz}`);
  }
}

function buildPanel(panel, id, gridPos) {
  const isTable = panel.viz === 'table';
  const instant = panel.instant ?? (['stat', 'gauge', 'bargauge', 'piechart', 'table'].includes(panel.viz) && !panel.sparkline);
  const targets = panel.targets.map((t, i) => ({
    datasource: DS,
    refId: String.fromCharCode(65 + i),
    expr: t.expr,
    legendFormat: t.legend ?? '__auto',
    instant,
    range: !instant,
    ...(isTable ? { format: 'table' } : {}),
    ...(panel.viz === 'heatmap' ? { format: 'heatmap' } : {}),
  }));
  const out = {
    id,
    type: panel.viz,
    title: panel.title,
    description: panelDescription(panel),
    datasource: DS,
    gridPos,
    targets,
    fieldConfig: fieldConfig(panel),
    options: options(panel),
  };
  if (isTable && panel.transformations) out.transformations = panel.transformations;
  if (panel.overrides) out.fieldConfig.overrides = panel.overrides;
  return out;
}

// Panels flow left to right and wrap at the grid width. A panel with `at: {x, y}` is placed
// explicitly (relative to the section start), which the glance dashboard uses for its factor columns.
function layoutRow(panels, nextId, startY) {
  const built = [];
  let y = startY;
  let x = 0;
  let rowHeight = 0;
  let fixedBottom = 0;
  for (const p of panels) {
    const w = p.w ?? 12;
    const h = p.h ?? 8;
    if (p.at) {
      built.push(buildPanel(p, nextId.value++, { x: p.at.x, y: startY + p.at.y, w, h }));
      fixedBottom = Math.max(fixedBottom, p.at.y + h);
      continue;
    }
    if (x + w > GRID_WIDTH) {
      y += rowHeight;
      x = 0;
      rowHeight = 0;
    }
    built.push(buildPanel(p, nextId.value++, { x, y, w, h }));
    x += w;
    rowHeight = Math.max(rowHeight, h);
  }
  return { built, nextY: Math.max(y + rowHeight, startY + fixedBottom) };
}

function rowPanel(title, id, y, collapsed, children) {
  return { id, type: 'row', title, collapsed, gridPos: { x: 0, y, w: GRID_WIDTH, h: 1 }, panels: collapsed ? children : [] };
}

function templating(def) {
  const list = [
    {
      name: 'ds',
      label: 'Data source',
      type: 'datasource',
      query: 'prometheus',
      current: {},
      hide: 0,
      refresh: 1,
      regex: '',
      includeAll: false,
      multi: false,
      options: [],
    },
  ];
  for (const name of VARIABLE_NAMES) {
    if (!def.variables.includes(name)) continue;
    const v = VARIABLES[name];
    list.push({
      name,
      label: v.label,
      type: 'query',
      datasource: DS,
      definition: v.definition,
      query: { query: v.definition, refId: `var_${name}`, qryType: 1 },
      refresh: 2,
      sort: 1,
      includeAll: true,
      allValue: '.*',
      multi: true,
      current: { selected: true, text: ['All'], value: ['$__all'] },
      options: [],
      regex: '',
      hide: 0,
    });
  }
  for (const [name, v] of Object.entries(TEXTBOX_VARIABLES)) {
    if (!def.variables.includes(name)) continue;
    list.push({
      name,
      label: v.label,
      type: 'textbox',
      query: v.default,
      current: { text: v.default, value: v.default },
      options: [{ selected: true, text: v.default, value: v.default }],
      hide: 0,
    });
  }
  return { list };
}

// A section without a title is laid out inline; a titled one gets a row header and may be collapsed.
export function buildDashboard(def) {
  const nextId = { value: 1 };
  const panels = [];
  let y = 0;

  for (const section of def.sections) {
    if (!section.panels.length) continue;
    if (!section.title) {
      const laid = layoutRow(section.panels, nextId, y);
      panels.push(...laid.built);
      y = laid.nextY;
      continue;
    }
    const rowId = nextId.value++;
    const children = layoutRow(section.panels, nextId, y + 1);
    panels.push(rowPanel(section.title, rowId, y, Boolean(section.collapsed), children.built));
    y += 1;
    if (!section.collapsed) {
      panels.push(...children.built);
      y = children.nextY;
    }
  }

  return {
    uid: def.uid,
    title: def.title,
    description: def.description,
    tags: ['gh-aw', 'otel', ...(def.tags ?? [])],
    schemaVersion: 39,
    version: 1,
    editable: true,
    graphTooltip: 1,
    timezone: 'browser',
    refresh: '5m',
    time: { from: 'now-7d', to: 'now' },
    templating: templating(def),
    annotations: { list: [] },
    links: [
      { type: 'dashboards', title: 'gh-aw dashboards', tags: ['gh-aw'], asDropdown: true, includeVars: true, keepTime: true },
      { ...ACTIONS_LINK, title: 'GitHub Actions', url: 'https://github.com/${gh_repo}/actions', type: 'link', icon: 'external link' },
    ],
    panels,
  };
}

export const serialize = (dashboard) => JSON.stringify(dashboard, null, 2) + '\n';

export function generateAll() {
  return DEFINITIONS.map((def) => ({ file: `${def.uid}.json`, content: serialize(buildDashboard(def)) }));
}

export const generateAlerts = () => alertRulesYaml();

function main() {
  const check = process.argv.includes('--check');
  let stale = 0;
  if (!check) mkdirSync(DASHBOARD_DIR, { recursive: true });
  const outputs = [
    ...generateAll().map(({ file, content }) => ({ label: `dashboards/${file}`, path: join(DASHBOARD_DIR, file), content })),
    { label: 'alerts/alerts.rules.yml', path: ALERTS_FILE, content: generateAlerts() },
  ];
  for (const { label, path, content } of outputs) {
    if (check) {
      let existing = '';
      try {
        existing = readFileSync(path, 'utf8');
      } catch {
        // missing counts as stale
      }
      if (existing !== content) {
        console.error(`STALE: ${label}`);
        stale++;
      }
    } else {
      writeFileSync(path, content);
      console.log(`wrote ${label}`);
    }
  }
  if (check) {
    if (stale) {
      console.error('Run `node observability/grafana/tools/generate.mjs` to regenerate.');
      process.exit(1);
    }
    console.log('dashboards and alerts are up to date');
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();

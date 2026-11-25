// Glance and scan tiers, generated from the SLI table in slo.mjs.
//   glance: gh-aw-slo-overview     fleet-level SLO status, one screen
//   scan:   gh-aw-slo-<factor>     which workflows violate the factor's SLOs, and since when
// The commit tier lives in workflow-drilldown.mjs.
import { LABELS, count, bucket, counter, nonCacheInput, costExpr, sum, inc, sel, RATE } from './common.mjs';
import {
  FACTORS, SLIS, SLI_BY_ID, sliIds, fleetExpr, workflowExpr, scopedExpr, worstSliTargets,
  thresholdSteps, sloText, gaugeSteps, gaugeUnit, gaugeLabel, gaugeSlis,
} from './slo.mjs';

const W = LABELS.workflow;
const DRILLDOWN_UID = 'gh-aw-workflow-drilldown';
const nav = (uid, extra = '') => `/d/${uid}?\${__url_time_range}&\${__all_variables}${extra}`;
const scanLink = (factor) => ({ title: `Open ${FACTORS[factor].label} scan`, url: nav(FACTORS[factor].uid), targetBlank: false });

function steps(sli) {
  const t = thresholdSteps(sli);
  return t ? { thresholds: t.steps, thresholdBase: t.base } : {};
}

// ---------------------------------------------------------------- glance

const COLUMNS = [
  { factor: 'availability', x: 0, w: 5 },
  { factor: 'responsiveness', x: 5, w: 5 },
  { factor: 'throughput', x: 10, w: 5 },
  { factor: 'quality', x: 15, w: 5 },
  { factor: 'cost', x: 20, w: 4 },
];

// Banner 3 rows, then one row of 5 factor gauges.
const BANNER_H = 3;
const FACTOR_H = 9;

function overview() {
  const a4 = SLI_BY_ID.get('A4');
  const panels = [
    {
      title: 'Telemetry health (A4): data may be understated when red',
      viz: 'stat',
      unit: 'short',
      thresholds: [[1, 'red']],
      mappings: [{ type: 'range', options: { from: 1, to: 1e12, result: { text: 'OTLP export failing: other tiles may be understated', index: 0 } } }, { type: 'range', options: { from: 0, to: 0.999, result: { text: 'Telemetry healthy', index: 1 } } }],
      slis: ['A4'],
      at: { x: 0, y: 0 },
      w: 24,
      h: 3,
      links: [scanLink('availability')],
      question: 'Can the numbers below be trusted? A4 is a trust gate for every other tile.',
      tier: 'A',
      ignores: 'all variables (not workflow-scoped)',
      targets: [{ expr: fleetExpr(a4) }],
    },
  ];
  for (const col of COLUMNS) {
    const f = FACTORS[col.factor];
    const slis = gaugeSlis(col.factor);
    // The gauge shows whichever SLI of the factor is closest to (or past) its SLO. Each SLI is its own
    // query (refId A, B, ...) and brings its unit, range and thresholds through a byFrameRefID override.
    const targets = worstSliTargets(col.factor);
    const settings = (s) => {
      const t = gaugeSteps(s);
      const props = [
        { id: 'unit', value: gaugeUnit(s) },
        { id: 'min', value: s.range[0] },
        { id: 'max', value: s.range[1] },
        { id: 'thresholds', value: { mode: 'absolute', steps: [{ color: t.base, value: null }, ...t.steps.map(([value, color]) => ({ color, value }))] } },
      ];
      if (s.decimals !== undefined) props.push({ id: 'decimals', value: s.decimals });
      return props;
    };
    const overrides = targets.map((t, i) => ({ matcher: { id: 'byFrameRefID', options: String.fromCharCode(65 + i) }, properties: settings(t.sli) }));
    const first = slis[0];
    const firstSteps = gaugeSteps(first);
    panels.push({
      title: f.label,
      viz: 'gauge',
      unit: gaugeUnit(first),
      min: first.range[0],
      max: first.range[1],
      thresholds: firstSteps.steps,
      thresholdBase: firstSteps.base,
      slis: slis.map((s) => s.id),
      at: { x: col.x, y: BANNER_H },
      w: col.w,
      h: FACTOR_H,
      links: [scanLink(col.factor)],
      question: `Are users happy with ${f.label}: ${f.happy}? Shows the actual value of the SLI closest to breaching its SLO (smallest headroom), named under the gauge with its SLO. Threshold markers: red = SLO breached, yellow = approaching, green = comfortable. Click to scan which workflows violate it.`,
      tier: 'A',
      ignores: 'workflow, job, model (fleet level)',
      targets: targets.map((t) => ({ expr: t.expr, legend: t.legend })),
      overrides,
    });
  }
  return {
    uid: 'gh-aw-slo-overview',
    title: 'gh-aw / SLO Overview',
    description: 'Glance: is the agentic-workflow fleet meeting expectations right now, and which happiness factor is not? Five gauges, one per happiness factor, each showing the actual value of its worst SLI against the SLO: green (comfortable), yellow (approaching) or red (breached). Click a gauge to scan which workflows violate it.',
    tags: ['slo', 'glance'],
    variables: ['slo_window', 'gh_repo'],
    sections: [{ panels }],
  };
}

// ---------------------------------------------------------------- scan

const JOBS_IN_WINDOW = `sum by (${W}) (increase(${count('jobDuration')}{${W}=~"$workflow",${LABELS.result}!="cancelled"}[$slo_window]))`;

function workflowTable(factor, ids, extraTargets = []) {
  const slis = ids.map((id) => SLI_BY_ID.get(id));
  const targets = slis.map((s) => ({ expr: workflowExpr(s) }));
  targets.push({ expr: JOBS_IN_WINDOW });
  targets.push(...extraTargets.map((t) => ({ expr: t.expr })));
  const columns = [...slis.map((s) => ({ name: `${s.id} ${s.title}`, sli: s })), { name: 'Jobs in window', unit: 'short' }, ...extraTargets.map((t) => ({ name: t.name, unit: t.unit ?? 'short' }))];
  const rename = {};
  columns.forEach((c, i) => { rename[`Value #${String.fromCharCode(65 + i)}`] = c.name; });
  const overrides = columns.map((c) => {
    const props = [{ id: 'unit', value: c.sli ? c.sli.unit : c.unit }];
    if (c.sli?.decimals !== undefined) props.push({ id: 'decimals', value: c.sli.decimals });
    const t = c.sli && thresholdSteps(c.sli);
    if (t) {
      props.push({ id: 'thresholds', value: { mode: 'absolute', steps: [{ color: t.base, value: null }, ...t.steps.map(([value, color]) => ({ color, value }))] } });
      props.push({ id: 'custom.cellOptions', value: { type: 'color-background' } });
    }
    return { matcher: { id: 'byName', options: c.name }, properties: props };
  });
  overrides.push({
    matcher: { id: 'byName', options: W },
    properties: [{ id: 'links', value: [{ title: 'Drill down into this workflow', url: `/d/${DRILLDOWN_UID}?var-workflow=\${__data.fields.${W}}&\${__url_time_range}&var-ds=\${ds}&var-gh_repo=\${gh_repo}` }] }],
  });
  const first = slis[0];
  return {
    title: `${FACTORS[factor].label} SLIs per workflow (worst first, click a workflow to drill down)`,
    viz: 'table',
    unit: 'short',
    w: 24,
    h: 9,
    slis: ids,
    question: `Which workflows violate the ${FACTORS[factor].label} SLOs? Cells are coloured against the SLO; "Jobs in window" shows the sample size.`,
    tier: 'A',
    instant: true,
    transformations: [
      { id: 'merge', options: {} },
      { id: 'organize', options: { excludeByName: { Time: true }, renameByName: rename } },
    ],
    overrides,
    sortBy: { displayName: `${first.id} ${first.title}`, desc: first.dir !== 'min' },
    targets,
  };
}

function sliSeries(id, withIds = []) {
  const s = SLI_BY_ID.get(id);
  const all = [s, ...withIds.map((x) => SLI_BY_ID.get(x))];
  const targets = all.map((x) => ({ expr: scopedExpr(x), legend: `${x.id} ${x.title}` }));
  const overrides = [];
  if (!s.informational) {
    targets.push({ expr: `vector(${s.slo})`, legend: 'SLO' });
    overrides.push({ matcher: { id: 'byName', options: 'SLO' }, properties: [{ id: 'custom.lineStyle', value: { fill: 'dash', dash: [10, 10] } }, { id: 'color', value: { mode: 'fixed', fixedColor: 'red' } }, { id: 'custom.fillOpacity', value: 0 }] });
  }
  if (s.amber !== undefined) {
    targets.push({ expr: `vector(${s.amber})`, legend: 'Amber margin' });
    overrides.push({ matcher: { id: 'byName', options: 'Amber margin' }, properties: [{ id: 'custom.lineStyle', value: { fill: 'dash', dash: [4, 6] } }, { id: 'color', value: { mode: 'fixed', fixedColor: 'orange' } }, { id: 'custom.fillOpacity', value: 0 }] });
  }
  return {
    title: `${s.id} ${s.title} vs SLO`,
    viz: 'timeseries',
    unit: s.unit,
    decimals: s.decimals,
    w: 12,
    h: 8,
    slis: [id, ...withIds],
    question: `When did ${s.title.toLowerCase()} cross its SLO? Rolling ${'$slo_window'} value; honours the Workflow variable.`,
    note: sloText(s),
    tier: 'A',
    overrides,
    targets,
  };
}

const hourly = (expr, labels) => `${sum(expr, labels)} * 3600`;
const TOKEN_UNIT = '{token}';
const FJ = sel({ job: false });

const SCAN = {
  availability() {
    const silent = `sum by (${W}) (increase(${count('jobDuration')}{${W}=~"$workflow"}[7d])) > 0 unless sum by (${W}) (increase(${count('jobDuration')}{${W}=~"$workflow"}[24h])) > 0`;
    return [
      workflowTable('availability', ['A2']),
      sliSeries('A1'),
      sliSeries('A2'),
      sliSeries('A4'),
      {
        title: 'A3 Silent workflows (active in 7d, silent in 24h)',
        viz: 'table',
        unit: 'short',
        w: 12,
        h: 8,
        slis: ['A3'],
        question: 'Which workflows ran in the last 7 days but not in the last 24 hours? Informational: event-driven workflows are legitimately quiet.',
        note: sloText(SLI_BY_ID.get('A3')),
        tier: 'A',
        instant: true,
        transformations: [{ id: 'organize', options: { excludeByName: { Time: true }, renameByName: { Value: 'Jobs in 7d' } } }],
        targets: [{ expr: silent }],
      },
    ];
  },
  responsiveness() {
    const heat = `sum by (le) (increase(${bucket('jobDuration')}{${LABELS.job}="agent",${W}=~"$workflow"}[${RATE}]))`;
    return [
      workflowTable('responsiveness', ['R1', 'R2']),
      sliSeries('R1', ['R2']),
      {
        title: 'Agent job duration distribution',
        viz: 'heatmap',
        unit: 's',
        w: 12,
        h: 8,
        slis: ['R1'],
        question: 'Where does agent job time cluster, and is a slow tail forming? Default buckets are coarse above 1 hour.',
        tier: 'A',
        targets: [{ expr: heat, legend: '{{le}}' }],
      },
    ];
  },
  throughput() {
    const outputs = (type) => sum(inc('outputItems', sel({ job: false, extra: [`${LABELS.outputType}="${type}"`] }), '$slo_window'), W);
    return [
      workflowTable('throughput', ['T1', 'T2'], [
        { name: 'Pull requests opened (proxy)', expr: outputs('create_pull_request') },
        { name: 'PRs merged (proxy)', expr: outputs('merge_pr') },
      ]),
      sliSeries('T1'),
      sliSeries('T2'),
      {
        title: 'Safe-output items per hour by type',
        viz: 'timeseries',
        unit: 'short',
        stack: true,
        w: 24,
        h: 8,
        slis: ['T2'],
        question: 'What kinds of output are workflows producing? "Issues completed" has no metric; PR and merge counts are a repo-specific proxy, not an SLO.',
        tier: 'A',
        targets: [{ expr: hourly(`rate(${counter('outputItems', FJ)}[${RATE}])`, LABELS.outputType), legend: `{{${LABELS.outputType}}}` }],
      },
    ];
  },
  quality() {
    const ET = LABELS.errorType;
    return [
      workflowTable('quality', ['Q1', 'Q2', 'Q3']),
      sliSeries('Q1'),
      sliSeries('Q2'),
      sliSeries('Q3'),
      {
        title: 'Jobs per hour by result',
        viz: 'timeseries',
        unit: 'short',
        stack: true,
        w: 12,
        h: 8,
        slis: ['Q1'],
        question: 'How does the result mix (success, failure, timed_out, cancelled) change over time?',
        tier: 'A',
        targets: [{ expr: hourly(`rate(${count('jobDuration')}${FJ}[${RATE}])`, LABELS.result), legend: `{{${LABELS.result}}}` }],
      },
      {
        title: 'Agent failures by error type',
        viz: 'bargauge',
        unit: 'short',
        w: 12,
        h: 8,
        slis: ['Q1'],
        question: 'Why do agent invocations fail? Only invocations with a non-empty error_type are counted.',
        tier: 'A',
        targets: [{ expr: sum(`increase(${count('agentDuration')}{${W}=~"$workflow",${ET}!=""}[$slo_window])`, ET), legend: `{{${ET}}}` }],
      },
    ];
  },
  cost() {
    const T = (key) => `${sum(`rate(${counter(key, FJ)}[${RATE}])`)} * 3600`;
    return [
      workflowTable('cost', ['C1', 'C2', 'C3']),
      sliSeries('C1'),
      sliSeries('C2'),
      sliSeries('C3'),
      sliSeries('C4'),
      {
        title: 'Tokens per hour by type',
        viz: 'timeseries',
        unit: TOKEN_UNIT,
        stack: true,
        w: 12,
        h: 8,
        slis: ['C2'],
        question: 'Where do tokens go over time? Input already includes cache, so non-cache input = input - cache read - cache write.',
        tier: 'A',
        targets: [
          { expr: `${nonCacheInput(FJ, RATE, 'rate')} * 3600`, legend: 'input (non-cache)' },
          { expr: T('tokensCacheRead'), legend: 'cache read' },
          { expr: T('tokensCacheWrite'), legend: 'cache write' },
          { expr: T('tokensOutput'), legend: 'output' },
        ],
      },
      {
        title: 'Estimated cost per hour (optional)',
        viz: 'timeseries',
        unit: 'currencyUSD',
        w: 12,
        h: 8,
        slis: ['C2'],
        question: 'How does estimated spend evolve? Tokens x the price variables (USD per 1M tokens, default 0); not an SLO.',
        tier: 'A',
        targets: [{ expr: costExpr(FJ, RATE, '', 'rate'), legend: 'cost / hour' }],
      },
    ];
  },
};

function scanDashboard(factor) {
  const f = FACTORS[factor];
  const variables = ['workflow', 'slo_window', 'gh_repo', ...(factor === 'cost' ? ['price_in', 'price_out', 'price_cache_read', 'price_cache_write'] : [])];
  return {
    uid: f.uid,
    title: `gh-aw / SLO ${f.label}`,
    description: `Scan: which workflows violate the ${f.label} SLOs ("${f.happy}"), and since when? Click a workflow to drill down.`,
    tags: ['slo', 'scan'],
    variables,
    sections: [{ panels: SCAN[factor]() }],
  };
}

export const SLO_DASHBOARDS = [overview(), ...Object.keys(FACTORS).map(scanDashboard)];
export { SLIS, DRILLDOWN_UID };

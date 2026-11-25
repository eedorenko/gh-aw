// The SLI table: the single source for glance tiles, scan-table thresholds, SLI-vs-SLO lines
// and alert rules. Changing an SLO or amber margin here changes all of them.
//
// Happiness factor -> SLI (a PromQL ratio/quantile) -> SLO (threshold) -> dashboard tier.
// `expr(ctx)` returns PromQL. ctx = { wf, by, window }:
//   wf     add the dashboard's $workflow filter (scan tier); false at fleet level
//   by     label list to group by ('' = one fleet-wide value)
//   window range for the SLO window (default the $slo_window variable; alerts pass a fixed one)
import { METRICS, LABELS } from './common.mjs';

export const FACTORS = {
  availability: { label: 'Availability', happy: 'workflows run when triggered and are not stuck or dead', uid: 'gh-aw-slo-availability' },
  responsiveness: { label: 'Responsiveness', happy: 'work starts and finishes promptly', uid: 'gh-aw-slo-responsiveness' },
  throughput: { label: 'Throughput', happy: 'runs are productive and work gets done', uid: 'gh-aw-slo-throughput' },
  quality: { label: 'Quality', happy: 'low failure rate and clean completions', uid: 'gh-aw-slo-quality' },
  cost: { label: 'Cost efficiency', happy: 'tokens per useful output and a reasonable burn rate', uid: 'gh-aw-slo-cost' },
};

const W = LABELS.workflow;
const R = LABELS.result;
const SLO_WINDOW = '$slo_window';
const metric = (key, suffix = '') => METRICS[key].base + suffix;

const matchers = (ctx, extra = []) => {
  const parts = [...(ctx.wf ? [`${W}=~"$workflow"`] : []), ...extra];
  return parts.length ? `{${parts.join(',')}}` : '';
};
const win = (ctx, fallback = SLO_WINDOW) => ctx.window ?? fallback;
const sumBy = (ctx, inner) => (ctx.by ? `sum by (${ctx.by}) (${inner})` : `sum(${inner})`);
const inc = (ctx, key, extra, window) => {
  const filt = METRICS[key].filter;
  const allExtra = filt ? [...extra, filt] : extra;
  return sumBy(ctx, `increase(${metric(key)}${matchers(ctx, allExtra)}[${window}])`);
};
const jobs = (ctx, extra, window = win(ctx)) => sumBy(ctx, `increase(${metric('jobDuration', '_count')}${matchers(ctx, extra)}[${window}])`);
const agentJobs = (ctx, extra = [], window = win(ctx)) => jobs(ctx, [`${LABELS.job}="agent"`, ...extra], window);
const notCancelled = [`${R}!="cancelled"`];
const tokens = (ctx, window) => `(${inc(ctx, 'tokensInput', [], window)} + ${inc(ctx, 'tokensOutput', [], window)})`;

// num/den that is "No data" when den is 0 but a real 0 when num is absent and den is positive.
const ratio = (num, den) => `((${num}) / ((${den}) > 0)) or (((${den}) > 0) * 0)`;
// A counter-like fleet value where "series absent" means 0 events.
const orZero = (ctx, expr) => (ctx.by ? expr : `(${expr}) or vector(0)`);

const quantile = (ctx, phi) => {
  const by = ctx.by ? `le, ${ctx.by}` : 'le';
  return `histogram_quantile(${phi}, sum by (${by}) (increase(${metric('jobDuration', '_bucket')}${matchers(ctx, [`${LABELS.job}="agent"`])}[${win(ctx)}])))`;
};

const activeWorkflows = (ctx, window) =>
  `count(sum by (${W}) (increase(${metric('jobDuration', '_count')}${matchers(ctx)}[${window}])) > 0) or vector(0)`;

// dir 'min': higher is better (SLO is a floor). dir 'max': lower is better (SLO is a ceiling).
// amber: the margin before red. integer: counts, where "any" means >= 1 (increase() is fractional).
export const SLIS = [
  {
    id: 'A1', factor: 'availability', title: 'Fleet liveness', unit: 'short', dir: 'min', slo: 1, integer: true, perWorkflow: false,
    range: [0, 10],
    definition: 'jobs reported in the last 6h',
    expr: (c) => orZero(c, `round(${jobs(c, [], '6h')})`),
    alert: { name: 'GhAwFleetSilent', window: '6h', for: '0m', severity: 'warning', summary: 'No gh-aw jobs reported in 6 hours', description: 'Either nothing ran or telemetry is broken; check A4 on the SLO overview.' },
  },
  {
    id: 'A2', factor: 'availability', title: 'Timeout ratio', unit: 'percentunit', dir: 'max', slo: 0.02, amber: 0.04,
    warn: 0.015, range: [0, 0.04],
    definition: 'jobs ending timed_out / non-cancelled jobs',
    expr: (c) => ratio(jobs(c, [`${R}="timed_out"`]), jobs(c, notCancelled)),
    alert: { name: 'GhAwTimedOutJobs', window: '6h', for: '15m', severity: 'warning', minJobs: 5, summary: 'gh-aw timeout ratio above the 2% SLO', description: 'Jobs are hitting their timeout. Open the Availability scan dashboard to see which workflows.' },
  },
  {
    id: 'A3', factor: 'availability', title: 'Silent workflows', unit: 'short', informational: true, perWorkflow: false,
    definition: 'workflows active in the last 7d but silent in the last 24h (informational: event-driven workflows are legitimately quiet)',
    expr: (c) => `(${activeWorkflows(c, '7d')}) - (${activeWorkflows(c, '24h')})`,
  },
  {
    id: 'A4', factor: 'availability', title: 'Telemetry health', unit: 'short', dir: 'max', slo: 0, integer: true, perWorkflow: false, trustGate: true,
    range: [0, 5],
    definition: 'OTLP export failures in the last hour (trust gate: when red, every other tile may be understated)',
    expr: (c) => orZero(c, `round(sum(increase(${metric('otlpFailures')}[${c.window ?? '1h'}])))`),
    alert: { name: 'GhAwTelemetryBroken', window: '15m', for: '15m', severity: 'warning', summary: 'gh-aw is failing to export OTLP telemetry', description: 'Dashboards may under-report until exports recover.' },
  },
  {
    id: 'R1', factor: 'responsiveness', title: 'Agent job p95 duration', unit: 's', dir: 'max', slo: 1200, amber: 1500,
    warn: 900, range: [0, 1500],
    definition: 'p95 duration of agent jobs',
    expr: (c) => quantile(c, 0.95),
    alert: { name: 'GhAwSlowAgentJobs', window: '6h', for: '30m', severity: 'warning', minJobs: 5, summary: 'gh-aw agent job p95 duration above the 20 minute SLO', description: 'Agent jobs are slow. Open the Responsiveness scan dashboard.' },
  },
  {
    id: 'R2', factor: 'responsiveness', title: 'Agent job p50 duration', unit: 's', informational: true,
    definition: 'median duration of agent jobs, shown next to R1',
    expr: (c) => quantile(c, 0.5),
  },
  {
    id: 'T1', factor: 'throughput', title: 'Throughput vs baseline', unit: 'percentunit', dir: 'min', slo: 0.6, amber: 0.4,
    warn: 0.75, range: [0, 1.5],
    definition: 'successful agent runs in the last 24h / 7d daily average',
    expr: (c) => {
      const ok = [`${R}="success"`];
      return ratio(agentJobs(c, ok, '1d'), `${agentJobs(c, ok, '7d')} / 7`);
    },
  },
  {
    id: 'T2', factor: 'throughput', title: 'Productive outputs per agent run', unit: 'none', decimals: 2, dir: 'min', slo: 0.5, amber: 0.3,
    warn: 0.65, range: [0, 1],
    definition: 'non-noop safe outputs / agent runs',
    expr: (c) => ratio(inc(c, 'outputItems', [`${LABELS.outputType}!="noop"`], win(c)), agentJobs(c)),
  },
  {
    id: 'Q1', factor: 'quality', title: 'Job success ratio', unit: 'percentunit', dir: 'min', slo: 0.95, amber: 0.9,
    warn: 0.97, range: [0, 1],
    definition: 'successful jobs / non-cancelled jobs',
    expr: (c) => ratio(jobs(c, [`${R}="success"`]), jobs(c, notCancelled)),
    alert: { name: 'GhAwHighFailureRate', window: '1h', for: '15m', severity: 'warning', minJobs: 5, summary: 'gh-aw job success ratio below the 95% SLO', description: 'Open the Quality scan dashboard to see which workflows are failing.' },
  },
  {
    id: 'Q2', factor: 'quality', title: 'Tool call success ratio', unit: 'percentunit', dir: 'min', slo: 0.9, amber: 0.8,
    warn: 0.95, range: [0, 1],
    definition: 'tool calls with status ok / all tool calls',
    expr: (c) => ratio(inc(c, 'toolCalls', [`${LABELS.toolStatus}="ok"`], win(c)), inc(c, 'toolCalls', [], win(c))),
  },
  {
    id: 'Q3', factor: 'quality', title: 'Incomplete-run rate', unit: 'percentunit', dir: 'max', slo: 0.05, amber: 0.1,
    warn: 0.04, range: [0, 0.1],
    definition: 'report_incomplete safe outputs / agent runs',
    expr: (c) => ratio(inc(c, 'outputItems', [`${LABELS.outputType}="report_incomplete"`], win(c)), agentJobs(c)),
    alert: { name: 'GhAwHighIncompleteRate', window: '6h', for: '30m', severity: 'warning', minJobs: 5, summary: 'More than 5% of gh-aw agent runs end as incomplete', description: 'Agents are reporting they could not finish. Open the Quality scan dashboard.' },
  },
  {
    id: 'C1', factor: 'cost', title: 'Tokens per productive output vs baseline', unit: 'none', suffix: '×', decimals: 2, dir: 'max', slo: 1.5, amber: 2,
    warn: 1.2, range: [0, 2],
    definition: '(tokens / non-noop outputs over 7d) / (same over 28d)',
    expr: (c) => {
      const perOutput = (w) => ratio(tokens(c, w), inc(c, 'outputItems', [`${LABELS.outputType}!="noop"`], w));
      return `(${perOutput('7d')}) / ((${perOutput('28d')}) > 0)`;
    },
  },
  {
    id: 'C2', factor: 'cost', title: 'Burn rate vs baseline', unit: 'none', suffix: '×', decimals: 2, dir: 'max', slo: 2, amber: 3,
    warn: 1.5, range: [0, 3],
    definition: 'tokens in the last 24h / 7d daily average',
    expr: (c) => ratio(tokens(c, '1d'), `${tokens(c, '7d')} / 7`),
    alert: { name: 'GhAwTokenBurnSpike', for: '1h', severity: 'warning', summary: 'gh-aw token burn over 2x the 7-day daily average', description: 'Open the Cost scan dashboard to see which workflows are burning tokens.' },
  },
  {
    id: 'C3', factor: 'cost', title: 'Cache hit ratio', unit: 'percentunit', dir: 'min', slo: 0.4, amber: 0.2,
    warn: 0.5, range: [0, 1],
    definition: 'cache-read tokens / input tokens',
    expr: (c) => ratio(inc(c, 'tokensCacheRead', [], win(c)), inc(c, 'tokensInput', [], win(c))),
  },
  {
    id: 'C4', factor: 'cost', title: 'Credit and rate-limit events', unit: 'short', dir: 'max', slo: 0, integer: true,
    range: [0, 5],
    definition: 'AI credit limit-exceeded plus rate-limit errors',
    expr: (c) => orZero(c, `round(${orZero(c, inc(c, 'creditsLimitExceeded', [], win(c)))} + ${orZero(c, inc(c, 'creditsRateLimit', [], win(c)))})`),
  },
];

export const SLI_BY_ID = new Map(SLIS.map((s) => [s.id, s]));
export const sliIds = (factor) => SLIS.filter((s) => s.factor === factor).map((s) => s.id);
const FLEET = { wf: false, by: '' };
export const fleetExpr = (sli, extra = {}) => sli.expr({ ...FLEET, ...extra });
export const workflowExpr = (sli, by = LABELS.workflow) => sli.expr({ wf: true, by });
export const scopedExpr = (sli) => sli.expr({ wf: true, by: '' });

const pct = (v) => `${+(v * 100).toFixed(2)}%`;
const fmt = (sli, v) => {
  if (sli.unit === 'percentunit') return pct(v);
  if (sli.unit === 's') return `${v / 60} min`;
  return `${v}${sli.suffix ?? ''}`;
};

export function sloText(sli) {
  if (sli.informational) return 'No SLO (informational).';
  const op = sli.dir === 'min' ? '≥' : '≤';
  const amber = sli.amber === undefined ? '' : ` (amber ${op} ${fmt(sli, sli.amber)})`;
  return `SLO: ${op} ${fmt(sli, sli.slo)}${amber}.`;
}

// Smallest step above a ceiling, so a value exactly at the SLO still counts as met.
const above = (sli, v) => (sli.integer ? v + 1 : v + Math.max(Math.abs(v) * 1e-9, 1e-9));

// Grafana threshold steps: [base colour, [[value, colour], ...]].
export function thresholdSteps(sli) {
  if (sli.informational) return null;
  if (sli.dir === 'min') {
    const steps = sli.amber === undefined ? [] : [[sli.amber, 'orange']];
    return { base: 'red', steps: [...steps, [sli.slo, 'green']] };
  }
  if (sli.amber === undefined) return { base: 'green', steps: [[above(sli, sli.slo), 'red']] };
  return { base: 'green', steps: [[above(sli, sli.slo), 'orange'], [above(sli, sli.amber), 'red']] };
}

// Gauge colours: red = SLO breached, yellow = still met but inside the `warn` margin (approaching),
// green = comfortably within SLO. SLIs without `warn` (counts) are green when met, red when not.
export function gaugeSteps(sli) {
  if (sli.dir === 'min') {
    return { base: 'red', steps: sli.warn === undefined ? [[sli.slo, 'green']] : [[sli.slo, 'yellow'], [sli.warn, 'green']] };
  }
  const red = [above(sli, sli.slo), 'red'];
  return { base: 'green', steps: sli.warn === undefined ? [red] : [[sli.warn, 'yellow'], red] };
}

export const gaugeUnit = (sli) => (sli.suffix ? `suffix:${sli.suffix}` : sli.unit);

// Series name shown under the gauge, also the key for the per-SLI field overrides.
export const gaugeLabel = (sli) => `${sli.title} (SLO ${sli.dir === 'min' ? '≥' : '≤'} ${fmt(sli, sli.slo)})`;

export const gaugeSlis = (factor) => SLIS.filter((s) => s.factor === factor && !s.informational);

// Headroom: < 0 breached, 0..1 approaching, >= 1 comfortable. Measured in "warn bands" so SLIs with
// different units compare. Count SLIs have no band: 3 when met, -1 when breached.
export function marginExpr(sli) {
  const e = `(${fleetExpr(sli)})`; // SLI queries contain a top-level `or`, so group before arithmetic
  if (sli.warn === undefined) return `((${e} ${sli.dir === 'min' ? '>=' : '<='} bool ${sli.slo}) * 4 - 1)`;
  const band = +Math.abs(sli.warn - sli.slo).toFixed(10);
  return sli.dir === 'min' ? `((${e} - ${sli.slo}) / ${band})` : `((${sli.slo} - ${e}) / ${band})`;
}

// One query per SLI of the factor. Query i returns its SLI's actual value only while that SLI is the
// factor's worst (smallest headroom; ties go to the earlier SLI), so at most one gauge is drawn. Keeping
// the SLIs in separate queries lets each carry its own unit, range and thresholds via a byFrameRefID override.
export function worstSliTargets(factor) {
  const slis = gaugeSlis(factor);
  const tag = (expr, sli) => `label_replace(${expr}, "sli", ${JSON.stringify(sli.id)}, "", "")`;
  const margins = slis.map((s) => tag(marginExpr(s), s));
  const none = 'label_replace(vector(1e9), "sli", "none", "", "")';
  const lowest = (list) => `scalar(min(${[...list, none].join(' or ')}))`;
  return slis.map((s, i) => ({
    sli: s,
    legend: gaugeLabel(s),
    expr: `(${fleetExpr(s)}) and on() ((${marginExpr(s)}) < ${lowest(margins.slice(0, i))}) and on() ((${marginExpr(s)}) <= ${lowest(margins.slice(i + 1))})`,
  }));
}

export function alertRulesYaml() {
  const rules = SLIS.filter((s) => s.alert).map((s) => {
    const a = s.alert;
    const guard = a.minJobs
      ? ` and on() (sum(increase(${metric('jobDuration', '_count')}[${a.window}])) >= ${a.minJobs})`
      : '';
    const cmp = `${s.dir === 'min' ? '<' : '>'} ${s.slo}`;
    const expr = `(${fleetExpr(s, a.window ? { window: a.window } : {})}) ${cmp}${guard}`;
    return [
      `      - alert: ${a.name}`,
      '        expr: |',
      `          ${expr}`,
      `        for: ${a.for}`,
      '        labels:',
      `          severity: ${a.severity}`,
      `          sli: ${s.id}`,
      '        annotations:',
      `          summary: ${JSON.stringify(a.summary)}`,
      `          description: ${JSON.stringify(`${a.description} ${sloText(s)}`)}`,
    ].join('\n');
  });
  return [
    '# GENERATED by tools/generate.mjs from definitions/slo.mjs; do not edit by hand.',
    '# One rule per breached SLO. Thresholds come from the SLI table. Tier A metrics only.',
    'groups:',
    '  - name: gh-aw-slo',
    '    rules:',
    rules.join('\n\n'),
    '',
  ].join('\n');
}

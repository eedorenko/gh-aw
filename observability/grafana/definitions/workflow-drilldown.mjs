// Commit tier: everything for one workflow, to find why it violates an SLO.
// Metrics carry no run id, so root cause for a single run is one click out to GitHub Actions.
import { sel, inc, sum, ratio, quantile, counter, count, nonCacheInput, totalTokens, costExpr, RANGE, RATE, LABELS, ACTIONS_LINK } from './common.mjs';

const FJ = sel(); // workflow + job
const FM = sel({ model: true });
const FR = sel({ result: true });
const W = LABELS.workflow;
const R = LABELS.result;
const M = LABELS.model;
const TS = LABELS.toolStatus;
const ET = LABELS.errorType;
const OT = LABELS.outputType;
const TOKEN_UNIT = '{token}';
const hourly = (expr, labels) => `${sum(expr, labels)} * 3600`;
const errors = (s, range = RANGE, labels = '') => sum(`increase(${counter('jobErrors', s)}[${range}])`, labels);
const jobCount = (s, range = RANGE, labels = '') => sum(`increase(${count('jobDuration')}${s}[${range}])`, labels);
const PRICE_NOTE = 'Estimated: tokens x the price variables (USD per 1M tokens, default 0).';

const panels = [
  {
    title: 'Jobs completed',
    viz: 'stat', unit: 'short', w: 6, h: 5,
    question: 'How many jobs of this workflow finished in the selected range?',
    ignores: 'model', tier: 'A',
    targets: [{ expr: jobCount(FR) }],
    links: [ACTIONS_LINK],
  },
  {
    title: 'Job failure rate',
    viz: 'stat', unit: 'percentunit', w: 6, h: 5,
    thresholds: [[0.05, 'orange'], [0.1, 'red']],
    question: 'What share of this workflow\'s jobs ended in failure, timeout or cancellation? No data (not 0%) when nothing ran.',
    ignores: 'model, result', tier: 'A',
    targets: [{ expr: ratio(errors(FJ), jobCount(FJ)) }],
  },
  {
    title: 'p95 job duration',
    viz: 'stat', unit: 's', w: 6, h: 5,
    question: 'How long do the slowest 5% of jobs take? Default buckets are coarse above 1 hour.',
    tier: 'A',
    targets: [{ expr: quantile(0.95, 'jobDuration', FR) }],
  },
  {
    title: 'Turns p50 / p95',
    viz: 'stat', unit: '{turn}', w: 6, h: 5, textMode: 'value_and_name',
    question: 'How many agent turns does a typical and a slow run take? Default buckets are coarse above 30 turns (see METRICS-PROPOSAL.md).',
    ignores: 'model', tier: 'A',
    targets: [
      { expr: quantile(0.5, 'agentTurns', FJ), legend: 'p50' },
      { expr: quantile(0.95, 'agentTurns', FJ), legend: 'p95' },
    ],
  },
  {
    title: 'Job duration p50 / p95 by result',
    viz: 'timeseries', unit: 's', w: 12, h: 8,
    question: 'Is job duration drifting up, and do failures take longer than successes?',
    tier: 'A',
    targets: [
      { expr: quantile(0.5, 'jobDuration', FR, RATE, 'rate'), legend: 'p50' },
      { expr: quantile(0.95, 'jobDuration', FR, RATE, 'rate'), legend: 'p95' },
    ],
  },
  {
    title: 'Jobs per hour by result',
    viz: 'timeseries', unit: 'short', stack: true, w: 12, h: 8,
    question: 'When did failures, timeouts and cancellations happen?',
    tier: 'A',
    targets: [{ expr: hourly(`rate(${count('jobDuration')}${FR}[${RATE}])`, R), legend: `{{${R}}}` }],
  },
  {
    title: 'Errors by job',
    viz: 'bargauge', unit: 'short', w: 8, h: 8,
    question: 'Which job of this workflow (agent, detection, safe_outputs, ...) produces the errors?',
    ignores: 'result', tier: 'A',
    targets: [{ expr: errors(FJ, RANGE, LABELS.job), legend: `{{${LABELS.job}}}` }],
  },
  {
    title: 'Agent failures by error type',
    viz: 'bargauge', unit: 'short', w: 8, h: 8,
    question: 'Why do agent invocations fail? Only invocations with a non-empty error_type are counted.',
    tier: 'A',
    targets: [{ expr: sum(`increase(${count('agentDuration')}${sel({ model: true, extra: [`${ET}!=""`] })}[${RANGE}])`, ET), legend: `{{${ET}}}` }],
  },
  {
    title: 'Agent failure ratio by model',
    viz: 'bargauge', unit: 'percentunit', min: 0, max: 1, w: 8, h: 8,
    question: 'Which models see the most failed agent invocations?',
    tier: 'A',
    targets: [{
      expr: ratio(
        sum(`increase(${count('agentDuration')}${sel({ model: true, extra: [`${ET}!=""`] })}[${RANGE}])`, M),
        sum(`increase(${count('agentDuration')}${FM}[${RANGE}])`, M),
      ),
      legend: `{{${M}}}`,
    }],
  },
  {
    title: 'Tool calls per hour by status',
    viz: 'timeseries', unit: 'short', stack: true, w: 12, h: 8,
    question: 'How many tool calls succeed ("ok") vs fail ("error")? Job-level aggregate: tool name is not a metric attribute.',
    ignores: 'model', tier: 'A',
    targets: [{ expr: hourly(`rate(${counter('toolCalls', FJ)}[${RATE}])`, TS), legend: `{{${TS}}}` }],
  },
  {
    title: 'Agent duration p50 / p95',
    viz: 'timeseries', unit: 's', w: 12, h: 8,
    question: 'Is agent invocation time drifting?',
    tier: 'A',
    targets: [
      { expr: quantile(0.5, 'agentDuration', FM, RATE, 'rate'), legend: 'p50' },
      { expr: quantile(0.95, 'agentDuration', FM, RATE, 'rate'), legend: 'p95' },
    ],
  },
  {
    title: 'Tokens by type',
    viz: 'timeseries', unit: TOKEN_UNIT, stack: true, w: 14, h: 9,
    question: 'Where do tokens go over time? Input already includes cache, so non-cache input = input - cache read - cache write.',
    ignores: 'model', tier: 'A',
    targets: [
      { expr: `${nonCacheInput(FJ, RATE, 'rate')} * 3600`, legend: 'input (non-cache)' },
      { expr: hourly(`rate(${counter('tokensCacheRead', FJ)}[${RATE}])`), legend: 'cache read' },
      { expr: hourly(`rate(${counter('tokensCacheWrite', FJ)}[${RATE}])`), legend: 'cache write' },
      { expr: hourly(`rate(${counter('tokensOutput', FJ)}[${RATE}])`), legend: 'output' },
    ],
  },
  {
    title: 'Tokens by model',
    viz: 'piechart', unit: TOKEN_UNIT, w: 10, h: 9,
    question: 'Which models consume the tokens (input + output)?',
    tier: 'A',
    targets: [{ expr: totalTokens(FM, RANGE, M), legend: `{{${M}}}` }],
  },
  {
    title: 'Safe-output items by type',
    viz: 'timeseries', unit: 'short', stack: true, w: 12, h: 8,
    question: 'What kinds of output does this workflow produce?',
    ignores: 'model', tier: 'A',
    targets: [{ expr: hourly(`rate(${counter('outputItems', FJ)}[${RATE}])`, OT), legend: `{{${OT}}}` }],
  },
  {
    title: 'Estimated cost per hour',
    viz: 'timeseries', unit: 'currencyUSD', w: 12, h: 8,
    question: 'How does estimated spend evolve?',
    ignores: 'model', note: PRICE_NOTE, tier: 'A',
    targets: [{ expr: costExpr(FJ, RATE, '', 'rate'), legend: 'cost / hour' }],
  },
];

const tierB = [
  {
    title: 'Credits per hour',
    viz: 'timeseries', unit: '{credit}', w: 12, h: 6,
    question: 'How does credit consumption evolve? Lights up once gh-aw emits gh_aw.ai.credits.usage.',
    ignores: 'model', tier: 'B',
    targets: [{ expr: hourly(`rate(${counter('creditsUsage', FJ)}[${RATE}])`), legend: 'credits / hour' }],
  },
  {
    title: 'Credits per safe-output item',
    viz: 'stat', unit: '{credit}', w: 12, h: 6,
    question: 'How many credits does one safe-output item cost? Lights up once gh-aw emits gh_aw.ai.credits.usage.',
    ignores: 'model', tier: 'B',
    targets: [{ expr: ratio(sum(inc('creditsUsage', FJ)), sum(inc('outputItems', FJ))) }],
  },
];

export default {
  uid: 'gh-aw-workflow-drilldown',
  title: 'gh-aw / Workflow Drilldown',
  description: 'Commit: why is this workflow violating an SLO? Pick a workflow, job and model; links out to its GitHub Actions run list for run-level root cause.',
  tags: ['slo', 'commit'],
  variables: ['workflow', 'job', 'model', 'result', 'gh_repo', 'price_in', 'price_out', 'price_cache_read', 'price_cache_write'],
  sections: [
    { panels },
    { title: 'Tier B: not emitted yet', collapsed: true, panels: tierB },
  ],
};

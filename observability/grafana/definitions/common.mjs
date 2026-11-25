// Shared building blocks for the gh-aw Grafana dashboard definitions.
// Every Prometheus metric and label name used by a dashboard comes from this file,
// so a collector-mapping fix is a one-line change here.

// Prometheus names as produced by the OTLP -> Prometheus mapping (dots become `_`,
// unit suffixes are appended, counters get `_total`). Tier A = emitted by gh-aw today,
// Tier B = defined in the gh-aw OTEL spec but not emitted yet.
export const METRICS = {
  jobDuration: { base: 'gh_aw_job_duration_seconds', kind: 'histogram', tier: 'A' },
  jobErrors: { base: 'gh_aw_job_errors_total', kind: 'counter', tier: 'A' },
  agentTurns: { base: 'gh_aw_agent_turns', kind: 'histogram', tier: 'A' },
  agentDuration: { base: 'gen_ai_invoke_agent_duration_seconds', kind: 'histogram', tier: 'A' },
  toolCalls: { base: 'gh_aw_tool_calls_total', kind: 'counter', tier: 'A' },
  outputItems: { base: 'gh_aw_workflow_output_items_total', kind: 'counter', tier: 'A' },
  tokensInput: { base: 'gen_ai_client_token_usage_total', kind: 'counter', tier: 'A', filter: 'gen_ai_token_type="input"' },
  tokensOutput: { base: 'gen_ai_client_token_usage_total', kind: 'counter', tier: 'A', filter: 'gen_ai_token_type="output"' },
  tokensCacheRead: { base: 'gen_ai_client_token_usage_total', kind: 'counter', tier: 'A', filter: 'gen_ai_token_type="cache_read"' },
  tokensCacheWrite: { base: 'gen_ai_client_token_usage_total', kind: 'counter', tier: 'A', filter: 'gen_ai_token_type="cache_write"' },
  creditsLimitExceeded: { base: 'gh_aw_ai_credits_limit_exceeded_total', kind: 'counter', tier: 'A' },
  creditsRateLimit: { base: 'gh_aw_ai_credits_rate_limit_errors_total', kind: 'counter', tier: 'A' },
  otlpFailures: { base: 'gh_aw_otlp_export_failures_total', kind: 'counter', tier: 'A' },
  creditsUsage: { base: 'gh_aw_ai_credits_usage_total', kind: 'counter', tier: 'B' },
};

// Names that exist only as aliases or compat series; summing them double-counts.
export const ALIAS_NAMES = [
  'gh_aw_run_duration_seconds',
  'gh_aw_safe_outputs_total',
  'gen_ai_client_inference_usage_input_tokens_total',
  'gen_ai_client_inference_usage_output_tokens_total',
  'gen_ai_client_inference_usage_cache_read_input_tokens_total',
  'gen_ai_client_inference_usage_cache_write_input_tokens_total',
  'gh_aw_tokens_input_total',
  'gh_aw_tokens_output_total',
  'gh_aw_tokens_cache_read_total',
  'gh_aw_tokens_cache_write_total',
];

export const LABELS = {
  workflow: 'gh_aw_workflow_name',
  job: 'gh_aw_job_name',
  engine: 'gh_aw_engine_id',
  model: 'gen_ai_request_model',
  result: 'cicd_pipeline_task_run_result',
  toolStatus: 'gh_aw_tool_status',
  outputType: 'gh_aw_safe_output_type',
  errorType: 'error_type',
  tokenType: 'gen_ai_token_type',
  le: 'le',
};

// Series names a query may legitimately reference (histograms expand to _bucket/_count/_sum).
export function allMetricNames() {
  const names = new Map();
  for (const [key, def] of Object.entries(METRICS)) {
    const series = def.kind === 'histogram' ? ['_bucket', '_count', '_sum'].map((s) => def.base + s) : [def.base];
    for (const s of series) names.set(s, { key, tier: def.tier });
  }
  return names;
}

const name = (key, suffix = '') => METRICS[key].base + suffix;
export const count = (key) => name(key, '_count');
export const bucket = (key) => name(key, '_bucket');

// Merge a metric's built-in filter (e.g. token type) into a selector string.
function mergeFilter(key, selector) {
  const filt = METRICS[key].filter;
  if (!filt) return selector;
  if (!selector) return `{${filt}}`;
  return selector.replace(/\}$/, `, ${filt}}`);
}

// Returns the counter name, optionally merged with a selector and any built-in filter.
export function counter(key, selector = '') {
  return `${name(key)}${mergeFilter(key, selector)}`;
}

export const RANGE = '$__range';
export const RATE = '$__rate_interval';

const q = (v) => `=~"$${v}"`;

// Matcher helpers. Each variable matcher uses `=~` so "All" (`.*`) also matches series
// that lack the label.
export function sel({ workflow = true, job = true, engine = false, model = false, result = false, extra = [] } = {}) {
  const parts = [];
  if (workflow) parts.push(LABELS.workflow + q('workflow'));
  if (job) parts.push(LABELS.job + q('job'));
  if (engine) parts.push(LABELS.engine + q('engine'));
  if (model) parts.push(LABELS.model + q('model'));
  if (result) parts.push(LABELS.result + q('result'));
  parts.push(...extra);
  return parts.length ? `{${parts.join(', ')}}` : '';
}

// Counter delta over a window: `increase` for totals, `rate` for trends (callers scale rate to per-hour).
export const inc = (key, selector, range = RANGE, fn = 'increase') => `${fn}(${name(key)}${mergeFilter(key, selector)}[${range}])`;
const by = (labels) => (labels ? ` by (${labels})` : '');
export const sum = (expr, labels = '') => `sum${by(labels)} (${expr})`;
// Divide only when the denominator is positive so a quiet fleet is "No data", not 0%.
export const ratio = (num, den) => `(${num}) / ((${den}) > 0)`;

export function quantile(phi, key, selector, range = RANGE, fn = 'increase') {
  return `histogram_quantile(${phi}, sum by (le) (${fn}(${bucket(key)}${selector}[${range}])))`;
}

export const totalTokens = (selector, range = RANGE, labels = '', fn = 'increase') =>
  `${sum(inc('tokensInput', selector, range, fn), labels)} + ${sum(inc('tokensOutput', selector, range, fn), labels)}`;

// Input tokens already include cache tokens (gh-aw spec 11.5), so cost is linear in
// (input, cache_read - input, cache_write - input, output). Terms are tagged with a `kind`
// label so `or` keeps all of them and a missing cache series just drops its own term.
export function costExpr(selector, range, labels = '', fn = 'increase') {
  const term = (key, kind, price) =>
    `label_replace(${inc(key, selector, range, fn)} * (${price}), "kind", "${kind}", "", "")`;
  const terms = [
    term('tokensInput', 'input', '$price_in'),
    term('tokensCacheRead', 'cache_read', '$price_cache_read - $price_in'),
    term('tokensCacheWrite', 'cache_write', '$price_cache_write - $price_in'),
    term('tokensOutput', 'output', '$price_out'),
  ];
  const hourly = fn === 'rate' ? ' * 3600' : '';
  return `sum${by(labels)} (${terms.join(' or ')}) / 1e6${hourly}`;
}

// Tokens excluding cache, for stacked token charts. Cache terms default to 0 when absent.
export function nonCacheInput(selector, range, fn = 'increase') {
  const s = (key) => sum(inc(key, selector, range, fn));
  return `clamp_min(${s('tokensInput')} - (${s('tokensCacheRead')} or vector(0)) - (${s('tokensCacheWrite')} or vector(0)), 0)`;
}

export const VARIABLE_NAMES = ['workflow', 'job', 'engine', 'model', 'result'];

// Dashboard variables. `query` is a PromQL label_values() definition, evaluated by Grafana.
export const VARIABLES = {
  workflow: {
    label: 'Workflow',
    definition: `label_values(${count('jobDuration')}, ${LABELS.workflow})`,
  },
  job: {
    label: 'Job',
    definition: `label_values(${count('jobDuration')}{${LABELS.workflow}=~"$workflow"}, ${LABELS.job})`,
  },
  engine: {
    label: 'Engine',
    definition: `label_values(${count('jobDuration')}, ${LABELS.engine})`,
  },
  model: {
    label: 'Model',
    definition: `label_values(${count('agentDuration')}, ${LABELS.model})`,
  },
  result: {
    label: 'Job result',
    definition: `label_values(${count('jobDuration')}, ${LABELS.result})`,
  },
};

export const TEXTBOX_VARIABLES = {
  slo_window: { label: 'SLO window (e.g. 7d)', default: '7d' },
  gh_repo: { label: 'GitHub repo (owner/name)', default: 'github/gh-aw' },
  price_in: { label: 'Price: input (USD / 1M tokens)', default: '0' },
  price_out: { label: 'Price: output (USD / 1M tokens)', default: '0' },
  price_cache_read: { label: 'Price: cache read (USD / 1M tokens)', default: '0' },
  price_cache_write: { label: 'Price: cache write (USD / 1M tokens)', default: '0' },
};

export const ACTIONS_LINK = {
  title: 'Open this workflow in GitHub Actions',
  url: 'https://github.com/${gh_repo}/actions?query=workflow:"${__field.labels.gh_aw_workflow_name}"',
  targetBlank: true,
};

export const TABLE_ACTIONS_LINK = {
  ...ACTIONS_LINK,
  url: 'https://github.com/${gh_repo}/actions?query=workflow:"${__data.fields.gh_aw_workflow_name}"',
};

// SYNTHETIC DATA ONLY. Serves fake gh-aw metrics in Prometheus exposition format so the
// dashboards can be exercised when no real gh-aw telemetry is available. Not for upstream.
//
//   node observability/grafana/tools/seed-metrics.mjs [--port 9101]
//
// Point a Prometheus scrape job at <host>:9101/metrics. Counters grow on every scrape, so
// rate()/increase() show activity. Label names/values match the expected gh-aw mapping.
import { createServer } from 'node:http';

const port = Number(process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : 9101);

// Title Case names and the job set match what real gh-aw telemetry shows.
const workflows = ['Triager', 'Executor', 'Review Agent', 'Orchestrator', 'Architect'];
const supportJobs = ['pre_activation', 'activation', 'detection', 'safe_outputs', 'conclusion'];
const models = ['claude-sonnet-5.5', 'claude-haiku-5.5'];
const engines = { Triager: 'copilot', Executor: 'copilot', 'Review Agent': 'claude', Orchestrator: 'copilot', Architect: 'copilot' };
const durationBuckets = [1, 5, 15, 30, 60, 120, 300, 600, 1800, 3600];
const turnBuckets = [1, 5, 15, 30, 60, 120, 300, 600, 1800, 3600];

const state = new Map(); // series key -> number
const lbl = (o) => Object.entries(o).map(([k, v]) => `${k}="${v}"`).join(',');
const bump = (name, labels, by = 1) => {
  const key = `${name}{${lbl(labels)}}`;
  state.set(key, (state.get(key) ?? 0) + by);
};
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (xs) => xs[Math.floor(Math.random() * xs.length)];

function observe(base, buckets, labels, value) {
  // Emit ALL bucket boundaries (even those above value as +0) so every series
  // has the same set of le labels. This prevents Prometheus extrapolation skew
  // when different buckets have different first-appearance timestamps.
  for (const b of buckets) bump(`${base}_bucket`, { ...labels, le: b }, value <= b ? 1 : 0);
  bump(`${base}_bucket`, { ...labels, le: '+Inf' });
  bump(`${base}_count`, labels);
  bump(`${base}_sum`, labels, value);
}

function tick() {
  for (const wf of workflows) {
    if (Math.random() < 0.3) continue;
    const base = { gh_aw_workflow_name: wf, gh_aw_job_name: 'agent' };
    // Q1 SLO ≥ 95%: ~2% failure rate fleet-wide (Executor slightly higher at 3%).
    const failed = Math.random() < (wf === 'Executor' ? 0.03 : 0.015);
    // Support jobs are short and almost always succeed.
    for (const job of supportJobs) {
      observe('gh_aw_job_duration_seconds', durationBuckets, { gh_aw_workflow_name: wf, gh_aw_job_name: job, cicd_pipeline_task_run_result: Math.random() < 0.005 ? 'failure' : 'success', gh_aw_engine_id: engines[wf], gen_ai_request_model: 'auto' }, rnd(2, 60));
    }
    // A2 SLO ≤ 2%: failures are mostly 'failure', rarely 'timed_out' (~0.5% of all runs).
    const result = failed ? pick(['failure', 'failure', 'failure', 'failure', 'timed_out', 'cancelled']) : 'success';
    const model = pick(models);
    // R1 SLO ≤ 1200s (20 min): most agent jobs 30-280s so p95 stays within the 300 bucket.
    observe('gh_aw_job_duration_seconds', durationBuckets, { ...base, cicd_pipeline_task_run_result: result, gh_aw_engine_id: engines[wf], gen_ai_request_model: model }, rnd(30, 280));
    if (failed) bump('gh_aw_job_errors_total', { ...base, cicd_pipeline_task_run_result: result });
    observe('gh_aw_agent_turns', turnBuckets, base, Math.round(rnd(2, 70)));
    const errType = failed && Math.random() < 0.5 ? pick(['timeout', 'rate_limit', 'model_error']) : '';
    observe('gen_ai_invoke_agent_duration_seconds', [1, 5, 15, 30, 60, 120, 300, 600], { ...base, gen_ai_request_model: model, error_type: errType }, rnd(10, 400));
    const input = Math.round(rnd(20000, 400000));
    bump('gen_ai_client_token_usage_total', { ...base, gen_ai_request_model: model, gen_ai_token_type: 'input' }, input);
    // C3 SLO ≥ 40%: cache read 50-70% of input tokens.
    bump('gen_ai_client_token_usage_total', { ...base, gen_ai_request_model: model, gen_ai_token_type: 'cache_read' }, Math.round(input * rnd(0.5, 0.7)));
    bump('gen_ai_client_token_usage_total', { ...base, gen_ai_request_model: model, gen_ai_token_type: 'cache_write' }, Math.round(input * rnd(0, 0.1)));
    bump('gen_ai_client_token_usage_total', { ...base, gen_ai_request_model: model, gen_ai_token_type: 'output' }, Math.round(rnd(1000, 20000)));
    const calls = Math.round(rnd(5, 60));
    // Q2 SLO ≥ 90%: ~5% of runs have a tool error (1-2 errors vs 5-60 ok calls).
    bump('gh_aw_tool_calls_total', { ...base, gh_aw_tool_status: 'ok' }, calls);
    if (Math.random() < 0.05) bump('gh_aw_tool_calls_total', { ...base, gh_aw_tool_status: 'error' }, Math.round(rnd(1, 2)));
    // T2 SLO ≥ 0.5: most successful runs produce 1-3 output items.
    if (wf !== 'Review Agent' && !failed) bump('gh_aw_workflow_output_items_total', { ...base, gh_aw_safe_output_type: pick(['add_comment', 'create_pull_request', 'add_labels', 'merge_pr', 'update_project', 'noop']) }, Math.round(rnd(1, 3)));
    // Q3 SLO ≤ 5%: very rare incomplete reports.
    if (failed && Math.random() < 0.1) bump('gh_aw_workflow_output_items_total', { ...base, gh_aw_safe_output_type: 'report_incomplete' });
    // C4 SLO ≤ 0: no rate-limit or credit events in healthy state.
  }
}

function render() {
  const lines = ['# SYNTHETIC gh-aw metrics (seed-metrics.mjs); do not use for real analysis'];
  for (const [key, value] of state) lines.push(`${key} ${value}`);
  return lines.join('\n') + '\n';
}

// Pre-fill counters so the first scrape already has a healthy baseline.
for (let i = 0; i < 1000; i++) tick();
setInterval(tick, 15000);
createServer((req, res) => {
  if (req.url === '/metrics') {
    tick();
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
    res.end(render());
  } else {
    res.writeHead(404).end();
  }
}).listen(port, () => console.log(`synthetic gh-aw metrics on :${port}/metrics`));


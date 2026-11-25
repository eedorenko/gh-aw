# gh-aw Grafana dashboards

SLO/SLI-driven Grafana dashboards for the OpenTelemetry metrics emitted by gh-aw
(see `specs/grafana-dashboards-spec.md` for the design). Dashboards start from what
operators of agentic workflows expect (happiness factors), derive measurable SLIs and SLO
thresholds, and are organised **glance -> scan -> commit**.

| Tier | Dashboard | Question |
| --- | --- | --- |
| Glance | `gh-aw / SLO Overview` | Is the fleet meeting expectations right now, and which factor is not? |
| Scan | `gh-aw / SLO Availability` | Are workflows running, or stuck or dead? Which ones time out? |
| Scan | `gh-aw / SLO Responsiveness` | Which workflows are slow? |
| Scan | `gh-aw / SLO Throughput` | Is work getting done, relative to the fleet's own baseline? |
| Scan | `gh-aw / SLO Quality` | Which workflows fail, error, or end incomplete? |
| Scan | `gh-aw / SLO Cost efficiency` | Which workflows burn tokens without matching output? |
| Commit | `gh-aw / Workflow Drilldown` | Why is this workflow violating an SLO? |

Start at the overview: a telemetry-health banner and five gauges, one per happiness factor
(Availability, Responsiveness, Throughput, Quality, Cost efficiency). Each gauge shows the actual
value of that factor's worst SLI (the one with the least headroom to its SLO), for example "p95 duration
8.3 min" against a 20 min ceiling. The SLI name and SLO are printed under the gauge and the threshold
markers show where the limits are: green (comfortable), yellow (approaching) or red (breached).
All green means everything is fine. Click a gauge to scan which workflows violate that factor's SLOs, then click a
workflow to drill down. Individual SLIs live in the scan dashboards. The
SLI definitions and thresholds are tabulated in the spec; the PromQL is in `definitions/slo.mjs`.

## Layout

```
definitions/slo.mjs              the SLI table (factor, PromQL, SLO, amber margin): source of truth for
                                 tiles, thresholds, SLO lines and alerts. Edit thresholds here.
definitions/slo-dashboards.mjs   glance and scan dashboards, generated from the SLI table
definitions/workflow-drilldown.mjs  commit dashboard
definitions/common.mjs           metric name map, labels, PromQL helpers, variables
dashboards/*.json                generated, importable into Grafana (do not edit by hand)
alerts/alerts.rules.yml          generated Prometheus alert rules, one per breached SLO
tools/generate.mjs               definitions -> dashboards and alerts (`--check` fails when stale)
tools/smoke-test.mjs             human-run: import into Grafana and run every query
tools/seed-metrics.mjs           SYNTHETIC data server for trying the dashboards without real telemetry
METRICS-PROPOSAL.md              upstream metric gaps (G1-G4)
```

Edit a definition, then run `node observability/grafana/tools/generate.mjs`. `npm test` fails
if the committed JSON or alert rules are stale.

## Prerequisites

### 1. Collector: convert delta to cumulative

gh-aw emits **delta** temporality. Without a delta-to-cumulative step before the Prometheus
exporter, `rate()` and `increase()` return wrong values (and the exporter may report
"Misaligned starting timestamps"). Minimal working collector config:

```yaml
receivers:
  otlp:
    protocols:
      grpc: { endpoint: 0.0.0.0:4317 }
      http: { endpoint: 0.0.0.0:4318 }
processors:
  delta_to_cumulative:      # confirmed on otelcol-contrib v0.164.0; other builds may call it `deltatocumulative`
exporters:
  prometheus:
    endpoint: 0.0.0.0:8889
service:
  pipelines:
    metrics:
      receivers: [otlp]
      processors: [delta_to_cumulative]
      exporters: [prometheus]
```

> Use the processor name your collector build accepts.

### 2. Metric name mapping

The Prometheus exporter turns dots into `_`, appends unit suffixes and `_total` for counters.
The dashboards use only these canonical series:

| OTEL metric | Prometheus series | Tier |
| --- | --- | --- |
| `gh_aw.job.duration` | `gh_aw_job_duration_seconds_{bucket,count,sum}` | A |
| `gh_aw.job.errors` | `gh_aw_job_errors_total` | A |
| `gh_aw.agent.turns` | `gh_aw_agent_turns_{bucket,count,sum}` | A |
| `gen_ai.invoke_agent.duration` | `gen_ai_invoke_agent_duration_seconds_{bucket,count,sum}` | A |
| `gh_aw.tool_calls` | `gh_aw_tool_calls_total` | A |
| `gh_aw.workflow.output_items` | `gh_aw_workflow_output_items_total` | A |
| input / output / cache tokens | `gen_ai_client_inference_usage_{input,output,cache_read_input,cache_write_input}_tokens_total` | A |
| `gh_aw.ai.credits.limit_exceeded`, `.rate_limit_errors` | `gh_aw_ai_credits_{limit_exceeded,rate_limit_errors}_total` | A |
| `gh_aw.otlp.export.failures` | `gh_aw_otlp_export_failures_total` | A |
| `gh_aw.ai.credits.usage` | `gh_aw_ai_credits_usage_total` | **B: not emitted yet** |

Your collector may also expose alias or compat series (`gh_aw_run_duration_seconds_*`,
`gh_aw_safe_outputs_total`, `gen_ai_client_token_usage_total`, `gh_aw_tokens_*_total`). The
dashboards never use them, because summing them double-counts. If your mapping differs, change
the one name map in `definitions/common.mjs` and regenerate.

Input tokens **include** cache tokens, so panels subtract cache to avoid double counting.

## Import

1. Create a Prometheus data source in Grafana.
2. Import each file in `dashboards/` (Dashboards > New > Import), or use the API
   (`tools/smoke-test.mjs` does this for you). Pick the Prometheus data source for `$ds`.
3. Set the dashboard variables:
   - `$gh_repo` (`owner/name`) powers the "open in GitHub Actions" links. Metrics carry no run
     ids, so links open the workflow's run list, not a single run.
   - `$slo_window` (default `7d`) is the window the SLIs are evaluated over.
   - `$price_in`, `$price_out`, `$price_cache_read`, `$price_cache_write` (USD per 1M tokens,
     default 0) drive the optional estimated-cost panels.
4. Optional: load `alerts/alerts.rules.yml` as a Prometheus rule file.

The dashboards link to each other by uid and share the `gh-aw` tag, so import all seven.

## Design rules

- Every panel traces to a happiness factor, SLI and SLO; its description states the question it
  answers, the SLI id, the SLO, its metric tier and which variables it ignores.
- Glance is fleet level (ignores `$workflow`), has six panels and fits one screen. Tier B (spec-only) metrics
  sit in a collapsed row in the drilldown and have no alerts.
- Missing is not zero: ratios use `a / (b > 0)`, so a quiet fleet shows "No data", not 0%.
- SLIs use `$slo_window`; trends use `$__rate_interval`.
- Relative SLOs (throughput, token burn) compare against the fleet's own trailing baseline
  because there is no agreed absolute budget yet. Tune the absolute thresholds after a week of
  real data.

## Validating against a live Grafana and Prometheus

```
GRAFANA_URL=https://<host> GRAFANA_TOKEN=<service-account-token> PROM_DS_UID=<datasource-uid> \
  node observability/grafana/tools/smoke-test.mjs
```

It imports the dashboards into a "gh-aw (test)" folder, runs every panel and variable query
through `/api/ds/query`, and prints `OK`, `NO DATA` or `ERROR` per query (Tier B `NO DATA` is
expected), then checks which expected metric names exist in Prometheus. It exits non-zero on any
`ERROR`. Use `--no-import` to only run queries, `--folder "name"` to pick the folder.

To exercise the panels without real telemetry, run `tools/seed-metrics.mjs` and add a Prometheus
scrape job for `<host>:9101`. The data is synthetic.

The smoke test checks that queries run, not how panels look; check layout in the Grafana UI.

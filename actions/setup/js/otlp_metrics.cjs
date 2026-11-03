// @ts-check
"use strict";

/**
 * otlp_metrics.cjs
 *
 * OTLP/JSON metrics support (counters, gauges, histograms) that mirrors the
 * trace pipeline in send_otlp_span.cjs: same endpoints, headers, retry and
 * sanitization rules, exported to `{endpoint}/v1/metrics` and mirrored to
 * `/tmp/gh-aw/otel-metrics.jsonl`.
 */

const fs = require("fs");
const path = require("path");
const { getErrorMessage } = require("./error_helpers.cjs");

const OTEL_METRICS_JSONL_PATH = "/tmp/gh-aw/otel-metrics.jsonl";

/** OTLP AggregationTemporality: DELTA = 1, CUMULATIVE = 2 */
const AGGREGATION_TEMPORALITY_DELTA = 1;

/** Default explicit histogram bucket bounds, in seconds. */
const DEFAULT_HISTOGRAM_BUCKETS = [1, 5, 15, 30, 60, 120, 300, 600, 1800, 3600];

const METRIC_TYPES = ["counter", "gauge", "histogram"];

/**
 * @param {number} ms
 * @returns {string} nanoseconds since epoch as a decimal string
 */
function toUnixNano(ms) {
  return (BigInt(Math.trunc(ms)) * 1000000n).toString();
}

/**
 * Build a numeric data point value in OTLP form.
 * @param {number} value
 * @returns {{asInt: string} | {asDouble: number}}
 */
function buildNumberValue(value) {
  return Number.isInteger(value) ? { asInt: String(value) } : { asDouble: value };
}

/**
 * Build one OTLP metric object.
 *
 * @param {{
 *   name: string,
 *   value: number,
 *   type?: "counter" | "gauge" | "histogram",
 *   unit?: string,
 *   description?: string,
 *   attributes?: Array<{key: string, value: object}>,
 *   buckets?: number[],
 *   startMs?: number,
 *   endMs?: number,
 * }} opts
 * @returns {any}
 */
function buildOTLPMetric({ name, value, type = "gauge", unit = "", description = "", attributes = [], buckets = DEFAULT_HISTOGRAM_BUCKETS, startMs, endMs }) {
  if (!METRIC_TYPES.includes(type)) {
    throw new Error(`unsupported metric type: ${type}`);
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`metric ${name}: value must be a finite number`);
  }
  const end = endMs ?? Date.now();
  const start = startMs ?? end;
  const base = { name, ...(unit ? { unit } : {}), ...(description ? { description } : {}) };

  if (type === "gauge") {
    return { ...base, gauge: { dataPoints: [{ attributes, timeUnixNano: toUnixNano(end), ...buildNumberValue(value) }] } };
  }
  if (type === "counter") {
    return {
      ...base,
      sum: {
        aggregationTemporality: AGGREGATION_TEMPORALITY_DELTA,
        isMonotonic: true,
        dataPoints: [{ attributes, startTimeUnixNano: toUnixNano(start), timeUnixNano: toUnixNano(end), ...buildNumberValue(value) }],
      },
    };
  }
  // histogram: a single observation placed into its explicit bucket
  const bounds = [...buckets].sort((a, b) => a - b);
  const bucketCounts = new Array(bounds.length + 1).fill("0");
  let idx = bounds.findIndex(b => value <= b);
  if (idx === -1) idx = bounds.length;
  bucketCounts[idx] = "1";
  return {
    ...base,
    histogram: {
      aggregationTemporality: AGGREGATION_TEMPORALITY_DELTA,
      dataPoints: [
        {
          attributes,
          startTimeUnixNano: toUnixNano(start),
          timeUnixNano: toUnixNano(end),
          count: "1",
          sum: value,
          min: value,
          max: value,
          bucketCounts,
          explicitBounds: bounds,
        },
      ],
    },
  };
}

/**
 * Wrap metrics in an OTLP `resourceMetrics` payload.
 *
 * @param {{
 *   serviceName: string,
 *   scopeVersion?: string,
 *   resourceAttributes?: Array<{key: string, value: object}>,
 *   metrics: any[],
 * }} opts
 * @returns {any}
 */
function buildOTLPMetricsPayload({ serviceName, scopeVersion, resourceAttributes, metrics }) {
  const { buildOTLPResourceAttributes } = require("./send_otlp_span.cjs");
  return {
    resourceMetrics: [
      {
        resource: { attributes: buildOTLPResourceAttributes(serviceName, scopeVersion, resourceAttributes) },
        scopeMetrics: [{ scope: { name: "gh-aw", version: scopeVersion || "unknown" }, metrics }],
      },
    ],
  };
}

/**
 * Redact sensitive attribute keys and truncate long values across a metrics
 * payload (resource attributes and every data point). Does not mutate input.
 *
 * @param {any} payload
 * @returns {any}
 */
function sanitizeOTLPMetricsPayload(payload) {
  if (!payload || !Array.isArray(payload.resourceMetrics)) return payload;
  const { sanitizeAttrs } = require("./send_otlp_span.cjs");
  const points = (/** @type {any} */ section) =>
    section && Array.isArray(section.dataPoints) ? { ...section, dataPoints: section.dataPoints.map((/** @type {any} */ dp) => ({ ...dp, attributes: sanitizeAttrs(dp.attributes) })) } : section;
  return {
    ...payload,
    resourceMetrics: payload.resourceMetrics.map((/** @type {any} */ rm) => ({
      ...rm,
      resource: rm.resource ? { ...rm.resource, attributes: sanitizeAttrs(rm.resource.attributes) } : rm.resource,
      scopeMetrics: Array.isArray(rm.scopeMetrics)
        ? rm.scopeMetrics.map((/** @type {any} */ sm) => ({
            ...sm,
            metrics: Array.isArray(sm.metrics) ? sm.metrics.map((/** @type {any} */ m) => ({ ...m, gauge: points(m.gauge), sum: points(m.sum), histogram: points(m.histogram) })) : sm.metrics,
          }))
        : rm.scopeMetrics,
    })),
  };
}

/**
 * Append a metrics payload to the local JSONL mirror. Never throws.
 * @param {any} payload
 */
function appendToOTLPMetricsJSONL(payload) {
  try {
    fs.mkdirSync(path.dirname(OTEL_METRICS_JSONL_PATH), { recursive: true });
    fs.appendFileSync(OTEL_METRICS_JSONL_PATH, JSON.stringify(payload) + "\n");
  } catch {
    // Mirror failures are non-fatal.
  }
}

/**
 * Mirror and export a metrics payload to all configured endpoints.
 * @param {any} payload
 * @param {string} [endpointOverride]
 * @returns {Promise<void>}
 */
async function sendOTLPMetrics(payload, endpointOverride) {
  const { parseOTLPEndpoints, sendOTLPToAllEndpoints, sendOTLPSpan } = require("./send_otlp_span.cjs");
  appendToOTLPMetricsJSONL(sanitizeOTLPMetricsPayload(payload));
  const opts = { skipJSONL: true, urlPath: "/v1/metrics", sanitize: sanitizeOTLPMetricsPayload };
  if (endpointOverride) {
    await sendOTLPSpan(endpointOverride, payload, opts);
    return;
  }
  await sendOTLPToAllEndpoints(parseOTLPEndpoints(), payload, opts);
}

/**
 * Build the built-in per-job run metrics from data the conclusion step already has.
 *
 * @param {{
 *   jobName?: string,
 *   workflow?: string,
 *   engine?: string,
 *   model?: string,
 *   conclusion?: string,
 *   startMs: number,
 *   endMs: number,
 *   inputTokens?: number,
 *   outputTokens?: number,
 *   emitsTokenUsage?: boolean,
 * }} opts
 * @returns {any[]}
 */
function buildBuiltinRunMetrics({ jobName = "", workflow = "", engine = "", model = "", conclusion = "", startMs, endMs, inputTokens, outputTokens, emitsTokenUsage = false }) {
  const { buildAttr } = require("./send_otlp_span.cjs");
  /** @type {Array<[string, string]>} */
  const common = [
    ["gh-aw.job", jobName],
    ["gh-aw.workflow", workflow],
  ];
  const attrs = (/** @type {Array<[string, string]>} */ extra = []) => [...common, ...extra].filter(([, v]) => v !== "").map(([k, v]) => buildAttr(k, v));
  /** @type {any[]} */
  const metrics = [];
  metrics.push(
    buildOTLPMetric({
      name: "gh_aw.run.duration",
      type: "histogram",
      unit: "s",
      description: "Job wall-clock duration",
      value: Math.max(0, (endMs - startMs) / 1000),
      attributes: attrs([["gh-aw.conclusion", conclusion]]),
      startMs,
      endMs,
    })
  );
  if (conclusion === "failure" || conclusion === "timed_out") {
    metrics.push(buildOTLPMetric({ name: "gh_aw.run.errors", type: "counter", unit: "{error}", value: 1, attributes: attrs([["gh-aw.conclusion", conclusion]]), startMs, endMs }));
  }
  if (emitsTokenUsage) {
    for (const [name, value] of /** @type {Array<[string, number | undefined]>} */ ([
      ["gh_aw.tokens.input", inputTokens],
      ["gh_aw.tokens.output", outputTokens],
    ])) {
      if (typeof value === "number" && value > 0) {
        metrics.push(buildOTLPMetric({ name, type: "counter", unit: "{token}", value, attributes: attrs([["gen_ai.request.model", model], ["gh-aw.engine", engine]]), startMs, endMs }));
      }
    }
  }
  return metrics;
}

/**
 * Public API: emit a single custom metric.
 *
 * @param {string} name
 * @param {number} value
 * @param {{
 *   type?: "counter" | "gauge" | "histogram",
 *   unit?: string,
 *   description?: string,
 *   attributes?: Record<string, string | number | boolean>,
 *   buckets?: number[],
 *   endpoint?: string,
 * }} [options]
 * @returns {Promise<void>}
 */
async function logMetric(name, value, options = {}) {
  try {
    const { buildAttr, buildGitHubActionsResourceAttributes, readJSONIfExists } = require("./send_otlp_span.cjs");
    const awInfo = readJSONIfExists("/tmp/gh-aw/aw_info.json") || {};
    const scopeVersion = (typeof awInfo.cli_version === "string" ? awInfo.cli_version : "") || process.env.GH_AW_INFO_CLI_VERSION || "unknown";
    const resourceAttributes = buildGitHubActionsResourceAttributes({
      repository: process.env.GITHUB_REPOSITORY || "",
      runId: process.env.GITHUB_RUN_ID || "",
      runAttempt: process.env.GITHUB_RUN_ATTEMPT || "1",
      eventName: process.env.GITHUB_EVENT_NAME || "",
      ref: process.env.GITHUB_REF || "",
      refName: process.env.GITHUB_REF_NAME || "",
      headRef: process.env.GITHUB_HEAD_REF || "",
      sha: process.env.GITHUB_SHA || "",
      job: process.env.GITHUB_JOB || "",
      workflowRef: process.env.GH_AW_CURRENT_WORKFLOW_REF || process.env.GITHUB_WORKFLOW_REF || "",
      actorId: process.env.GITHUB_ACTOR_ID || "",
      runnerOs: process.env.RUNNER_OS || "",
      runnerArch: process.env.RUNNER_ARCH || "",
      runnerName: process.env.RUNNER_NAME || "",
      runnerEnvironment: process.env.RUNNER_ENVIRONMENT || "",
      awfVersion: "",
      awmgVersion: "",
      staged: awInfo.staged === true,
    });
    const metric = buildOTLPMetric({
      name,
      value,
      type: options.type,
      unit: options.unit,
      description: options.description,
      buckets: options.buckets,
      attributes: Object.entries(options.attributes || {}).map(([k, v]) => buildAttr(k, v)),
    });
    const payload = buildOTLPMetricsPayload({ serviceName: process.env.OTEL_SERVICE_NAME || "gh-aw", scopeVersion, resourceAttributes, metrics: [metric] });
    await sendOTLPMetrics(payload, options.endpoint);
  } catch (err) {
    console.warn(`[otlp] ${name}: failed to emit metric: ${getErrorMessage(err)}`);
  }
}

module.exports = {
  OTEL_METRICS_JSONL_PATH,
  DEFAULT_HISTOGRAM_BUCKETS,
  buildOTLPMetric,
  buildOTLPMetricsPayload,
  sanitizeOTLPMetricsPayload,
  appendToOTLPMetricsJSONL,
  sendOTLPMetrics,
  buildBuiltinRunMetrics,
  logMetric,
};

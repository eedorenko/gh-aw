// @ts-check
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "module";

const req = createRequire(import.meta.url);
const m = req("./otlp_metrics.cjs");
const { buildAttr } = req("./send_otlp_span.cjs");

describe("otlp_metrics.cjs", () => {
  describe("buildOTLPMetric", () => {
    it("builds a gauge", () => {
      const metric = m.buildOTLPMetric({ name: "g", value: 0.5, type: "gauge", unit: "1", endMs: 1000 });
      expect(metric.gauge.dataPoints[0]).toMatchObject({ asDouble: 0.5, timeUnixNano: "1000000000" });
      expect(metric.unit).toBe("1");
    });

    it("builds a monotonic delta counter with int value", () => {
      const metric = m.buildOTLPMetric({ name: "c", value: 3, type: "counter", startMs: 1, endMs: 2 });
      expect(metric.sum).toMatchObject({ isMonotonic: true, aggregationTemporality: 1 });
      expect(metric.sum.dataPoints[0]).toMatchObject({ asInt: "3", startTimeUnixNano: "1000000", timeUnixNano: "2000000" });
    });

    it("places a histogram observation in the right bucket", () => {
      const metric = m.buildOTLPMetric({ name: "h", value: 7, type: "histogram", buckets: [10, 1, 5] });
      const dp = metric.histogram.dataPoints[0];
      expect(dp.explicitBounds).toEqual([1, 5, 10]);
      expect(dp.bucketCounts).toEqual(["0", "0", "1", "0"]);
      expect(dp).toMatchObject({ count: "1", sum: 7, min: 7, max: 7 });
    });

    it("uses the overflow bucket for large values", () => {
      const dp = m.buildOTLPMetric({ name: "h", value: 99, type: "histogram", buckets: [1, 5] }).histogram.dataPoints[0];
      expect(dp.bucketCounts).toEqual(["0", "0", "1"]);
    });

    it("rejects bad type and non-finite values", () => {
      expect(() => m.buildOTLPMetric({ name: "x", value: 1, type: /** @type {any} */ ("nope") })).toThrow(/unsupported/);
      expect(() => m.buildOTLPMetric({ name: "x", value: NaN })).toThrow(/finite/);
    });
  });

  describe("payload and sanitizer", () => {
    it("wraps metrics in resourceMetrics", () => {
      const metric = m.buildOTLPMetric({ name: "g", value: 1 });
      const payload = m.buildOTLPMetricsPayload({ serviceName: "svc", scopeVersion: "1.2.3", metrics: [metric] });
      expect(payload.resourceMetrics[0].scopeMetrics[0].scope).toEqual({ name: "gh-aw", version: "1.2.3" });
      expect(payload.resourceMetrics[0].scopeMetrics[0].metrics).toHaveLength(1);
    });

    it("redacts sensitive attributes on data points without mutating input", () => {
      const metric = m.buildOTLPMetric({ name: "c", value: 1, type: "counter", attributes: [buildAttr("api_token", "abc"), buildAttr("ok", "v")] });
      const payload = m.buildOTLPMetricsPayload({ serviceName: "svc", metrics: [metric] });
      const clean = m.sanitizeOTLPMetricsPayload(payload);
      const attrs = clean.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0].attributes;
      expect(attrs.find((/** @type {any} */ a) => a.key === "api_token").value.stringValue).not.toBe("abc");
      expect(attrs.find((/** @type {any} */ a) => a.key === "ok").value.stringValue).toBe("v");
      expect(metric.sum.dataPoints[0].attributes[0].value.stringValue).toBe("abc");
    });
  });

  describe("buildBuiltinRunMetrics", () => {
    const base = { jobName: "agent", workflow: "wf", engine: "copilot", model: "m", startMs: 0, endMs: 12000 };

    it("emits duration and tokens for a successful agent job", () => {
      const metrics = m.buildBuiltinRunMetrics({ ...base, conclusion: "success", inputTokens: 10, outputTokens: 5, emitsTokenUsage: true });
      expect(metrics.map((/** @type {any} */ x) => x.name)).toEqual(["gh_aw.run.duration", "gh_aw.tokens.input", "gh_aw.tokens.output"]);
      expect(metrics[0].histogram.dataPoints[0].sum).toBe(12);
    });

    it("emits an error counter on failure and no tokens when not emitting usage", () => {
      const metrics = m.buildBuiltinRunMetrics({ ...base, conclusion: "failure", inputTokens: 10, emitsTokenUsage: false });
      expect(metrics.map((/** @type {any} */ x) => x.name)).toEqual(["gh_aw.run.duration", "gh_aw.run.errors"]);
    });
  });

  describe("buildBuiltinRunMetrics tool calls and safe outputs", () => {
    const base = { jobName: "conclusion", startMs: 0, endMs: 1000, conclusion: "success" };

    it("emits tool call counters split by status and safe output counters by type", () => {
      const metrics = m.buildBuiltinRunMetrics({ ...base, toolCalls: 5, failedToolCalls: 2, outputItemTypes: ["add_comment", "add_comment", "create_issue"] });
      const names = metrics.map((/** @type {any} */ x) => x.name);
      expect(names.filter((/** @type {string} */ n) => n === "gh_aw.tool_calls")).toHaveLength(2);
      expect(names.filter((/** @type {string} */ n) => n === "gh_aw.safe_outputs")).toHaveLength(2);
      const ok = metrics.find((/** @type {any} */ x) => x.name === "gh_aw.tool_calls" && x.sum.dataPoints[0].asInt === "3" || x.sum?.dataPoints[0].asDouble === 3);
      expect(ok).toBeDefined();
    });

    it("emits nothing extra when counts are absent", () => {
      const metrics = m.buildBuiltinRunMetrics(base);
      expect(metrics.map((/** @type {any} */ x) => x.name)).toEqual(["gh_aw.run.duration"]);
    });
  });

  describe("logMetric", () => {
    /** @type {Record<string, string | undefined>} */
    let saved;
    beforeEach(() => {
      saved = { ...process.env };
      vi.spyOn(console, "warn").mockImplementation(() => {});
    });
    afterEach(() => {
      process.env = /** @type {any} */ (saved);
      vi.restoreAllMocks();
    });

    it("posts to /v1/metrics on the configured endpoint", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal("fetch", fetchMock);
      delete process.env.GH_AW_OTLP_ENDPOINTS;
      await m.logMetric("my.count", 2, { type: "counter", endpoint: "http://collector.example:4318/" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("http://collector.example:4318/v1/metrics");
      const body = JSON.parse(init.body);
      expect(body.resourceMetrics[0].scopeMetrics[0].metrics[0].name).toBe("my.count");
      vi.unstubAllGlobals();
    });

    it("never throws on invalid input", async () => {
      await expect(m.logMetric("bad", NaN)).resolves.toBeUndefined();
      expect(console.warn).toHaveBeenCalled();
    });
  });
});

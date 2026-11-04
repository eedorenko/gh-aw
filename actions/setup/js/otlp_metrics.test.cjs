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
      for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) delete process.env[k];
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

    it("rejects negative counters and invalid histogram buckets without throwing", async () => {
      expect(() => m.buildOTLPMetric({ name: "c", value: -1, type: "counter" })).toThrow();
      expect(() => m.buildOTLPMetric({ name: "h", value: 1, type: "histogram", buckets: [1, 1, 5] })).toThrow();
      expect(() => m.buildOTLPMetric({ name: "h", value: 1, type: "histogram", buckets: [1, Infinity] })).toThrow();
      await expect(m.logMetric("c", -1, { type: "counter" })).resolves.toBeUndefined();
    });

    it("encodes unsafe integers as doubles and sets a real interval start", () => {
      const big = m.buildOTLPMetric({ name: "g", value: 1e20 });
      expect(big.gauge.dataPoints[0].asDouble).toBe(1e20);
      const c = m.buildOTLPMetric({ name: "c", value: 1, type: "counter", endMs: Date.now() + 1000 });
      const dp = c.sum.dataPoints[0];
      expect(BigInt(dp.startTimeUnixNano)).toBeLessThan(BigInt(dp.timeUnixNano));
    });

    it("keeps repeated delta points for a series contiguous and non-overlapping", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal("fetch", fetchMock);
      delete process.env.GH_AW_OTLP_ENDPOINTS;
      const opts = { type: "counter", attributes: { k: "v" }, endpoint: "http://collector.example:4318/" };
      await m.logMetric("series.count", 1, opts);
      await new Promise(r => setTimeout(r, 5));
      await m.logMetric("series.count", 1, opts);
      const dp = i => JSON.parse(fetchMock.mock.calls[i][1].body).resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0];
      const [a, b] = [dp(0), dp(1)];
      expect(b.startTimeUnixNano).toBe(a.timeUnixNano);
      expect(BigInt(b.startTimeUnixNano)).toBeLessThan(BigInt(b.timeUnixNano));
      vi.unstubAllGlobals();
    });

    it("keeps real observation time for gauges and sub-millisecond drift for same-tick deltas", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal("fetch", fetchMock);
      delete process.env.GH_AW_OTLP_ENDPOINTS;
      vi.spyOn(Date, "now").mockReturnValue(1_900_000_000_000);
      const endpoint = "http://collector.example:4318/";
      for (let i = 0; i < 2000; i++) await m.logMetric("burst.count", 1, { type: "counter", endpoint });
      await m.logMetric("burst.gauge", 5, { endpoint });
      vi.restoreAllMocks();
      const calls = fetchMock.mock.calls;
      const last = JSON.parse(calls[1999][1].body).resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0];
      expect(BigInt(last.timeUnixNano) - 1_900_000_000_000n * 1000000n).toBeLessThan(3_000_000n);
      const g = JSON.parse(calls[2000][1].body).resourceMetrics[0].scopeMetrics[0].metrics[0].gauge.dataPoints[0];
      expect(g.timeUnixNano).toBe((1_900_000_000_000n * 1000000n).toString());
      vi.unstubAllGlobals();
    });

    it("emits strictly increasing, non-empty intervals for same-millisecond calls", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal("fetch", fetchMock);
      delete process.env.GH_AW_OTLP_ENDPOINTS;
      vi.spyOn(Date, "now").mockReturnValue(1_900_000_000_000);
      const opts = { type: "counter", attributes: { s: "t" }, endpoint: "http://collector.example:4318/" };
      await m.logMetric("tick.count", 1, opts);
      await m.logMetric("tick.count", 1, opts);
      vi.restoreAllMocks();
      const dp = i => JSON.parse(fetchMock.mock.calls[i][1].body).resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0];
      const [a, b] = [dp(0), dp(1)];
      expect(BigInt(a.startTimeUnixNano)).toBeLessThan(BigInt(a.timeUnixNano));
      expect(b.startTimeUnixNano).toBe(a.timeUnixNano);
      expect(BigInt(b.startTimeUnixNano)).toBeLessThan(BigInt(b.timeUnixNano));
      vi.unstubAllGlobals();
    });

    it("shares interval history across equivalent attribute orderings", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal("fetch", fetchMock);
      delete process.env.GH_AW_OTLP_ENDPOINTS;
      const endpoint = "http://collector.example:4318/";
      await m.logMetric("order.count", 1, { type: "counter", attributes: { a: "x", b: "y" }, endpoint });
      await new Promise(r => setTimeout(r, 5));
      await m.logMetric("order.count", 1, { type: "counter", attributes: { b: "y", a: "x" }, endpoint });
      const dp = i => JSON.parse(fetchMock.mock.calls[i][1].body).resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0];
      expect(dp(1).startTimeUnixNano).toBe(dp(0).timeUnixNano);
      vi.unstubAllGlobals();
    });

    it("never throws on invalid input", async () => {
      await expect(m.logMetric("bad", NaN)).resolves.toBeUndefined();
      expect(console.warn).toHaveBeenCalled();
    });
  });
});

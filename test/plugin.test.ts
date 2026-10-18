import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";

// Execute the exact plain JS model imported by QML, without requiring a desktop.
const model: Record<string, (...args: any[]) => any> = {};
runInNewContext(await Bun.file(new URL("../omarchy/Model.js", import.meta.url)).text(), model);
const group = {
  accountId: "a", plan: "pro", recordingStartedAt: "2026-10-15T10:00:00.000Z",
  resetCount: 2, estimatedUnusedWeeklyAllowances: 0.62, averageUnusedPercent: 31, samplingGapCount: 0,
};
const observation = {
  accountId: "a", plan: "pro", usedPercent: 12, remainingPercent: 88,
  checkedAt: "2026-10-15T10:00:00.000Z", resetsAt: "2026-10-22T10:00:00.000Z",
};
const data = { observation, groups: [group] };
function response(value: unknown) { return JSON.stringify({ schemaVersion: 1, ok: true, command: "summary", data: value }); }

test("widget displays accumulated allowance equivalents and selects the latest account and plan", () => {
  const result = model.parseSummary!(response({ observation, groups: [{ ...group, accountId: "b", estimatedUnusedWeeklyAllowances: 9 }, group] }));
  expect(model.barLabel!(result, "")).toBe("Codex · 0.62× unused");
});

test("widget distinguishes no samples, no resets, and a real zero-unused result", () => {
  expect(model.barLabel!(model.parseSummary!(response({ observation: null, groups: [] })), "")).toBe("Codex · no data");
  expect(model.barLabel!({ observation, groups: [{ ...group, resetCount: 0, averageUnusedPercent: null }] }, "")).toBe("Codex · awaiting reset");
  expect(model.barLabel!({ observation, groups: [{ ...group, estimatedUnusedWeeklyAllowances: 0 }] }, "")).toBe("Codex · 0.00× unused");
});

test("widget detects schema errors and structured failures instead of displaying zero", () => {
  expect(() => model.parseSummary!(JSON.stringify({ schemaVersion: 2 }))).toThrow("version");
  expect(() => model.parseSummary!(JSON.stringify({ schemaVersion: 1, ok: false, error: { message: "Database unavailable" } }))).toThrow("Database unavailable");
  expect(() => model.parseSummary!(response({ observation, groups: [{ ...group, estimatedUnusedWeeklyAllowances: null }] }))).toThrow("totals");
  expect(() => model.parseSummary!(response({ observation, groups: [] }))).toThrow("observation");
  expect(model.barLabel!(data, "Database unavailable")).toBe("Codex · unavailable");
});

test("widget freshness keeps advancing between CLI refreshes", () => {
  const checked = Date.parse(observation.checkedAt);
  expect(model.stale!(data, checked + 360_000)).toBe(false);
  expect(model.stale!(data, checked + 360_001)).toBe(true);
  expect(model.duration!(-10)).toBe("0s");
});

test("widget separates unavailable value from zero and explains calibration", () => {
  expect(model.money!(null)).toBe("—");
  expect(model.money!(0)).toBe("$0.00");
  expect(model.calibrationLabel!({ reason: "collecting-data", quotaUsedPercent: 2, minimumQuotaPercent: 5, weeklyApiValueUsd: null })).toContain("2.0 / 5");
  expect(model.calibrationLabel!({ reason: "unpriced-models", weeklyApiValueUsd: null })).toContain("no API price");
  expect(model.calibrationLabel!({ reason: "ready", quotaUsedPercent: 10, weeklyApiValueUsd: 300 })).toContain("$300.00");
  expect(() => model.parseSummary!(response({ observation, groups: [{ ...group, value: { estimatedUnusedUsd: "oops" } }] }))).toThrow("API value");
});

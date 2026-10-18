import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanTokens, normalizeUsage, type TokenEvent } from "../src/tokens";
import { apiCost, priceBook } from "../src/pricing";
import { UsageStore } from "../src/store";
import type { WeeklyQuota } from "../src/quota";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function temporary() { const path = mkdtempSync(join(tmpdir(), "codex-value-")); dirs.push(path); return path; }
const start = Date.parse("2026-10-15T12:00:00Z");
const counts = { input_tokens: 1000, cached_input_tokens: 600, cache_write_input_tokens: 100, output_tokens: 50, reasoning_output_tokens: 20 };
const context = (turn: string, model = "gpt-6-astra") => ({ type: "turn_context", payload: { turn_id: turn, model } });
const meta = { type: "session_meta", payload: { id: "session", model_provider: "openai" } };
const record = (id: string, turn: string, timestamp = start + 1000) => ({ type: "token_usage_record", timestamp: new Date(timestamp).toISOString(), payload: { response_id: id, turn_id: turn, usage: counts } });
const legacy = (total: number, timestamp = start + 1000) => ({ type: "event_msg", timestamp: new Date(timestamp).toISOString(), payload: { type: "token_count", info: { total_token_usage: { total_tokens: total }, last_token_usage: counts } } });
async function file(root: string, name: string, entries: unknown[]) {
  mkdirSync(join(root, "sessions"), { recursive: true });
  await Bun.write(join(root, "sessions", name), entries.map(x => JSON.stringify(x)).join("\n") + "\n");
}

test("cache and reasoning splits conserve tokens, invalid counts are rejected", () => {
  expect(normalizeUsage(counts)).toEqual({ inputTokens: 300, cachedInputTokens: 600, cacheWriteTokens: 100, outputTokens: 50 });
  expect(normalizeUsage({ ...counts, input_tokens: 10 })).toBeNull();
  expect(normalizeUsage({ ...counts, output_tokens: -1 })).toBeNull();
});

test("per-response records replace legacy snapshots; copied forks and archives deduplicate, subagents use their own model", async () => {
  const root = temporary();
  const entries = [meta, context("parent"), legacy(1050), record("response", "child")];
  await file(root, "parent.jsonl", entries);
  await file(root, "fork.jsonl", entries);
  await file(root, "child.jsonl", [meta, context("child", "gpt-6.1-sol"), record("response", "child"), legacy(1050)]);
  // Legacy parent has a separate turn, so keep it; the child legacy is replaced.
  const scan = await scanTokens(start, start + 5000, root);
  expect(scan.complete).toBe(true);
  expect(scan.events).toHaveLength(2);
  expect(scan.events.find(x => x.key === "response:response")?.model).toBe("gpt-6.1-sol");
  mkdirSync(join(root, "archived_sessions"));
  await Bun.write(join(root, "archived_sessions", "copy.jsonl"), entries.map(x => JSON.stringify(x)).join("\n"));
  expect((await scanTokens(start, start + 5000, root)).events).toEqual(scan.events);
});

test("legacy cumulative notifications count only new usage and preserve model switches", async () => {
  const root = temporary();
  await file(root, "legacy.jsonl", [meta, context("a"), legacy(1050), legacy(1050, start + 2000),
    context("b", "gpt-6.1-sol"), legacy(2100, start + 3000), legacy(2100, start + 4000)]);
  const scan = await scanTokens(start, start + 3500, root);
  expect(scan.events.map(x => x.model)).toEqual(["gpt-6-astra", "gpt-6.1-sol"]);
  expect(scan.events.map(x => x.outputTokens)).toEqual([50, 50]);
});

test("free safety checks and other providers are excluded; absent model identity remains unpriced", async () => {
  const root = temporary();
  await file(root, "events.jsonl", [meta, context("review", "codex-auto-review"), record("review", "review"),
    record("missing", "unseen-turn"), { ...meta, payload: { id: "other", model_provider: "other" } }, context("other"), record("other", "other")]);
  const scan = await scanTokens(start, start + 5000, root);
  expect(scan.events.map(x => x.model)).toEqual(["unknown"]);
  expect(apiCost("unknown", scan.events[0]!, priceBook())).toBeNull();
});

test("malformed/truncated files are flagged and recover on a later scan", async () => {
  const root = temporary();
  await file(root, "partial.jsonl", [meta, context("a"), record("a", "a")]);
  const path = join(root, "sessions/partial.jsonl");
  await Bun.write(path, await Bun.file(path).text() + '{"type":');
  expect((await scanTokens(start, start + 5000, root)).complete).toBe(false);
  await file(root, "partial.jsonl", [meta, context("a"), record("a", "a"), record("b", "a", start + 6000)]);
  expect((await scanTokens(start, start + 7000, root)).events).toHaveLength(2);
});

test("API pricing uses per-request context length and counts cache/reasoning once", () => {
  const usage = normalizeUsage(counts)!;
  expect(apiCost("gpt-6-astra", usage, priceBook())).toBeCloseTo(0.00735, 8);
  expect(apiCost("gpt-6.1-sol", usage, priceBook())).toBeCloseTo(0.00141, 8);
  expect(apiCost("gpt-6-astra", { inputTokens: 300_000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 1000 }, priceBook())).toBeCloseTo(6.075, 8);
});

function harness(path = ":memory:") {
  const store = new UsageStore(path);
  const events: TokenEvent[] = [];
  let complete = true;
  let prices = priceBook();
  async function poll(step: number, usedPercent: number, changes: Partial<WeeklyQuota> = {}) {
    const sample: WeeklyQuota = { accountId: "a", plan: "pro", bucket: "codex", checkedAt: start + step * 300_000,
      usedPercent, resetsAt: start / 1000 + 7 * 86400, ...changes };
    return store.collect(async () => sample, { prices,
      scan: async (since, until) => ({ source: "/sessions", complete, warnings: complete ? [] : ["read failed"],
        events: events.filter(x => x.timestamp > since && x.timestamp <= until) }) });
  }
  function usage(step: number, key = String(step), model = "gpt-6-astra") {
    events.push({ key, model, source: "response", timestamp: start + step * 300_000 - 1000,
      inputTokens: 100_000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }); // $1
  }
  return { store, events, poll, usage, incomplete: () => { complete = false; }, prices: (p: ReturnType<typeof priceBook>) => { prices = p; } };
}

test("calibration includes unchanged-percentage intervals and freezes early-reset estimates", async () => {
  const h = harness();
  await h.poll(0, 10);
  h.usage(1); await h.poll(1, 10);
  h.usage(2); await h.poll(2, 15);
  let group = h.store.summary("codex").groups[0]!;
  expect(group.value.currentCalibration).toMatchObject({ quotaUsedPercent: 5, pricedApiCostUsd: 2, usdPerPercentagePoint: 0.4, weeklyApiValueUsd: 40 });
  const reset = await h.poll(3, 0, { resetsAt: start / 1000 + 8 * 86400 });
  expect(reset.reset?.value.estimatedUnusedUsd).toBe(34);
  expect(reset.reset?.value.calibration?.quotaUsedPercent).toBe(5);
  expect(h.store.summary("codex").groups[0]!.value).toMatchObject({ estimatedUnusedUsd: 34, valuedResetCount: 1, unvaluedResetCount: 0 });
  expect(h.store.values.tokens().models[0]?.events).toBe(2); // repeated scans are idempotent
  h.store.close();
});

test("insufficient or unpriced data cannot produce a dollar estimate", async () => {
  const h = harness();
  await h.poll(0, 10); h.usage(1); await h.poll(1, 12);
  expect(h.store.summary("codex").groups[0]!.value.currentCalibration?.reason).toBe("collecting-data");
  h.usage(2, "unknown", "unpriced-model"); await h.poll(2, 20);
  expect(h.store.summary("codex").groups[0]!.value.currentCalibration).toMatchObject({ reason: "unpriced-models", usdPerPercentagePoint: null });
  const reset = await h.poll(3, 0, { resetsAt: start / 1000 + 8 * 86400 });
  expect(reset.reset?.value.estimatedUnusedUsd).toBeNull();
  expect(h.store.summary("codex").groups[0]!.value).toMatchObject({ estimatedUnusedUsd: null, valuedResetCount: 0, unvaluedResetCount: 1 });
  h.store.close();
});

test("poll gaps, usage drops, account switches and plan changes break calibration", async () => {
  for (const change of ["gap", "drop", "account", "plan"] as const) {
    const h = harness();
    await h.poll(0, 10); h.usage(1); await h.poll(1, 15);
    expect(h.store.summary("codex").groups[0]!.value.currentCalibration?.reason).toBe("ready");
    if (change === "gap") await h.poll(4, 20);
    if (change === "drop") await h.poll(2, 14);
    if (change === "account") { await h.poll(2, 30, { accountId: "b" }); await h.poll(3, 20); }
    if (change === "plan") await h.poll(2, 20, { plan: "plus" });
    expect(h.store.summary("codex").groups[0]!.value.currentCalibration?.usdPerPercentagePoint).toBeNull();
    h.store.close();
  }
});

test("scan failure, pricing changes and reset gaps invalidate valuation", async () => {
  for (const change of ["scan", "prices", "gap"] as const) {
    const h = harness();
    await h.poll(0, 10); h.usage(1); await h.poll(1, 15);
    if (change === "scan") h.incomplete();
    if (change === "prices") h.prices(priceBook({ "gpt-6-astra": { input: 20, output: 50, cachedInput: 1, cacheWrite: 12.5 } }));
    if (change === "gap") {
      const result = await h.poll(4, 0, { resetsAt: start / 1000 + 8 * 86400 });
      expect(result.reset?.value.reason).toBe("sampling-gap");
    } else {
      await h.poll(2, 20);
      expect(h.store.summary("codex").groups[0]!.value.currentCalibration?.usdPerPercentagePoint).toBeNull();
    }
    h.store.close();
  }
});

test("SQLite keeps tokens and frozen reset values across process restarts", async () => {
  const path = join(temporary(), "usage.sqlite");
  const h = harness(path);
  await h.poll(0, 10); h.usage(1); await h.poll(1, 15);
  await h.poll(2, 0, { resetsAt: start / 1000 + 8 * 86400 });
  h.store.close();
  const reopened = new UsageStore(path);
  expect(reopened.values.tokens().models[0]?.events).toBe(1);
  expect(reopened.history("codex")[0]?.value.estimatedUnusedUsd).toBe(17);
  reopened.close();
});


test("upgrading the pre-SSH token schema preserves retained records", () => {
  const path = join(temporary(), "old.sqlite");
  const old = new Database(path);
  old.exec(`CREATE TABLE token_events (
    source TEXT NOT NULL, eventKey TEXT NOT NULL, timestamp INTEGER NOT NULL, model TEXT NOT NULL,
    inputTokens INTEGER NOT NULL, cachedInputTokens INTEGER NOT NULL, cacheWriteTokens INTEGER NOT NULL,
    outputTokens INTEGER NOT NULL, cost REAL, pricingVersion TEXT NOT NULL, PRIMARY KEY(source, eventKey)
  )`);
  old.query("INSERT INTO token_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("/local", "response:old", start + 1000, "gpt-6-astra", 100000, 0, 0, 0, 1, "old");
  old.close();
  const upgraded = new UsageStore(path);
  expect(upgraded.values.tokens().models[0]).toMatchObject({ model: "gpt-6-astra", events: 1, inputTokens: 100000, pricedApiCostUsd: 1 });
  upgraded.close();
});

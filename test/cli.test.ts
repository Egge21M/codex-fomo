import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { name, version } from "../package.json";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageStore } from "../src/store";
import type { WeeklyQuota } from "../src/quota";

let directory: string;
let database: string;
let fakeCodex: string;
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "codex-usage-cli-"));
  database = join(directory, "usage.sqlite");
  fakeCodex = join(directory, "codex.ts");
  await Bun.write(fakeCodex, `#!${process.execPath}\n` + await Bun.file(join(import.meta.dir, "fixtures/app-server.ts")).text());
  chmodSync(fakeCodex, 0o700);
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

async function cli(args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "../index.ts"), ...args], {
    env: { ...process.env, XDG_CONFIG_HOME: join(directory, "config"), CODEX_USAGE_CONFIG: "", CODEX_USAGE_PRICES: "", CODEX_USAGE_TEST_MODE: "", CODEX_HOME: join(directory, "codex-home"), CODEX_USAGE_DB: database, CODEX_USAGE_BUCKET: "codex", CODEX_BIN: fakeCodex, CODEX_USAGE_DEBUG: "0", ...env },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

function parse(output: Awaited<ReturnType<typeof cli>>) {
  expect(output.stdout.trim().split("\n")).toHaveLength(1);
  const response = JSON.parse(output.stdout);
  expect(response.schemaVersion).toBe(1);
  expect(new Date(response.generatedAt).toISOString()).toBe(response.generatedAt);
  expect(output.stderr).toBe("");
  return response;
}

test("version works without Codex, pricing, or a database and supports JSON", async () => {
  const env = { CODEX_BIN: "/missing", CODEX_USAGE_PRICES: "/missing" };
  const human = await cli(["--version"], env);
  expect(human.exitCode).toBe(0);
  expect(human.stdout).toBe(`${name} ${version}\n`);
  const machine = await cli(["-v", "--json"], env);
  expect(machine.exitCode).toBe(0);
  expect(parse(machine)).toMatchObject({ ok: true, command: "version", data: { version } });
  expect(existsSync(database)).toBe(false);
});

const sample = (changes: Partial<WeeklyQuota> = {}): WeeklyQuota => ({
  accountId: "test-account", bucket: "codex", plan: "pro", usedPercent: 63,
  checkedAt: Date.now() - 600_000, resetsAt: Math.floor(Date.now() / 1000) + 86400,
  ...changes,
});

test("empty status, default command, and history return explicit successful empty states", async () => {
  for (const args of [["status", "--json"], ["--json"]]) {
    const output = await cli(args);
    expect(output.exitCode).toBe(0);
    expect(parse(output)).toMatchObject({ ok: true, command: "status", data: { bucket: "codex", observation: null } });
  }
  const output = await cli(["history", "--json"]);
  expect(output.exitCode).toBe(0);
  expect(parse(output)).toMatchObject({ ok: true, command: "history", data: { bucket: "codex", limit: 20, resets: [] } });
});

test("status exposes stable frontend fields, UTC dates, and freshness without polling", async () => {
  const store = new UsageStore(database);
  const saved = sample();
  await store.collect(async () => saved);
  store.close();
  // A broken Codex path proves status can be consumed entirely offline.
  const output = await cli(["status", "--json"], { CODEX_BIN: "/does-not-exist" });
  expect(output.exitCode).toBe(0);
  const response = parse(output);
  const observation = response.data.observation;
  expect(observation).toMatchObject({
    usedPercent: 63, remainingPercent: 37, windowDurationMins: 10080, stale: true,
    checkedAt: new Date(saved.checkedAt).toISOString(), resetsAt: new Date(saved.resetsAt * 1000).toISOString(),
  });
  const now = Date.parse(response.generatedAt);
  expect(observation.sampleAgeSeconds).toBe(Math.floor((now - saved.checkedAt) / 1000));
  expect(observation.secondsUntilReset).toBe(Math.ceil((saved.resetsAt * 1000 - now) / 1000));
});

test("elapsed reset countdown is zero, not a negative value", async () => {
  const store = new UsageStore(database);
  await store.collect(async () => sample({ resetsAt: Math.floor(Date.now() / 1000) - 10 }));
  store.close();
  expect(parse(await cli(["status", "--json"])).data.observation.secondsUntilReset).toBe(0);
});

test("poll returns its result with matching observation shape and no human output", async () => {
  const output = await cli(["poll", "--json"]);
  expect(output.exitCode).toBe(0);
  const response = parse(output);
  expect(response).toMatchObject({ ok: true, command: "poll", data: {
    bucket: "codex", baseline: true, reset: null, usageDropped: false,
    observation: { usedPercent: 63, remainingPercent: 37, stale: false, windowDurationMins: 10080 },
  } });
  const status = parse(await cli(["status", "--json"]));
  expect(Object.keys(status.data.observation).sort()).toEqual(Object.keys(response.data.observation).sort());
  expect(status.data.observation.id).toBe(response.data.observation.id);
});

test("poll reset and limited history use the same reset shape and timestamp units", async () => {
  const store = new UsageStore(database);
  await store.collect(async () => sample({ resetsAt: 1_999_000_000 }));
  store.close();
  const output = await cli(["poll", "--json"]);
  expect(output.exitCode).toBe(0);
  const event = parse(output).data.reset;
  expect(event).toMatchObject({ estimatedUnusedPercent: 37, oldResetAt: new Date(1_999_000_000_000).toISOString(), newResetAt: new Date(2_000_000_000_000).toISOString() });
  expect(new Date(event.detectedAt).toISOString()).toBe(event.detectedAt);
  const history = parse(await cli(["history", "--limit", "1", "--json"]));
  expect(history.data.limit).toBe(1);
  expect(history.data.resets).toEqual([event]);
});

test("bad commands, unknown flags, and invalid limits produce structured argument errors", async () => {
  for (const args of [["oops", "--json"], ["--json", "--unknown"], ["history", "--limit", "0", "--json"]]) {
    const output = await cli(args);
    expect(output.exitCode).toBe(1);
    expect(parse(output)).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENTS" } });
  }
});

test("Codex failures are structured and leave the stored sample intact", async () => {
  const store = new UsageStore(database);
  await store.collect(async () => sample({ usedPercent: 10 }));
  store.close();
  const output = await cli(["poll", "--json"], { CODEX_USAGE_TEST_MODE: "error" });
  expect(output.exitCode).toBe(1);
  expect(parse(output)).toMatchObject({ ok: false, command: "poll", error: { code: "CODEX_ERROR" } });
  expect(parse(await cli(["status", "--json"])).data.observation.usedPercent).toBe(10);
});

test("database failures produce structured storage errors", async () => {
  const blocked = join(directory, "not-a-directory");
  writeFileSync(blocked, "file");
  const output = await cli(["status", "--json"], { CODEX_USAGE_DB: join(blocked, "usage.sqlite") });
  expect(output.exitCode).toBe(1);
  expect(parse(output)).toMatchObject({ ok: false, command: "status", error: { code: "DATABASE_ERROR" } });
});

test("help respects JSON mode and human output remains the default", async () => {
  const help = parse(await cli(["--help", "--json"]));
  expect(help).toMatchObject({ ok: true, command: "help" });
  expect(help.data.usage).toContain("--json");
  const human = await cli(["status"]);
  expect(human.exitCode).toBe(0);
  expect(human.stdout).toContain("No observations yet");
  const error = await cli(["oops"]);
  expect(error.exitCode).toBe(1);
  expect(error.stdout).toBe("");
  expect(error.stderr).toContain("Unknown command");
});

test("summary returns an explicit empty state without fetching Codex", async () => {
  const output = await cli(["summary", "--json"], { CODEX_BIN: "/does-not-exist" });
  expect(output.exitCode).toBe(0);
  expect(parse(output)).toMatchObject({ ok: true, command: "summary", data: {
    bucket: "codex", recordingStartedAt: null, observation: null, groups: [],
  } });
});

test("summary aggregates all resets beyond history's default limit and separates plans and accounts", async () => {
  const store = new UsageStore(database);
  const base = sample();
  for (let i = 0; i <= 25; i++) {
    await store.collect(async () => ({ ...base, checkedAt: base.checkedAt + i * 300_000, resetsAt: base.resetsAt + i * 1000 }));
  }
  await store.collect(async () => ({ ...base, plan: "plus", checkedAt: base.checkedAt + 26 * 300_000 }));
  await store.collect(async () => ({ ...base, plan: "plus", checkedAt: base.checkedAt + 27 * 300_000, resetsAt: base.resetsAt + 1000 }));
  await store.collect(async () => ({ ...base, accountId: "other-account", checkedAt: base.checkedAt + 28 * 300_000 }));
  // A sampling gap with no reset still needs to appear in the coverage information.
  await store.collect(async () => ({ ...base, accountId: "other-account", checkedAt: base.checkedAt + 32 * 300_000 }));
  await store.collect(async () => ({ ...base, bucket: "other-bucket", checkedAt: base.checkedAt + 33 * 300_000 }));
  store.close();
  const output = await cli(["summary", "--json", "--limit", "1"], { CODEX_BIN: "/does-not-exist" });
  expect(output.exitCode).toBe(0);
  const data = parse(output).data;
  expect(data.recordingStartedAt).toBe(new Date(base.checkedAt).toISOString());
  expect(data.observation.accountId).toBe("other-account");
  expect(data.groups).toHaveLength(3);
  expect(data.groups.find((g: any) => g.accountId === "test-account" && g.plan === "pro")).toMatchObject({
    observationCount: 26, resetCount: 25, estimatedUnusedWeeklyAllowances: 9.25, averageUnusedPercent: 37, samplingGapCount: 0,
  });
  expect(data.groups.find((g: any) => g.plan === "plus")).toMatchObject({ resetCount: 1, estimatedUnusedWeeklyAllowances: 0.37 });
  expect(data.groups.find((g: any) => g.accountId === "other-account")).toMatchObject({ resetCount: 0, averageUnusedPercent: null, samplingGapCount: 1 });
});

test("tokens is an offline JSON command and unknown costs are not silently zeroed", async () => {
  const result = parse(await cli(["tokens", "--json"], { CODEX_BIN: "/does-not-exist" }));
  expect(result).toMatchObject({ ok: true, command: "tokens", data: { coverage: "local-native-sessions", recordingStartedAt: null, models: [], unpricedEvents: 0 } });
});

test("bad explicit pricing config yields a structured error without saving a poll", async () => {
  const result = await cli(["poll", "--json"], { CODEX_USAGE_PRICES: join(directory, "missing-prices.json") });
  expect(result.exitCode).toBe(1);
  expect(parse(result)).toMatchObject({ ok: false, error: { code: "CONFIG_ERROR" } });
  expect(parse(await cli(["status", "--json"])).data.observation).toBeNull();
});

test("poll, tokens and summary expose calibrated costs end to end", async () => {
  const home = join(directory, "codex-home");
  const checkedAt = Date.now() - 300_000;
  const store = new UsageStore(database);
  const { priceBook } = await import("../src/pricing");
  const { collectSources, parseSources } = await import("../src/sources");
  await store.collect(async () => sample({ checkedAt, usedPercent: 50, resetsAt: 2_000_000_000 }), {
    prices: priceBook(), scan: (since, until) => collectSources(parseSources({ sources: [{ id: "local", type: "local", codexHome: home }] }), since, until, {
      local: async () => ({ source: home, complete: true, warnings: [], events: [] }), remote: async () => { throw new Error("not used"); },
    }),
  });
  store.close();
  await Bun.write(join(home, "sessions/session.jsonl"), [
    { type: "session_meta", payload: { id: "test-session", model_provider: "openai" } },
    { type: "turn_context", payload: { turn_id: "turn", model: "gpt-6-astra" } },
    { type: "token_usage_record", timestamp: new Date(checkedAt + 1000).toISOString(), payload: {
      response_id: "response", turn_id: "turn", usage: { input_tokens: 100_000, output_tokens: 0 },
    } },
  ].map(x => JSON.stringify(x)).join("\n") + "\n");
  const result = parse(await cli(["poll", "--json"]));
  expect(result.data.calibration).toMatchObject({ reason: "ready", quotaUsedPercent: 13, pricedApiCostUsd: 1 });
  const tokens = parse(await cli(["tokens", "--json"]));
  expect(tokens.data.models).toHaveLength(1);
  expect(tokens.data.models[0]).toMatchObject({ model: "gpt-6-astra", inputTokens: 100_000, pricedApiCostUsd: 1 });
  const summary = parse(await cli(["summary", "--json"]));
  expect(summary.data.groups[0].value.currentCalibration.weeklyApiValueUsd).toBeCloseTo(100 / 13);
});

test("export-tokens reads metadata without opening a database, source config, or Codex connection", async () => {
  const since = Date.now() - 1000, until = Date.now();
  const home = join(directory, "export-home");
  await Bun.write(join(home, "sessions/test.jsonl"), [
    { type: "turn_context", payload: { turn_id: "export", model: "gpt-6-astra" } },
    { type: "token_usage_record", timestamp: new Date(until).toISOString(), payload: {
      turn_id: "export", response_id: "export", usage: { input_tokens: 10, output_tokens: 2 }, secret: "not exported",
    } },
  ].map(x => JSON.stringify(x)).join("\n"));
  const output = await cli(["export-tokens", "--since", String(since), "--until", String(until), "--codex-home", home, "--json"],
    { CODEX_BIN: "/missing", CODEX_USAGE_CONFIG: "/missing" });
  expect(output.exitCode).toBe(0);
  expect(parse(output)).toMatchObject({ command: "export-tokens", data: { protocolVersion: 1, since, until, scan: { complete: true, events: [{ key: "response:export" }] } } });
  expect(output.stdout).not.toContain("not exported");
  expect(existsSync(database)).toBe(false);
  expect(parse(await cli(["export-tokens", "--json"]))).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENTS" } });
});

test("invalid source configuration fails polling without writing an observation", async () => {
  const path = join(directory, "bad-sources.json");
  await Bun.write(path, JSON.stringify({ sources: [{ id: "bad", type: "ssh", host: "--bad" }] }));
  expect(parse(await cli(["poll", "--json"], { CODEX_USAGE_CONFIG: path }))).toMatchObject({ ok: false, error: { code: "CONFIG_ERROR" } });
  expect(parse(await cli(["status", "--json"])).data.observation).toBeNull();
});

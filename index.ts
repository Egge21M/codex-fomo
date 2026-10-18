#!/usr/bin/env bun
import { name, version } from "./package.json";
import { collectSources, loadSources, localPath } from "./src/sources";
import { scanTokens } from "./src/tokens";
import { loadPrices } from "./src/pricing";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { readWeeklyQuota } from "./src/codex";
import { UsageStore, type Observation, type Reset } from "./src/store";
import { CliError, observationOutput, resetOutput, summaryOutput, writeError, writeSuccess, type ErrorCode } from "./src/output";

const args = Bun.argv.slice(2);
// Detect the requested format before parsing, so argument errors are JSON too.
const jsonOutput = args.slice(0, args.includes("--") ? args.indexOf("--") : args.length).includes("--json");
let responseCommand: string | null = null;
let failureCode: ErrorCode = "INVALID_ARGUMENTS";

function duration(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor(seconds % 86400 / 3600)}h`;
}

function showObservation(sample: Observation) {
  const now = Date.now();
  console.log(`Weekly (${sample.bucket}): ${sample.usedPercent}% used, ${Math.max(0, 100 - sample.usedPercent)}% remaining`);
  console.log(`Next reset: ${new Date(sample.resetsAt * 1000).toLocaleString()} (${sample.resetsAt * 1000 > now ? `in ${duration(sample.resetsAt - now / 1000)}` : "awaiting a fresh reset timestamp"})`);
  console.log(`Last checked: ${new Date(sample.checkedAt).toLocaleString()} (${duration(Math.max(0, (now - sample.checkedAt) / 1000))} ago)`);
  if (now - sample.checkedAt > 360_000) console.log("STALE: no successful poll in the last six minutes.");
}

function showReset(reset: Reset) {
  console.log(`${new Date(reset.detectedAt).toLocaleString()} — inferred ${reset.reason} reset: ${reset.previousUsedPercent}% previously used, ≤${reset.estimatedUnusedPercent}% unused; sample gap ${duration(reset.sampleGapSeconds)}${reset.missedPolls ? " (missing polls; intervening resets may be unobserved)" : ""}`);
  console.log(`  Estimated unused API value: ${reset.value.estimatedUnusedUsd === null ? "unavailable (" + reset.value.reason + ")" : "$" + reset.value.estimatedUnusedUsd.toFixed(2)}`);
}

async function main() {
  const { positionals, values } = parseArgs({
    args, allowPositionals: true,
    options: { since: { type: "string" }, until: { type: "string" }, "codex-home": { type: "string" }, json: { type: "boolean" }, help: { type: "boolean", short: "h" }, version: { type: "boolean", short: "v" }, limit: { type: "string", default: "20" } },
  });
  const command = positionals[0] ?? "status";
  responseCommand = command;
  if (values.version) {
    if (values.json) writeSuccess("version", { version });
    else console.log(`${name} ${version}`);
    return;
  }
  if (values.help || command === "help") {
    const usage = `Usage: bun run index.ts <poll|status|history|summary|tokens|export-tokens> [--json] [--limit 20]

  poll     Fetch weekly usage and record reset shifts greater than 60 seconds.
  status   Show the latest saved observation (no network request).
  history  Show detected resets, newest first.
  summary  Aggregate all recorded resets, separately by account and plan.
  export-tokens  Export native token metadata; requires --since/--until Unix milliseconds.
  tokens   Show recorded tokens by model and standard API-equivalent cost.

  --json   Emit one versioned JSON response on stdout, including errors.
  --version, -v  Print the installed package version.

Environment:
  CODEX_USAGE_DB      Override the SQLite database path.
  CODEX_USAGE_BUCKET  Quota bucket to track (default: codex).
  CODEX_BIN          Codex executable (default: codex on PATH).
  CODEX_HOME         Native session directory (default: ~/.codex).
  CODEX_USAGE_CONFIG  Override source configuration JSON file.
  CODEX_USAGE_PRICES  Override model pricing JSON file.
  CODEX_USAGE_DEBUG   Set to 1 to print app-server diagnostics.`;
    if (values.json) writeSuccess("help", { usage });
    else console.log(usage);
    return;
  }
  if (positionals.length > 1 || !["poll", "status", "history", "summary", "tokens", "export-tokens"].includes(command)) throw new Error("Unknown command. Run with --help.");
  if (command === "export-tokens") {
    const since = Number(values.since), until = Number(values.until);
    if (values.since === undefined || values.until === undefined || !Number.isSafeInteger(since) || !Number.isSafeInteger(until) || since < 0 || until < since)
      throw new Error("export-tokens requires --since and --until as nonnegative Unix milliseconds, with until >= since.");
    const exportedAt = Date.now();
    const scan = await scanTokens(since, until, values["codex-home"] ? localPath(values["codex-home"]) : undefined);
    writeSuccess("export-tokens", { protocolVersion: 1, since, until, exportedAt, scan });
    return;
  }
  if (values.since !== undefined || values.until !== undefined || values["codex-home"] !== undefined)
    throw new Error("--since, --until and --codex-home apply only to export-tokens.");
  const limit = Number(values.limit);
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("--limit must be a positive integer.");
  const stateHome = process.env.XDG_STATE_HOME;
  const dbPath = process.env.CODEX_USAGE_DB
    ? resolve(process.env.CODEX_USAGE_DB)
    : join(stateHome && isAbsolute(stateHome) ? stateHome : join(homedir(), ".local/state"), "codex-usage/usage.sqlite");
  const bucket = process.env.CODEX_USAGE_BUCKET || "codex";
  process.umask(0o077);
  failureCode = "DATABASE_ERROR";
  const store = new UsageStore(dbPath);
  try {
    if (command === "poll") {
      failureCode = "CONFIG_ERROR";
      const prices = await loadPrices();
      const sources = await loadSources();
      failureCode = "DATABASE_ERROR";
      const result = await store.collect(async () => {
        try { return await readWeeklyQuota({ bucket }); }
        catch (error) { throw new CliError("CODEX_ERROR", error instanceof Error ? error.message : String(error)); }
      }, { scan: (since, until) => collectSources(sources, since, until), prices });
      failureCode = "INTERNAL_ERROR";
      if (values.json) {
        const now = Date.now();
        writeSuccess("poll", {
          bucket, observation: observationOutput(result.observation, now),
          reset: result.reset ? resetOutput(result.reset) : null,
          baseline: result.baseline, usageDropped: result.usageDropped,
          calibration: store.values.calibration(result.observation.id),
        }, now);
      }
      else {
        showObservation(result.observation);
        if (result.baseline) console.log("Baseline saved; no reset inferred for this first sample or changed plan.");
        if (result.reset) showReset(result.reset);
        const calibration = store.values.calibration(result.observation.id);
        if (calibration && !calibration.scanComplete) console.log("USD calibration paused: " + calibration.warnings.join(" "));
        if (result.usageDropped) console.log("Anomaly: usage fell without a reset timestamp shift greater than 60 seconds; no reset recorded.");
      }
    } else if (command === "tokens") {
      const tokens = store.values.tokens();
      if (values.json) writeSuccess("tokens", tokens);
      else {
        console.log(`Token recording since: ${tokens.recordingStartedAt || "not started; run poll"}`);
        for (const model of tokens.models) console.log(`${model.model}: ${model.inputTokens} input, ${model.cachedInputTokens} cached, ${model.cacheWriteTokens} cache-write, ${model.outputTokens} output — $${model.pricedApiCostUsd.toFixed(2)}${model.unpricedEvents ? ` (${model.unpricedEvents} unpriced records)` : ""}`);
        console.log(`Standard API-equivalent tokens: $${tokens.pricedApiCostUsd.toFixed(2)}${tokens.unpricedEvents ? " (partial; some models have no price)" : ""}`);
      }
    } else if (command === "status") {
      const sample = store.latest(bucket);
      failureCode = "INTERNAL_ERROR";
      if (values.json) {
        const now = Date.now();
        writeSuccess("status", { bucket, observation: sample ? observationOutput(sample, now) : null }, now);
      }
      else if (sample) showObservation(sample);
      else console.log("No observations yet. Run: bun run poll");
    } else if (command === "summary") {
      const summary = store.summary(bucket);
      failureCode = "INTERNAL_ERROR";
      const now = Date.now();
      if (values.json) writeSuccess("summary", summaryOutput(summary, now), now);
      else {
        if (!summary.groups.length) console.log("No observations yet. Run: bun run poll");
        for (const group of summary.groups) {
          console.log(`${group.plan} · account ${group.accountId}`);
          console.log(`Recording since: ${new Date(group.recordingStartedAt).toLocaleString()}`);
          console.log(group.resetCount ? `Estimated unused: ${group.estimatedUnusedWeeklyAllowances.toFixed(2)} weekly allowances across ${group.resetCount} resets (${group.averageUnusedPercent!.toFixed(1)}% average)` : "Awaiting first reset.");
          const value = group.value;
          console.log(`Estimated unused API value: ${value.estimatedUnusedUsd === null ? "unavailable" : "$" + value.estimatedUnusedUsd.toFixed(2)} (${value.valuedResetCount} valued resets, ${value.unvaluedResetCount} unvalued)`);
          const calibration = value.currentCalibration;
          console.log(calibration?.weeklyApiValueUsd !== null && calibration?.weeklyApiValueUsd !== undefined
            ? `Current weekly API-equivalent estimate: $${calibration.weeklyApiValueUsd.toFixed(2)} (${calibration.quotaUsedPercent.toFixed(1)} percentage points observed)`
            : `API-value calibration: ${calibration?.reason || "not started"}`);
          for (const source of calibration?.sources || []) console.log(`Source ${source.id}: ${source.complete ? "available" : "INCOMPLETE"}${source.warnings.length ? " — " + source.warnings.join(" ") : ""}`);
          console.log(`Historical valued resets with local-only coverage: ${value.localOnlyValuedResetCount}`);
          console.log("USD estimates use configured native session sources at standard API prices; unconfigured devices/cloud usage is not captured.");
          console.log(`Sampling gaps: ${group.samplingGapCount}`);
        }
        if (summary.observation) showObservation(summary.observation);
      }
    } else {
      const history = store.history(bucket, limit);
      failureCode = "INTERNAL_ERROR";
      if (values.json) writeSuccess("history", { bucket, limit, resets: history.map(resetOutput) });
      else if (history.length) history.forEach(showReset);
      else console.log("No weekly resets recorded yet.");
    }
  } finally { store.close(); }
}

await main().catch((error) => {
  if (jsonOutput) writeError(responseCommand, error instanceof CliError ? error.code : failureCode, error);
  else console.error(`${name}: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});

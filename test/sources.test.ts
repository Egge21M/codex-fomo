import { expect, test } from "bun:test";
import { collectSources, parseExport, parseSources, sshCommand, capture, type TokenExport } from "../src/sources";
import type { TokenEvent, TokenScan } from "../src/tokens";
import { UsageStore } from "../src/store";
import { priceBook } from "../src/pricing";

const at = 1_800_000_000_000;
const event: TokenEvent = { key: "response:one", timestamp: at + 1000, model: "gpt-6-astra", source: "response",
  inputTokens: 100_000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
const scan = (events = [event], source = "/sessions"): TokenScan => ({ source, events, complete: true, warnings: [] });
const sources = parseSources({ sources: [{ id: "laptop", type: "local", codexHome: "/local" }, { id: "vps", type: "ssh", host: "hermes" }] });
function exported(changes: Partial<TokenExport> = {}) {
  return JSON.stringify({ schemaVersion: 1, ok: true, command: "export-tokens",
    data: { protocolVersion: 1, since: at, until: at + 300_000, exportedAt: at + 300_000, scan: scan(), ...changes } });
}

test("source config validates aliases and IDs, supplies portable defaults, and rejects mistakes", () => {
  expect(sources[1]).toMatchObject({ host: "hermes", collectorPath: "~/.local/share/codex-fomo/index.ts", bunPath: "~/.bun/bin/bun" });
  for (const raw of [[], [{ id: "x", type: "ssh", host: "-oProxyCommand=oops" }],
    [{ id: "x", type: "ssh", host: "hermes", collectorPath: "relative/file" }],
    [{ id: "x", type: "local", typo: true }], [{ id: 42, type: "local" }],
    [{ id: "x", type: "local" }, { id: "x", type: "local" }]]) expect(() => parseSources({ sources: raw })).toThrow();
  const remote = parseSources({ sources: [{ id: "ssh", type: "ssh", host: "hermes", collectorPath: "/tmp/a '$(whoami)'/index.ts" }] })[0]!;
  if (remote.type !== "ssh") throw new Error("test setup");
  const args = sshCommand(remote, at, at + 1);
  expect(args).toContain("BatchMode=yes");
  expect(args).toContain("StrictHostKeyChecking=yes");
  expect(args.at(-1)).toContain("'/tmp/a '\\''$(whoami)'\\''/index.ts'");
});

test("export protocol rejects skew, wrong windows and invalid counts; strips nonmetadata fields", () => {
  expect(parseExport(exported(), at, at + 300_000, at + 300_000, at + 300_000).events).toEqual([event]);
  for (const changes of [{ until: at }, { exportedAt: at }, { scan: scan([{ ...event, inputTokens: -1 }]) },
    { scan: scan([{ ...event, timestamp: at }]) }]) {
    expect(() => parseExport(exported(changes), at, at + 300_000, at + 300_000, at + 300_001)).toThrow();
  }
  const extra = { ...event, prompt: "must not survive transport validation" };
  const result = parseExport(exported({ scan: scan([extra]) }), at, at + 300_000, at + 300_000, at + 300_000);
  expect(result.events[0]).not.toHaveProperty("prompt");
});

test("sources merge globally, prefer known models and invalidate conflicting duplicates", async () => {
  const local = async () => scan([{ ...event, model: "unknown" }]);
  const remote = async () => scan([event, { ...event, key: "response:two" }], "/remote");
  const merged = await collectSources(sources, at, at + 300_000, { local, remote });
  expect(merged.complete).toBe(true);
  expect(merged.sourceScope).toBe("configured-machines");
  expect(merged.events).toHaveLength(2);
  expect(merged.events[0]?.model).toBe("gpt-6-astra");
  const reordered = await collectSources([...sources].reverse(), at, at + 300_000, { local, remote });
  expect(reordered.source).toBe(merged.source);
  const conflict = await collectSources(sources, at, at + 300_000, { local, remote: async () => scan([{ ...event, outputTokens: 1 }]) });
  expect(conflict.complete).toBe(false);
  expect(conflict.warnings.join(" ")).toContain("Conflicting");
});

test("a failed source preserves quota polling but blocks USD and restarts on recovery", async () => {
  const store = new UsageStore(":memory:");
  let down = false;
  const read = { local: async () => scan([]), remote: async () => { if (down) throw new Error("connection failed"); return scan([event]); } };
  async function poll(step: number, usedPercent: number, configured = sources) {
    return store.collect(async () => ({ accountId: "a", plan: "pro", bucket: "codex", checkedAt: at + step * 300_000,
      usedPercent, resetsAt: 2_000_000_000 }), { prices: priceBook(), scan: (since, until) => collectSources(configured, since, until, read) });
  }
  await poll(0, 0);
  await poll(1, 5);
  expect(store.summary("codex").groups[0]?.value.currentCalibration?.reason).toBe("ready");
  down = true;
  await poll(2, 10);
  expect(store.latest("codex")?.usedPercent).toBe(10);
  expect(store.summary("codex").groups[0]?.value.currentCalibration).toMatchObject({ reason: "incomplete-scan", usdPerPercentagePoint: null,
    sources: [{ id: "laptop", complete: true }, { id: "vps", complete: false }] });
  down = false;
  await poll(3, 15);
  expect(store.summary("codex").groups[0]?.value.currentCalibration).toMatchObject({ reason: "collecting-data", quotaUsedPercent: 0 });
  await poll(4, 20, sources.slice(0, 1));
  expect(store.summary("codex").groups[0]?.value.currentCalibration?.quotaUsedPercent).toBe(0);
  expect(store.values.tokens().models[0]?.events).toBe(1); // no duplicates across source generations
  store.close();
});

test("process capture reports nonzero exits and terminates stalled exporters", async () => {
  await expect(capture([process.execPath, "-e", "process.exit(23)"])).rejects.toThrow("23");
  await expect(capture([process.execPath, "-e", "setInterval(() => {}, 1000)"], 100)).rejects.toThrow("timed out");
  expect(await capture([process.execPath, "-e", 'console.log("ok")'])).toBe("ok\n");
});

test("legacy local-only reset estimates remain labeled and frozen after adding SSH sources", async () => {
  const store = new UsageStore(":memory:");
  async function poll(step: number, usedPercent: number, reset = false, remote = false) {
    return store.collect(async () => ({ accountId: "a", plan: "pro", bucket: "codex", checkedAt: at + step * 300_000,
      usedPercent, resetsAt: 2_000_000_000 + (reset ? 1000 : 0) }), { prices: priceBook(),
      scan: async () => ({ ...scan(step ? [event] : []), source: remote ? "remote" : "local", sourceScope: remote ? "configured-machines" : "local-only" }) });
  }
  await poll(0, 0); await poll(1, 5); await poll(2, 0, true);
  const frozen = store.history("codex")[0]?.value.estimatedUnusedUsd;
  expect(frozen).toBe(19);
  await poll(3, 5, true, true);
  expect(store.summary("codex").groups[0]?.value.localOnlyValuedResetCount).toBe(1);
  expect(store.history("codex")[0]?.value).toMatchObject({ estimatedUnusedUsd: frozen, calibration: { sourceScope: "local-only" } });
  expect(store.values.tokens().models[0]?.events).toBe(1);
  store.close();
});

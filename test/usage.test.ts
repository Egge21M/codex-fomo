import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWeeklyQuota } from "../src/codex";
import { selectWeeklyQuota, type WeeklyQuota } from "../src/quota";
import { UsageStore } from "../src/store";

const directories: string[] = [];
const stores: UsageStore[] = [];
function database() {
  const directory = mkdtempSync(join(tmpdir(), "codex-usage-test-"));
  directories.push(directory);
  return join(directory, "usage.sqlite");
}
function open(path = ":memory:") {
  const store = new UsageStore(path);
  stores.push(store);
  return store;
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const sample = (changes: Partial<WeeklyQuota> = {}): WeeklyQuota => ({
  accountId: "account-a", bucket: "codex", plan: "pro", usedPercent: 63,
  resetsAt: 2_000_000_000, checkedAt: 1_999_000_000_000, ...changes,
});

describe("weekly quota selection", () => {
  test("uses the weekly duration, even when it is primary, and prefers the selected bucket", () => {
    const result = selectWeeklyQuota({ accountId: "a", rateLimitsByLimitId: {
      codex: { primary: { usedPercent: 63, resetsAt: 2000, windowDurationMins: 10080 }, secondary: { usedPercent: 99, windowDurationMins: 300 } },
      other: { primary: { usedPercent: 9, resetsAt: 1000, windowDurationMins: 10080 } },
    }, rateLimits: { secondary: { usedPercent: 100, resetsAt: 3000, windowDurationMins: 10080 } } });
    expect(result.usedPercent).toBe(63);
    expect(result.resetsAt).toBe(2000);
  });
  test("supports the legacy response", () => {
    expect(selectWeeklyQuota({ rateLimits: { secondary: { usedPercent: 42, resetsAt: 2000, windowDurationMins: 10080 } } }).usedPercent).toBe(42);
  });
  test("rejects missing weekly windows, missing reset data, and unrelated buckets", () => {
    expect(() => selectWeeklyQuota({ rateLimits: { primary: { windowDurationMins: 300 } } })).toThrow("weekly quota");
    expect(() => selectWeeklyQuota({ rateLimits: { secondary: { usedPercent: 0, resetsAt: null, windowDurationMins: 10080 } } })).toThrow("invalid");
    expect(() => selectWeeklyQuota({ rateLimits: { limitId: "other" } })).toThrow("bucket");
  });
});

describe("persistent collection", () => {
  test("one-second reset timestamp jitter at unchanged usage is not a reset", async () => {
    const store = open();
    await store.collect(async () => sample({ usedPercent: 11 }));
    const result = await store.collect(async () => sample({
      usedPercent: 11, checkedAt: sample().checkedAt + 89_000, resetsAt: sample().resetsAt + 1,
    }));
    expect(result.reset).toBeNull();
    expect(store.history("codex")).toEqual([]);
  });
  test("ignores jitter in either direction, including across minute boundaries", async () => {
    for (const shift of [-60, -1, 1, 60]) {
      const store = open();
      const initial = sample({ resetsAt: 2_000_000_039 }); // Last second of a minute.
      await store.collect(async () => initial);
      const result = await store.collect(async () => ({
        ...initial, resetsAt: initial.resetsAt + shift, checkedAt: initial.checkedAt + 300_000, usedPercent: 70,
      }));
      expect(result.reset).toBeNull();
      expect(store.latest("codex")?.resetsAt).toBe(initial.resetsAt + shift);
    }
  });
  test("detects timestamp shifts outside the tolerance in either direction", async () => {
    for (const shift of [-61, 61]) {
      const store = open();
      await store.collect(async () => sample());
      const { reset } = await store.collect(async () => sample({
        resetsAt: sample().resetsAt + shift, checkedAt: sample().checkedAt + 300_000, usedPercent: 70,
      }));
      expect(reset?.estimatedUnusedPercent).toBe(37);
    }
  });
  test("jitter after a real reset does not produce another reset event", async () => {
    const store = open();
    await store.collect(async () => sample());
    const next = sample({ resetsAt: sample().resetsAt + 1000, checkedAt: sample().checkedAt + 300_000 });
    await store.collect(async () => next);
    await store.collect(async () => ({ ...next, resetsAt: next.resetsAt + 1, checkedAt: next.checkedAt + 300_000 }));
    expect(store.history("codex")).toHaveLength(1);
  });
  test("first sample establishes a baseline; ordinary usage never creates a reset", async () => {
    const store = open();
    expect((await store.collect(async () => sample())).baseline).toBe(true);
    expect((await store.collect(async () => sample({ checkedAt: sample().checkedAt + 300_000, usedPercent: 70 }))).reset).toBeNull();
    expect(store.history("codex")).toEqual([]);
    expect(store.latest("codex")?.usedPercent).toBe(70);
  });
  test("detects early resets even when the new usage is higher, and does not count twice", async () => {
    const store = open();
    await store.collect(async () => sample());
    const next = sample({ checkedAt: sample().checkedAt + 300_000, resetsAt: sample().resetsAt + 1000, usedPercent: 70 });
    const { reset } = await store.collect(async () => next);
    expect(reset).toMatchObject({ reason: "early", previousUsedPercent: 63, estimatedUnusedPercent: 37, sampleGapSeconds: 300, missedPolls: false });
    await store.collect(async () => ({ ...next, checkedAt: next.checkedAt + 300_000 }));
    expect(store.history("codex")).toHaveLength(1);
  });
  test("detects scheduled resets and retains the baseline across process restarts", async () => {
    const path = database();
    const first = new UsageStore(path);
    await first.collect(async () => sample({ checkedAt: sample().resetsAt * 1000 - 60_000 }));
    first.close();
    const reopened = open(path);
    const { reset } = await reopened.collect(async () => sample({ checkedAt: sample().resetsAt * 1000 + 240_000, resetsAt: sample().resetsAt + 604800, usedPercent: 1 }));
    expect(reset).toMatchObject({ reason: "scheduled", estimatedUnusedPercent: 37, sampleGapSeconds: 300 });
    expect(reopened.history("codex")).toHaveLength(1);
  });
  test("usage drops with an unchanged timestamp are anomalies, not resets", async () => {
    const store = open();
    await store.collect(async () => sample());
    const result = await store.collect(async () => sample({ usedPercent: 2, checkedAt: sample().checkedAt + 300_000 }));
    expect(result.usageDropped).toBe(true);
    expect(result.reset).toBeNull();
  });
  test("failed polls leave the old baseline intact and mark long gaps", async () => {
    const store = open();
    await store.collect(async () => sample());
    await expect(store.collect(async () => { throw new Error("offline"); })).rejects.toThrow("offline");
    expect(store.latest("codex")?.usedPercent).toBe(63);
    const { reset } = await store.collect(async () => sample({ checkedAt: sample().checkedAt + 15 * 86400_000, resetsAt: sample().resetsAt + 14 * 86400 }));
    expect(reset?.missedPolls).toBe(true);
    expect(store.history("codex")).toHaveLength(1); // No invented intervening resets.
  });
  test("plan and account changes create baselines rather than false resets", async () => {
    const store = open();
    await store.collect(async () => sample());
    for (const changes of [{ accountId: "account-b" }, { plan: "plus" }]) {
      const result = await store.collect(async () => sample({ ...changes, checkedAt: sample().checkedAt + 300_000, resetsAt: sample().resetsAt + 1000 }));
      expect(result.baseline).toBe(true);
    }
    expect(store.history("codex")).toEqual([]);
  });
  test("overlapping collectors cannot read and commit out-of-order samples", async () => {
    const path = database();
    const first = open(path);
    const second = open(path);
    let release!: (sample: WeeklyQuota) => void;
    const waiting = first.collect(() => new Promise((resolve) => { release = resolve; }));
    let fetched = false;
    await expect(second.collect(async () => { fetched = true; return sample(); })).rejects.toThrow("locked");
    expect(fetched).toBe(false);
    release(sample());
    await waiting;
    expect(second.latest("codex")?.usedPercent).toBe(63);
  });
});

describe("app-server transport", () => {
  const command = (mode: string) => [process.execPath, join(import.meta.dir, "fixtures/app-server.ts"), mode];
  test("completes the handshake and handles notifications and split responses", async () => {
    const quota = await readWeeklyQuota({ command: command("ok") });
    expect(quota).toMatchObject({ usedPercent: 63, resetsAt: 2_000_000_000, accountId: "test-account" });
  });
  test("surfaces RPC errors", async () => {
    await expect(readWeeklyQuota({ command: command("error") })).rejects.toThrow("Sign in");
  });
  test("fails promptly when the child exits or sends invalid JSON", async () => {
    await expect(readWeeklyQuota({ command: command("exit") })).rejects.toThrow("closed");
    await expect(readWeeklyQuota({ command: command("malformed") })).rejects.toThrow("Cannot read");
  });
  test("bounds a stalled request and terminates the child", async () => {
    await expect(readWeeklyQuota({ command: command("hang"), timeoutMs: 100 })).rejects.toThrow("timed out");
  });
});

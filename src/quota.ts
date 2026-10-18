export const WEEK_MINS = 7 * 24 * 60;

export type WeeklyQuota = {
  accountId: string;
  bucket: string;
  plan: string;
  usedPercent: number;
  resetsAt: number; // Unix seconds, as returned by Codex.
  checkedAt: number; // Unix milliseconds.
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Codex rate-limit response: expected an object.");
  }
  return value as Record<string, unknown>;
}

export function selectWeeklyQuota(value: unknown, bucket = "codex"): WeeklyQuota {
  const response = object(value);
  const buckets = response.rateLimitsByLimitId;
  let selected: unknown;
  if (buckets && typeof buckets === "object" && Object.hasOwn(buckets, bucket)) {
    selected = (buckets as Record<string, unknown>)[bucket];
  } else if (response.rateLimits) {
    const legacy = object(response.rateLimits);
    if (legacy.limitId === bucket || (!legacy.limitId && bucket === "codex")) {
      selected = legacy;
    }
  }
  if (!selected) throw new Error(`Codex did not return quota bucket '${bucket}'.`);

  const snapshot = object(selected);
  const weekly = [snapshot.primary, snapshot.secondary].filter((window) =>
    window && typeof window === "object" &&
    (window as Record<string, unknown>).windowDurationMins === WEEK_MINS
  );
  if (weekly.length !== 1) {
    throw new Error(`Expected one weekly quota window in '${bucket}', found ${weekly.length}. No sample saved.`);
  }
  const window = object(weekly[0]);
  if (typeof window.usedPercent !== "number" || !Number.isFinite(window.usedPercent) || window.usedPercent < 0 ||
      typeof window.resetsAt !== "number" || !Number.isSafeInteger(window.resetsAt) || window.resetsAt <= 0) {
    throw new Error("Weekly quota has missing or invalid usage/reset data. No sample saved.");
  }
  return {
    accountId: typeof response.accountId === "string" && response.accountId ? response.accountId : "unknown",
    bucket,
    plan: typeof snapshot.planType === "string" ? snapshot.planType : "unknown",
    usedPercent: window.usedPercent,
    resetsAt: window.resetsAt,
    checkedAt: Date.now(),
  };
}

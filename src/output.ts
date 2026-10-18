import type { Calibration, TokenSummary } from "./value";
import { WEEK_MINS } from "./quota";
import type { Observation, Reset, SummaryGroup, UsageSummary } from "./store";

/** Public JSON contract. Breaking changes require a new schemaVersion. */
export type ObservationOutput = {
  id: number;
  accountId: string;
  bucket: string;
  plan: string;
  windowDurationMins: number;
  usedPercent: number;
  remainingPercent: number;
  checkedAt: string;
  resetsAt: string;
  sampleAgeSeconds: number;
  secondsUntilReset: number;
  stale: boolean;
};

export type ResetOutput = Omit<Reset, "detectedAt" | "oldResetAt" | "newResetAt"> & {
  detectedAt: string;
  oldResetAt: string;
  newResetAt: string;
};

export type CommandData = {
  version: { version: string };
  tokens: TokenSummary;
  summary: {
    bucket: string;
    recordingStartedAt: string | null;
    observation: ObservationOutput | null;
    groups: (Omit<SummaryGroup, "recordingStartedAt" | "lastCheckedAt"> & {
      recordingStartedAt: string; lastCheckedAt: string;
    })[];
  };
  status: { bucket: string; observation: ObservationOutput | null };
  poll: {
    bucket: string;
    observation: ObservationOutput;
    reset: ResetOutput | null;
    baseline: boolean;
    usageDropped: boolean;
    calibration: Calibration | null;
  };
  history: { bucket: string; limit: number; resets: ResetOutput[] };
  help: { usage: string };
};

export type ErrorCode = "INVALID_ARGUMENTS" | "CONFIG_ERROR" | "DATABASE_ERROR" | "CODEX_ERROR" | "INTERNAL_ERROR";
export type SuccessResponse = {
  [C in keyof CommandData]: {
    schemaVersion: 1;
    ok: true;
    command: C;
    generatedAt: string;
    data: CommandData[C];
  }
}[keyof CommandData];
export type ErrorResponse = {
  schemaVersion: 1;
  ok: false;
  command: string | null;
  generatedAt: string;
  error: { code: ErrorCode; message: string };
};
export type CliResponse = SuccessResponse | ErrorResponse;

export class CliError extends Error {
  constructor(public code: ErrorCode, message: string) { super(message); }
}

export function summaryOutput(summary: UsageSummary, now: number): CommandData["summary"] {
  return {
    bucket: summary.bucket,
    recordingStartedAt: summary.recordingStartedAt === null ? null : new Date(summary.recordingStartedAt).toISOString(),
    observation: summary.observation ? observationOutput(summary.observation, now) : null,
    groups: summary.groups.map(group => ({
      ...group,
      recordingStartedAt: new Date(group.recordingStartedAt).toISOString(),
      lastCheckedAt: new Date(group.lastCheckedAt).toISOString(),
    })),
  };
}

export function observationOutput(sample: Observation, now: number): ObservationOutput {
  return {
    id: sample.id,
    accountId: sample.accountId,
    bucket: sample.bucket,
    plan: sample.plan,
    windowDurationMins: WEEK_MINS,
    usedPercent: sample.usedPercent,
    remainingPercent: Math.max(0, 100 - sample.usedPercent),
    checkedAt: new Date(sample.checkedAt).toISOString(),
    resetsAt: new Date(sample.resetsAt * 1000).toISOString(),
    sampleAgeSeconds: Math.max(0, Math.floor((now - sample.checkedAt) / 1000)),
    secondsUntilReset: Math.max(0, Math.ceil((sample.resetsAt * 1000 - now) / 1000)),
    stale: now - sample.checkedAt > 360_000,
  };
}

export function resetOutput(reset: Reset): ResetOutput {
  return {
    id: reset.id,
    previousObservationId: reset.previousObservationId,
    currentObservationId: reset.currentObservationId,
    detectedAt: new Date(reset.detectedAt).toISOString(),
    oldResetAt: new Date(reset.oldResetAt * 1000).toISOString(),
    newResetAt: new Date(reset.newResetAt * 1000).toISOString(),
    previousUsedPercent: reset.previousUsedPercent,
    estimatedUnusedPercent: reset.estimatedUnusedPercent,
    sampleGapSeconds: reset.sampleGapSeconds,
    missedPolls: reset.missedPolls,
    reason: reset.reason,
    value: reset.value,
  };
}

export function writeSuccess<C extends keyof CommandData>(command: C, data: CommandData[C], now = Date.now()) {
  console.log(JSON.stringify({ schemaVersion: 1, ok: true, command, generatedAt: new Date(now).toISOString(), data }));
}

export function writeError(command: string | null, code: ErrorCode, error: unknown) {
  const response: ErrorResponse = {
    schemaVersion: 1, ok: false, command, generatedAt: new Date().toISOString(),
    error: { code, message: error instanceof Error ? error.message : String(error) },
  };
  console.log(JSON.stringify(response));
}

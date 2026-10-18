import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ValueStore, type ValueSummary, type ResetValue } from "./value";
import type { TokenScan } from "./tokens";
import type { PriceBook } from "./pricing";
import { WEEK_MINS, type WeeklyQuota } from "./quota";

// Repeated reads can report slightly different deadlines for the same window.
// Compare the delta, rather than rounding timestamps (which creates boundary artifacts).
export const RESET_TIMESTAMP_TOLERANCE_SECONDS = 60;

export type Observation = WeeklyQuota & { id: number };
export type SummaryGroup = {
  accountId: string;
  plan: string;
  recordingStartedAt: number;
  lastCheckedAt: number;
  observationCount: number;
  resetCount: number;
  estimatedUnusedWeeklyAllowances: number;
  averageUnusedPercent: number | null;
  samplingGapCount: number;
  value: ValueSummary;
};
export type UsageSummary = {
  bucket: string;
  recordingStartedAt: number | null;
  observation: Observation | null;
  groups: SummaryGroup[];
};
export type Reset = {
  id: number;
  previousObservationId: number;
  currentObservationId: number;
  detectedAt: number;
  oldResetAt: number;
  newResetAt: number;
  previousUsedPercent: number;
  estimatedUnusedPercent: number;
  sampleGapSeconds: number;
  missedPolls: boolean;
  reason: "scheduled" | "early";
  value: ResetValue;
};

export class UsageStore {
  private db: Database;
  readonly values: ValueStore;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec(`
      PRAGMA busy_timeout = 1000;
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS observations (
        id INTEGER PRIMARY KEY,
        accountId TEXT NOT NULL,
        bucket TEXT NOT NULL,
        plan TEXT NOT NULL,
        checkedAt INTEGER NOT NULL,
        usedPercent REAL NOT NULL CHECK (usedPercent >= 0),
        resetsAt INTEGER NOT NULL,
        windowDurationMins INTEGER NOT NULL DEFAULT ${WEEK_MINS}
      );
      CREATE INDEX IF NOT EXISTS observation_stream ON observations(accountId, bucket, id DESC);
      CREATE TABLE IF NOT EXISTS resets (
        id INTEGER PRIMARY KEY,
        previousObservationId INTEGER NOT NULL REFERENCES observations(id),
        currentObservationId INTEGER NOT NULL UNIQUE REFERENCES observations(id),
        estimatedUnusedPercent REAL NOT NULL CHECK (estimatedUnusedPercent BETWEEN 0 AND 100),
        reason TEXT NOT NULL CHECK (reason IN ('scheduled', 'early'))
      );
    `);
    this.values = new ValueStore(this.db);
  }

  /** Serialize the entire poll, including its network read, across processes. */
  async collect(fetch: () => Promise<WeeklyQuota>, tokens?: { scan: (since: number, until: number) => Promise<TokenScan>; prices: PriceBook }): Promise<{ observation: Observation; reset: Reset | null; baseline: boolean; usageDropped: boolean }> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const sample = await fetch();
      const previous = this.db.query<Observation, [string, string]>(
        "SELECT * FROM observations WHERE accountId = ? AND bucket = ? ORDER BY id DESC LIMIT 1",
      ).get(sample.accountId, sample.bucket);
      if (previous && sample.checkedAt <= previous.checkedAt) {
        throw new Error("Sample time did not advance; no observation saved. Check the system clock.");
      }
      const result = this.db.query(`
        INSERT INTO observations (accountId, bucket, plan, checkedAt, usedPercent, resetsAt)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(sample.accountId, sample.bucket, sample.plan, sample.checkedAt, sample.usedPercent, sample.resetsAt);
      const observation = { ...sample, id: Number(result.lastInsertRowid) };
      const baseline = !previous || previous.plan !== sample.plan;
      let reset: Reset | null = null;
      if (!baseline && Math.abs(previous.resetsAt - sample.resetsAt) > RESET_TIMESTAMP_TOLERANCE_SECONDS) {
        this.db.query(`
          INSERT INTO resets (previousObservationId, currentObservationId, estimatedUnusedPercent, reason)
          VALUES (?, ?, ?, ?)
        `).run(previous.id, observation.id, Math.max(0, 100 - previous.usedPercent),
          sample.checkedAt >= previous.resetsAt * 1000 ? "scheduled" : "early");
        reset = this.history(sample.bucket, 1)[0] ?? null;
      }
      const usageDropped = !baseline && !reset && sample.usedPercent < previous.usedPercent;
      if (tokens) {
        const since = this.values.start(sample.checkedAt);
        const scan = await tokens.scan(since, sample.checkedAt);
        this.values.record(observation, previous, scan, tokens.prices, reset);
        if (reset) reset.value = this.values.resetValue(reset.id);
      }
      this.db.exec("COMMIT");
      return { observation, reset, baseline, usageDropped };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  latest(bucket: string): Observation | null {
    return this.db.query<Observation, [string]>(
      "SELECT * FROM observations WHERE bucket = ? ORDER BY id DESC LIMIT 1",
    ).get(bucket);
  }

  history(bucket: string, limit = 20): Reset[] {
    return this.db.query<Omit<Reset, "missedPolls">, [string, number]>(`
      SELECT r.*, current.checkedAt AS detectedAt,
        previous.resetsAt AS oldResetAt, current.resetsAt AS newResetAt,
        previous.usedPercent AS previousUsedPercent,
        (current.checkedAt - previous.checkedAt) / 1000.0 AS sampleGapSeconds
      FROM resets r
      JOIN observations previous ON previous.id = r.previousObservationId
      JOIN observations current ON current.id = r.currentObservationId
      WHERE current.bucket = ? ORDER BY r.id DESC LIMIT ?
    `).all(bucket, limit).map((reset) => ({ ...reset, missedPolls: reset.sampleGapSeconds > 360, value: this.values.resetValue(reset.id) }));
  }

  summary(bucket: string): UsageSummary {
    // Read current usage and aggregates from one SQLite snapshot. No history limit.
    return this.db.transaction(() => {
      const groups = this.db.query<SummaryGroup, [string, string]>(`
        WITH samples AS (
          SELECT *,
            LAG(checkedAt) OVER (PARTITION BY accountId, bucket ORDER BY id) AS previousCheck,
            LAG(plan) OVER (PARTITION BY accountId, bucket ORDER BY id) AS previousPlan
          FROM observations WHERE bucket = ?
        ), totals AS (
          SELECT current.accountId, current.plan, COUNT(*) AS resetCount,
            SUM(r.estimatedUnusedPercent) / 100.0 AS estimatedUnusedWeeklyAllowances,
            AVG(r.estimatedUnusedPercent) AS averageUnusedPercent
          FROM resets r JOIN observations current ON current.id = r.currentObservationId
          WHERE current.bucket = ? GROUP BY current.accountId, current.plan
        )
        SELECT s.accountId, s.plan, MIN(s.checkedAt) AS recordingStartedAt,
          MAX(s.checkedAt) AS lastCheckedAt, COUNT(*) AS observationCount,
          COALESCE(t.resetCount, 0) AS resetCount,
          COALESCE(t.estimatedUnusedWeeklyAllowances, 0) AS estimatedUnusedWeeklyAllowances,
          t.averageUnusedPercent,
          SUM(CASE WHEN s.previousPlan = s.plan AND s.checkedAt - s.previousCheck > 360000 THEN 1 ELSE 0 END) AS samplingGapCount
        FROM samples s LEFT JOIN totals t ON t.accountId = s.accountId AND t.plan = s.plan
        GROUP BY s.accountId, s.plan ORDER BY lastCheckedAt DESC
      `).all(bucket, bucket);
      return {
        bucket,
        recordingStartedAt: groups.length ? Math.min(...groups.map(group => group.recordingStartedAt)) : null,
        observation: this.latest(bucket),
        groups: groups.map(group => ({ ...group, value: this.values.summary(group.accountId, group.plan, bucket, group.resetCount) })),
      };
    })();
  }

  close() { this.db.close(); }
}

import type { Database } from "bun:sqlite";
import { apiCost, type PriceBook } from "./pricing";
import type { TokenScan, TokenUsage } from "./tokens";
import type { Observation, Reset } from "./store";

export const MIN_CALIBRATION_PERCENT = 5;
export type ModelUsage = TokenUsage & { model: string; events: number; pricedApiCostUsd: number; unpricedEvents: number };
export type Calibration = {
  basis: "standard-api-token-prices";
  coverage: "local-native-sessions";
  source: string; pricingVersion: string; pricingSource: string;
  scanComplete: boolean; warnings: string[];
  baselineAt: string; baselineUsedPercent: number;
  checkedAt: string; quotaUsedPercent: number; minimumQuotaPercent: number;
  pricedApiCostUsd: number; unpricedEvents: number;
  usdPerPercentagePoint: number | null; weeklyApiValueUsd: number | null;
  reason: string; models: ModelUsage[];
};
export type ValueSummary = {
  estimatedUnusedUsd: number | null;
  valuedResetCount: number;
  unvaluedResetCount: number;
  currentCalibration: Calibration | null;
};
export type ResetValue = { estimatedUnusedUsd: number | null; reason: string; calibration: Calibration | null };
export type TokenSummary = {
  coverage: "local-native-sessions"; recordingStartedAt: string | null;
  pricedApiCostUsd: number; unpricedEvents: number; models: ModelUsage[];
};

export class ValueStore {
  constructor(private db: Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS token_tracking (id INTEGER PRIMARY KEY CHECK(id = 1), startedAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS token_events (
        source TEXT NOT NULL, eventKey TEXT NOT NULL, timestamp INTEGER NOT NULL, model TEXT NOT NULL,
        inputTokens INTEGER NOT NULL, cachedInputTokens INTEGER NOT NULL, cacheWriteTokens INTEGER NOT NULL,
        outputTokens INTEGER NOT NULL, cost REAL, pricingVersion TEXT NOT NULL,
        PRIMARY KEY(source, eventKey)
      );
      CREATE INDEX IF NOT EXISTS token_event_time ON token_events(source, timestamp);
      CREATE TABLE IF NOT EXISTS value_samples (
        observationId INTEGER PRIMARY KEY REFERENCES observations(id), calibration TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reset_values (
        resetId INTEGER PRIMARY KEY REFERENCES resets(id), value TEXT NOT NULL
      );
    `);
  }

  start(at: number): number {
    this.db.query("INSERT OR IGNORE INTO token_tracking VALUES (1, ?)").run(at);
    return this.db.query<{ startedAt: number }, []>("SELECT startedAt FROM token_tracking WHERE id = 1").get()!.startedAt;
  }

  calibration(observationId: number): Calibration | null {
    const row = this.db.query<{ calibration: string }, [number]>("SELECT calibration FROM value_samples WHERE observationId = ?").get(observationId);
    return row ? JSON.parse(row.calibration) : null;
  }

  record(sample: Observation, previous: Observation | null, scan: TokenScan, book: PriceBook, reset: Reset | null): Calibration {
    const insert = this.db.query(`INSERT INTO token_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source, eventKey) DO UPDATE SET model=excluded.model, cost=excluded.cost, pricingVersion=excluded.pricingVersion`);
    for (const event of scan.events) insert.run(scan.source, event.key, event.timestamp, event.model,
      event.inputTokens, event.cachedInputTokens, event.cacheWriteTokens, event.outputTokens, apiCost(event.model, event, book), book.version);

    const prior = previous ? this.calibration(previous.id) : null;
    const lastGlobal = this.db.query<Observation, [number]>("SELECT * FROM observations WHERE id < ? ORDER BY id DESC LIMIT 1").get(sample.id);
    const gap = previous ? sample.checkedAt - previous.checkedAt : Infinity;
    const continuous = previous && prior && lastGlobal?.id === previous.id && !reset &&
      previous.plan === sample.plan && previous.accountId === sample.accountId &&
      sample.usedPercent >= previous.usedPercent && sample.usedPercent <= 100 && gap <= 360_000 &&
      prior.scanComplete && scan.complete && prior.source === scan.source && prior.pricingVersion === book.version;
    const baselineAt = continuous ? prior.baselineAt : new Date(sample.checkedAt).toISOString();
    const baselineUsedPercent = continuous ? prior.baselineUsedPercent : sample.usedPercent;
    const models = this.models(scan.source, Date.parse(baselineAt), sample.checkedAt);
    const pricedApiCostUsd = models.reduce((sum, m) => sum + m.pricedApiCostUsd, 0);
    const unpricedEvents = models.reduce((sum, m) => sum + m.unpricedEvents, 0);
    const quotaUsedPercent = sample.usedPercent - baselineUsedPercent;
    const reason = !scan.complete ? "incomplete-scan" : unpricedEvents ? "unpriced-models" :
      quotaUsedPercent < MIN_CALIBRATION_PERCENT ? "collecting-data" : pricedApiCostUsd <= 0 ? "no-local-usage" : "ready";
    const usdPerPercentagePoint = reason === "ready" ? pricedApiCostUsd / quotaUsedPercent : null;
    const calibration: Calibration = {
      basis: "standard-api-token-prices", coverage: "local-native-sessions", source: scan.source,
      pricingVersion: book.version, pricingSource: book.source, scanComplete: scan.complete, warnings: scan.warnings,
      baselineAt, baselineUsedPercent, checkedAt: new Date(sample.checkedAt).toISOString(),
      quotaUsedPercent, minimumQuotaPercent: MIN_CALIBRATION_PERCENT, pricedApiCostUsd, unpricedEvents,
      usdPerPercentagePoint, weeklyApiValueUsd: usdPerPercentagePoint === null ? null : usdPerPercentagePoint * 100,
      reason, models,
    };
    this.db.query("INSERT INTO value_samples VALUES (?, ?)").run(sample.id, JSON.stringify(calibration));
    if (reset) {
      // Freeze at detection. Never apply a future calibration to an old reset.
      const usable = prior?.usdPerPercentagePoint !== null && prior?.usdPerPercentagePoint !== undefined && gap <= 360_000 &&
        scan.complete && prior.source === scan.source && lastGlobal?.id === previous?.id;
      const value: ResetValue = {
        estimatedUnusedUsd: usable ? reset.estimatedUnusedPercent * prior!.usdPerPercentagePoint! : null,
        reason: usable ? "estimated" : gap > 360_000 ? "sampling-gap" : prior?.reason === "ready" ? "incomplete-coverage" : prior?.reason || "no-calibration",
        calibration: prior,
      };
      this.db.query("INSERT INTO reset_values VALUES (?, ?)").run(reset.id, JSON.stringify(value));
    }
    return calibration;
  }

  resetValue(id: number): ResetValue {
    const row = this.db.query<{ value: string }, [number]>("SELECT value FROM reset_values WHERE resetId = ?").get(id);
    return row ? JSON.parse(row.value) : { estimatedUnusedUsd: null, reason: "no-calibration", calibration: null };
  }

  summary(accountId: string, plan: string, bucket: string, resetCount: number): ValueSummary {
    const totals = this.db.query<{ sum: number | null; count: number }, [string, string, string]>(`
      SELECT SUM(json_extract(v.value, '$.estimatedUnusedUsd')) AS sum,
        COUNT(json_extract(v.value, '$.estimatedUnusedUsd')) AS count
      FROM reset_values v JOIN resets r ON r.id = v.resetId
      JOIN observations o ON o.id = r.currentObservationId
      WHERE o.accountId = ? AND o.plan = ? AND o.bucket = ?
    `).get(accountId, plan, bucket)!;
    const last = this.db.query<{ id: number }, [string, string, string]>(
      "SELECT id FROM observations WHERE accountId = ? AND plan = ? AND bucket = ? ORDER BY id DESC LIMIT 1",
    ).get(accountId, plan, bucket);
    return { estimatedUnusedUsd: totals.sum, valuedResetCount: totals.count, unvaluedResetCount: resetCount - totals.count,
      currentCalibration: last ? this.calibration(last.id) : null };
  }

  tokens(): TokenSummary {
    const started = this.db.query<{ startedAt: number }, []>("SELECT startedAt FROM token_tracking WHERE id = 1").get();
    const models = this.models(null, 0, Number.MAX_SAFE_INTEGER);
    return { coverage: "local-native-sessions", recordingStartedAt: started ? new Date(started.startedAt).toISOString() : null,
      pricedApiCostUsd: models.reduce((sum, m) => sum + m.pricedApiCostUsd, 0),
      unpricedEvents: models.reduce((sum, m) => sum + m.unpricedEvents, 0), models };
  }

  private models(source: string | null, since: number, until: number): ModelUsage[] {
    return this.db.query<ModelUsage, [string | null, string | null, number, number]>(`
      SELECT model, COUNT(*) AS events, SUM(inputTokens) AS inputTokens, SUM(cachedInputTokens) AS cachedInputTokens,
        SUM(cacheWriteTokens) AS cacheWriteTokens, SUM(outputTokens) AS outputTokens,
        COALESCE(SUM(cost), 0) AS pricedApiCostUsd, SUM(CASE WHEN cost IS NULL THEN 1 ELSE 0 END) AS unpricedEvents
      FROM token_events WHERE (? IS NULL OR source = ?) AND timestamp > ? AND timestamp <= ?
      GROUP BY model ORDER BY pricedApiCostUsd DESC, model
    `).all(source, source, since, until);
  }
}

import type { SourceStatus } from "./sources";
import type { Database } from "bun:sqlite";
import { apiCost, type PriceBook } from "./pricing";
import type { TokenScan, TokenUsage } from "./tokens";
import type { Observation, Reset } from "./store";

export const MIN_CALIBRATION_PERCENT = 5;
export type ModelUsage = TokenUsage & { model: string; events: number; pricedApiCostUsd: number; unpricedEvents: number };
export type Calibration = {
  basis: "standard-api-token-prices";
  coverage: "local-native-sessions";
  sourceScope?: "local-only" | "configured-machines"; sources?: SourceStatus[];
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
  localOnlyValuedResetCount: number;
  currentCalibration: Calibration | null;
};
export type ResetValue = { estimatedUnusedUsd: number | null; reason: string; calibration: Calibration | null };
export type TokenSummary = {
  sourceScope: "local-only" | "configured-machines"; sources: SourceStatus[];
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
    const columns = db.query<{ name: string }, []>("PRAGMA table_info(token_events)").all();
    if (!columns.some(c => c.name === "updatedAt")) {
      db.transaction(() => {
        // A concurrent poll/widget may have migrated while we waited for the lock.
        const current = db.query<{ name: string }, []>("PRAGMA table_info(token_events)").all();
        if (!current.some(c => c.name === "updatedAt")) db.exec("ALTER TABLE token_events ADD COLUMN updatedAt INTEGER NOT NULL DEFAULT 0");
      }).immediate();
    }
  }

  start(at: number): number {
    this.db.query("INSERT OR IGNORE INTO token_tracking VALUES (1, ?)").run(at);
    return this.db.query<{ startedAt: number }, []>("SELECT startedAt FROM token_tracking WHERE id = 1").get()!.startedAt;
  }

  calibration(observationId: number): Calibration | null {
    const row = this.db.query<{ calibration: string }, [number]>("SELECT calibration FROM value_samples WHERE observationId = ?").get(observationId);
    return row ? this.withCoverage(JSON.parse(row.calibration)) : null;
  }

  record(sample: Observation, previous: Observation | null, scan: TokenScan, book: PriceBook, reset: Reset | null): Calibration {
    const insert = this.db.query(`INSERT INTO token_events (source, eventKey, timestamp, model, inputTokens, cachedInputTokens, cacheWriteTokens, outputTokens, cost, pricingVersion, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source, eventKey) DO UPDATE SET model=excluded.model, cost=excluded.cost, pricingVersion=excluded.pricingVersion, updatedAt=excluded.updatedAt`);
    for (const event of scan.events) insert.run(scan.source, event.key, event.timestamp, event.model,
      event.inputTokens, event.cachedInputTokens, event.cacheWriteTokens, event.outputTokens, apiCost(event.model, event, book), book.version, sample.checkedAt);

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
      sourceScope: scan.sourceScope || "local-only", sources: scan.sources || [],
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
    if (!row) return { estimatedUnusedUsd: null, reason: "no-calibration", calibration: null };
    const value: ResetValue = JSON.parse(row.value);
    return { ...value, calibration: value.calibration ? this.withCoverage(value.calibration) : null };
  }

  summary(accountId: string, plan: string, bucket: string, resetCount: number): ValueSummary {
    const totals = this.db.query<{ sum: number | null; count: number; localOnly: number }, [string, string, string]>(`
      SELECT SUM(json_extract(v.value, '$.estimatedUnusedUsd')) AS sum,
        COUNT(json_extract(v.value, '$.estimatedUnusedUsd')) AS count,
        COALESCE(SUM(CASE WHEN json_extract(v.value, '$.estimatedUnusedUsd') IS NOT NULL
          AND COALESCE(json_extract(v.value, '$.calibration.sourceScope'), 'local-only') = 'local-only' THEN 1 ELSE 0 END), 0) AS localOnly
      FROM reset_values v JOIN resets r ON r.id = v.resetId
      JOIN observations o ON o.id = r.currentObservationId
      WHERE o.accountId = ? AND o.plan = ? AND o.bucket = ?
    `).get(accountId, plan, bucket)!;
    const last = this.db.query<{ id: number }, [string, string, string]>(
      "SELECT id FROM observations WHERE accountId = ? AND plan = ? AND bucket = ? ORDER BY id DESC LIMIT 1",
    ).get(accountId, plan, bucket);
    return { localOnlyValuedResetCount: totals.localOnly, estimatedUnusedUsd: totals.sum, valuedResetCount: totals.count, unvaluedResetCount: resetCount - totals.count,
      currentCalibration: last ? this.calibration(last.id) : null };
  }

  tokens(): TokenSummary {
    const started = this.db.query<{ startedAt: number }, []>("SELECT startedAt FROM token_tracking WHERE id = 1").get();
    const last = this.db.query<{ calibration: string }, []>("SELECT calibration FROM value_samples ORDER BY observationId DESC LIMIT 1").get();
    const calibration = last ? this.withCoverage(JSON.parse(last.calibration)) : null;
    const models = this.models(null, 0, Number.MAX_SAFE_INTEGER);
    return { sourceScope: calibration?.sourceScope || "local-only", sources: calibration?.sources || [],
      coverage: "local-native-sessions", recordingStartedAt: started ? new Date(started.startedAt).toISOString() : null,
      pricedApiCostUsd: models.reduce((sum, m) => sum + m.pricedApiCostUsd, 0),
      unpricedEvents: models.reduce((sum, m) => sum + m.unpricedEvents, 0), models };
  }

  private withCoverage(calibration: Calibration): Calibration {
    return { ...calibration, sourceScope: calibration.sourceScope || "local-only", sources: calibration.sources || [] };
  }

  private models(source: string | null, since: number, until: number): ModelUsage[] {
    return this.db.query<ModelUsage, [string | null, string | null, number, number]>(`
      WITH selected AS (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY eventKey ORDER BY updatedAt DESC, rowid DESC) AS rank
        FROM token_events WHERE (? IS NULL OR source = ?) AND timestamp > ? AND timestamp <= ?
      )
      SELECT model, COUNT(*) AS events, SUM(inputTokens) AS inputTokens, SUM(cachedInputTokens) AS cachedInputTokens,
        SUM(cacheWriteTokens) AS cacheWriteTokens, SUM(outputTokens) AS outputTokens,
        COALESCE(SUM(cost), 0) AS pricedApiCostUsd, SUM(CASE WHEN cost IS NULL THEN 1 ELSE 0 END) AS unpricedEvents
      FROM selected WHERE rank = 1
      GROUP BY model ORDER BY pricedApiCostUsd DESC, model
    `).all(source, source, since, until);
  }
}

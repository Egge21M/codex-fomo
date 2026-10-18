# CLI and JSON reference


Use `--json` from a plugin host or app backend. Invoke the entry point directly to avoid package-runner command echoes:

```sh
bun /absolute/path/to/codex-fomo/index.ts status --json
bun /absolute/path/to/codex-fomo/index.ts poll --json
bun /absolute/path/to/codex-fomo/index.ts history --json --limit 100
bun /absolute/path/to/codex-fomo/index.ts summary --json
```

JSON mode writes exactly one compact JSON object plus a newline to stdout, including on handled errors. Diagnostics, if enabled, stay on stderr. Exit code `0` means success; `1` means failure. Missing observations and empty history are successful empty states. `--help --json` also returns a JSON response.

Every response includes `schemaVersion: 1`, `ok`, `command`, and `generatedAt` (UTC ISO 8601). Successful responses contain `data`; errors contain `error`. Version 1 replaces the original unversioned raw JSON output. Consumers should check the version and tolerate additive fields. Breaking changes require a new schema version.

| Command | `data` |
| --- | --- |
| `status` | `{ bucket, observation }`, where `observation` is `null` before the first successful poll |
| `poll` | `{ bucket, observation, reset, baseline, usageDropped, calibration }`, where `reset` is `null` when no reset was detected |
| `history` | `{ bucket, limit, resets }`, with newest resets first and an empty array when none exist |
| `summary` | `{ bucket, recordingStartedAt, observation, groups }`, aggregating every recorded reset without a history limit |
| `tokens` | `{ coverage, recordingStartedAt, pricedApiCostUsd, unpricedEvents, models }`; local records since token collection began |
| `version` (`--version`) | `{ version }`; reads no database or credentials |
| `export-tokens` | `{ protocolVersion, since, until, exportedAt, scan }`; metadata only, no database access |
| `help` | `{ usage }` |

Both `status` and `poll` return the same observation fields:

- `id`, `accountId`, `bucket`, `plan`, `windowDurationMins` (10080).
- `usedPercent` and `remainingPercent` (0–100 percentage points, not fractions; over-limit usage can exceed 100).
- `checkedAt` and `resetsAt` as UTC ISO 8601 strings.
- `sampleAgeSeconds`, `secondsUntilReset`, and `stale` (sample older than six minutes), calculated at `generatedAt`. Countdown values are nonnegative integers; zero means the reported deadline has passed, not that a reset has been confirmed. Percentages come from the last saved sample, even when stale.

Reset fields are `id`, `previousObservationId`, `currentObservationId`, `detectedAt`, `oldResetAt`, `newResetAt`, `previousUsedPercent`, `estimatedUnusedPercent`, `sampleGapSeconds`, `missedPolls`, and `reason` (`early` or `scheduled`). All three reset timestamps are UTC ISO strings. `estimatedUnusedPercent` remains an estimate, as explained below.

Example before collection begins:

```json
{"schemaVersion":1,"ok":true,"command":"status","generatedAt":"2026-10-15T10:00:00.000Z","data":{"bucket":"codex","observation":null}}
```

Example failure (exit code 1):

```json
{"schemaVersion":1,"ok":false,"command":"poll","generatedAt":"2026-10-15T10:00:00.000Z","error":{"code":"CODEX_ERROR","message":"Codex usage read timed out. Check your network and Codex login."}}
```

Error codes are `CONFIG_ERROR`, `INVALID_ARGUMENTS`, `DATABASE_ERROR`, `CODEX_ERROR`, and `INTERNAL_ERROR`. Match the code, not the human-readable message. `command` may be `null` if argument parsing failed before the command could be determined.

For a widget, read `status --json` and let the timer handle collection. Read `data.observation.remainingPercent`, `data.observation.secondsUntilReset`, and `data.observation.stale` after checking `ok` and that `observation` is not null. Use `poll --json` only when you want a fresh network read and a stored observation.

TypeScript response types are exported from [`src/output.ts`](../src/output.ts), including the discriminated union `CliResponse`. JSON dates deliberately use ISO strings throughout, independent of the database's internal timestamp units.

`summary.groups` contains one entry per account and plan in the selected bucket, ordered by latest check. Each has `accountId`, `plan`, `recordingStartedAt`, `lastCheckedAt`, `observationCount`, `resetCount`, `estimatedUnusedWeeklyAllowances`, `averageUnusedPercent` (null before the first reset), and `samplingGapCount`. The total is `SUM(estimatedUnusedPercent) / 100`: 37% and 25% unused become 0.62 weekly allowances. It counts observed reset events, not elapsed calendar weeks; the still-open window is not included. Sampling gaps are intervals greater than six minutes between consecutive observations for the same account, bucket, and unchanged plan, including gaps where no reset was detected.

The top-level recording start is the earliest retained sample in the bucket; each group's date is its own earliest sample. Clearing the database starts a new recording period. Summary reads are consistent snapshots and do not make Codex requests.

## Settings

| Environment variable | Default / purpose |
| --- | --- |
| `CODEX_USAGE_DB` | Override the SQLite file path |
| `CODEX_USAGE_BUCKET` | `codex`; choose another metered quota bucket |
| `CODEX_BIN` | `codex` on PATH; executable path/name |
| `CODEX_USAGE_DEBUG` | `1` prints app-server diagnostics to stderr |
| `XDG_STATE_HOME` | Absolute state-directory override |
| `CODEX_HOME` | Honored by Codex for its existing authentication/configuration |
| `CODEX_USAGE_CONFIG` | Source config override; see [SSH sources](sources.md) |
| `CODEX_USAGE_PRICES` | Pricing JSON override; see [API value](api-value.md) |
| `XDG_CONFIG_HOME` | Absolute config-directory override for pricing and systemd units |

The timer installer preserves the selected database, bucket, Codex home, and state-directory settings. It does not copy API keys into the unit file.

## Storage

`observations` stores account, bucket, plan, usage, reset time, check time, and the weekly duration. `resets` links the before/after observations and stores the estimate and classification. Check timestamps use Unix milliseconds; reset timestamps use Unix seconds, matching Codex. There are no runtime dependencies beyond Bun's built-in SQLite module.

For multi-machine coverage, see [SSH sources](sources.md). Calibration and token
responses add `sourceScope` and per-source `sources` status; reset summaries add
`localOnlyValuedResetCount`. Historical reset values remain frozen.

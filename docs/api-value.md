# Estimated API value

Every `poll` also reads native Codex JSONL files from `$CODEX_HOME/sessions` and
`$CODEX_HOME/archived_sessions` (default `~/.codex`). The parsing approach is based
on Omarchy's installed `omarchy-agent-usage-codex` collector. This implementation
prefers newer `token_usage_record` records, deduplicates by response ID, and looks
up models by turn ID across files so subagents use their own models. For older
logs, it reads `token_count.info.last_token_usage`, skips unchanged cumulative
snapshots, and deduplicates by turn/counter. Detailed records replace legacy
records for the same turn. Forked/copied response histories and repeated scans
are not counted again. Native free `codex-auto-review` checks and explicitly
non-OpenAI providers are excluded.

Only timestamps, model names, identifiers, token counts, and pricing metadata
are retained; prompt/response text is never stored. Files are streamed on each
poll without Omarchy's 30-day cutoff. Existing quota history is preserved, but
token collection starts at the first poll after this feature is installed.
Older quota samples and resets are not retroactively assigned dollar values.

Input counts exclude cached reads and cache writes, which have separate rates.
Reasoning tokens are already included in output tokens. Built-in USD prices are
standard API token prices verified on 2026-10-15 from the
[OpenAI pricing page](https://developers.openai.com/api/docs/pricing),
[GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol),
[GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra), and
[GPT-6 Sol](https://developers.openai.com/api/docs/models/gpt-6-sol).
They cover GPT-6 Astra, GPT-6.1 Sol, GPT-6 Sol, GPT-6 Luna, GPT-5.6 Sol, and
GPT-5.3 Codex. Where applicable, requests above 272K input tokens use the published
long-context multipliers. Unknown model IDs stay **unpriced**, never silently
free. GPT-5.3 Codex cache writes also remain unpriced because a rate wasn't
established. Prices can change; this is a dated reference, not a live price feed.

Calibration compares token cost with quota consumption between the same two
observations in one continuous reset window:

```text
USD per percentage point = API-equivalent token cost / quota percentage increase
weekly API equivalent = USD per percentage point × 100
estimated unused USD at reset = USD per percentage point × last unused percentage
```

At least **five percentage points** of consumption are required to reduce the
noise from rounded percentages. Tokens from intermediate polls where the displayed
percentage stays unchanged are included. Calibration restarts after a reset,
account/plan/bucket switch, a usage decrease, a polling gap over six minutes, an
incomplete scan, a changed log directory, or changed prices. Missing model prices
block calibration for the affected interval. `poll --json` includes the latest
`calibration`; `summary.groups[].value.currentCalibration` exposes it offline.

At a reset, the previous sample's calibration is frozen along with the estimated
unused value. A reset after a polling gap or without a usable calibration stays
unvalued. `history.resets[].value` contains `estimatedUnusedUsd`, `reason`, and
`calibration`. `summary.groups[].value` contains:

- `estimatedUnusedUsd`: sum of **valued** resets, or `null` if none can be valued.
- `valuedResetCount` and `unvaluedResetCount`: coverage of that sum. A partial sum
  is not a total for all recording history.
- `currentCalibration`: the latest calibration with its time bounds, quota delta,
  model totals, pricing version, warnings, and `weeklyApiValueUsd` (or `null`).

`tokens --json` reports local totals since token collection began, across accounts
and directories; it is not an account billing report. `pricedApiCostUsd` always
means the priced subset; inspect `unpricedEvents`. Polls refresh prices for retained
records still present in the logs. Frozen reset values are never repriced.
All JSON additions retain `schemaVersion: 1`.

**Interpretation:** these are local, workload-specific estimates at standard API
prices, not subscription fees lost or an official allowance-to-USD conversion.
They exclude tool charges, regional premiums, and Fast/Ultrafast price premiums.
Logs don't reliably identify subscription versus API-key billing or the account
that paid for each request. Calibration assumes the captured native sessions use
the polled subscription. Other devices, cloud/Work tasks without local logs, pi,
OpenCode, deleted logs, and API-key traffic can bias it. A successful scan confirms
readability, not complete account coverage. Changes in the mix of models or speed
modes can change the inferred rate; usage during the reset polling interval is
also unknown. The panel labels the result as an estimate and shows valued versus
unvalued reset counts.

### Override model prices

Optional `~/.config/codex-usage/prices.json` (respects an absolute `XDG_CONFIG_HOME`)
or `CODEX_USAGE_PRICES=/absolute/path/prices.json` merges model-specific overrides
with the defaults. Rates are USD per million tokens. Each entry replaces the
entire rate definition for that model:

```json
{
  "gpt-6.1-sol": {
    "input": 2,
    "cachedInput": 0.1,
    "cacheWrite": 2.5,
    "output": 10,
    "longContextThreshold": 272000,
    "longContextInputMultiplier": 2,
    "longContextOutputMultiplier": 1.5
  }
}
```

No network access is needed for pricing. Invalid configuration fails the poll
with `CONFIG_ERROR`; it does not save a misleading sample. When using a custom
path under systemd, set it while running `bun run install:timer` so the service
inherits it. The default config file is read on every poll without reinstalling.

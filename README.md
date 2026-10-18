# codex-fomo

Track how much of your weekly Codex allowance expires unused. A small Bun CLI
records usage in SQLite, detects reset-window changes, and estimates unused API
value from local token logs. An optional Omarchy bar plugin shows the totals.

- Five-minute collection with a systemd user timer.
- Scheduled and unexpected reset detection with timestamp-jitter tolerance.
- Offline status, history, summaries, and tokens by model.
- Versioned JSON output for plugins and frontend apps.
- Local and SSH token sources for work across machines.
- Local storage; no API key or additional runtime packages required.

## Quick start

Requires Linux, **Bun 1.4.3+**, and the Codex CLI signed in with ChatGPT.
Tested with Codex CLI 0.162.1. systemd and Omarchy are optional integrations.

Download and extract a [release](https://github.com/Egge21M/codex-fomo/releases), or clone
this repository, then run from its folder:

```sh
bun index.ts --version
bun run poll                  # Save the first weekly observation
bun run status                # Read the latest saved usage
bun run install:timer         # Collect every five minutes (systemd)
bun run install:plugin        # Add the Omarchy bar widget (optional)
```

Keep the folder in a permanent location. The installers record absolute paths.
See [installation, upgrades, and uninstall](docs/installation.md).

## Commands

| Command | Purpose |
| --- | --- |
| `bun run poll` | Fetch quota and collect local token records |
| `bun run status` | Latest weekly usage and next reset |
| `bun run history` | Last 20 inferred resets (`--limit N` to change) |
| `bun run summary` | Recorded unused allowance and estimated USD |
| `bun run tokens` | Local tokens and API-equivalent cost by model |
| `bun index.ts --help` | CLI options |

All data commands accept `--json`. Only `poll` makes a Codex request; it never
starts a model turn. For integrations, invoke the entry point directly:

```sh
bun /path/to/codex-fomo/index.ts summary --json
```

The first poll establishes a baseline. Reset history stays empty until an
observed reset; dollar estimates need at least five percentage points of
continuous observed consumption. Missing values are distinct from zero.

## What the estimates mean

Unused allowance is inferred from the last sample before a reset. Activity
between polls is unknown, and downtime can hide resets. Dollar values are
workload-specific estimates at standard API token prices, **not subscription
fees lost or an official OpenAI conversion**. Configure SSH sources for remote work; unconfigured machines
and cloud usage may still be missing. Built-in prices are dated reference values and can be overridden.

## Documentation

- [Local and SSH source configuration](docs/sources.md)
- [CLI, JSON contract, and settings](docs/cli.md)
- [Reset detection and sampling limits](docs/detection.md)
- [API-value calibration, coverage, and model prices](docs/api-value.md)
- [Omarchy plugin](docs/omarchy.md)
- [Contributing and development](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md) and [release process](docs/releasing.md)

The existing `codex-usage` data/config paths, systemd unit names,
`CODEX_USAGE_*` environment variables, and `egge.codex-usage` plugin ID are retained
for compatibility with early installations.

## Data and privacy

The database defaults to `~/.local/state/codex-usage/usage.sqlite`. It stores
account IDs, quota observations, inferred resets, token metadata, and estimates.
Prompts, responses, and authentication tokens are not stored. `poll` reads configured native
Codex session logs (remote metadata is pulled over SSH) and uses your existing Codex login through `codex app-server`.
No telemetry is added. Treat database files and diagnostic output as private.

The token parser was informed by Omarchy's `omarchy-agent-usage-codex` collector,
with response deduplication and per-turn model attribution added here. This is an
independent project, unaffiliated with OpenAI or Omarchy.

## License

[MIT](LICENSE).

# Omarchy plugin

```sh
bun run install:plugin
```

The installer validates and copies [`omarchy/`](../omarchy/) into `~/.config/omarchy/plugins/egge.codex-usage/`, generates local runtime paths, and enables the widget in the right bar section. Existing plugin files and `shell.json` are backed up under `~/.config/omarchy/plugin-backups/`. Omarchy must be running. Re-run the installer after editing the plugin source or moving the project; it preserves selected `CODEX_USAGE_DB`, `CODEX_USAGE_BUCKET`, and `XDG_STATE_HOME` settings.

The bar shows estimated wasted API value in USD, such as `$12.34`. `$—` means no
estimate is available; `$0.00` means a measured zero. An asterisk marks a partial
total when some recorded resets have no dollar estimate. Hover for the status.

Click to open a compact report: wasted value, recording period, reset count,
current weekly usage, and the next reset. **View details** opens a second page
with allowance totals, plan, sampling gaps, valuation coverage, calibration, source health,
exact timestamps, and the estimation caveats. **Back to report** returns to the
summary. Every fresh opening starts on the report.

Use Right/Left to open details/return, Enter to activate the selected button,
and Up/Down to select Back or Refresh on the details page. Escape returns from
details, then closes the report. Middle-click or R refreshes the local summary;
the details page also has a Refresh button.

The plugin reads `summary --json` on startup, every 60 seconds, and on opening.
The five-minute systemd timer handles network polling. The local read interval
is configurable from 10 to 300 seconds. The latest account and plan are shown;
other histories remain separate in `summary --json`. Stale data and errors stay
visible on both pages. Dollar amounts are local API-equivalent estimates.

```sh
omarchy plugin disable egge.codex-usage
omarchy plugin enable egge.codex-usage --section right
omarchy-shell egge.codex-usage status    # Inspect widget state
```

Disabling the widget does not stop the collector timer.

If an upgrade still displays old UI code after reinstalling, run `omarchy restart shell`.
The plugin ID `egge.codex-usage` is a stable namespace and works for any username.

Incomplete token sources pause USD calibration and show a warning on both pages.
The details page lists each configured source and its scan status, plus a count
of historical valued resets that had local-only coverage.

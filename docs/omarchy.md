# Omarchy plugin

```sh
bun run install:plugin
```

The installer validates and copies [`omarchy/`](../omarchy/) into `~/.config/omarchy/plugins/egge.codex-usage/`, generates local runtime paths, and enables the widget in the right bar section. Existing plugin files and `shell.json` are backed up under `~/.config/omarchy/plugin-backups/`. Omarchy must be running. Re-run the installer after editing the plugin source or moving the project; it preserves selected `CODEX_USAGE_DB`, `CODEX_USAGE_BUCKET`, and `XDG_STATE_HOME` settings.

The bar shows a compact pie-chart icon. Hover for estimated unused allowance (or "Awaiting first recorded reset"), and click to open the details panel. Middle-click, the panel's refresh button, or the R key refreshes the local summary. Escape closes the panel. The plugin reads `summary --json` on startup, every 60 seconds, and on opening the panel; the five-minute systemd timer remains responsible for network polling. Its settings allow changing the local read interval from 10 to 300 seconds.

The panel shows estimated unused allowance, estimated unused API value, calibration progress, recording date, reset count, average unused percentage, sampling gaps, and current weekly usage/reset timing. It displays the account and plan of the latest saved observation. Other account/plan histories stay separate and remain accessible through `summary --json`. Stale samples and CLI errors are visibly marked; no data is distinct from zero unused allowance.

```sh
omarchy plugin disable egge.codex-usage
omarchy plugin enable egge.codex-usage --section right
omarchy-shell egge.codex-usage status    # Inspect widget state
```

Disabling the widget does not stop the collector timer.

If an upgrade still displays old UI code after reinstalling, run `omarchy restart shell`.
The plugin ID `egge.codex-usage` is a stable namespace and works for any username.

# Changelog

## 0.2.0

- Collect token metadata from configured SSH machines, deduplicate across sources,
  and pause USD calibration when a source is incomplete.
- Preserve and label historical local-only estimates; expose source health in JSON
  and the Omarchy panel.
- Show wasted USD in the bar, with a compact report and a separate details page.
- Add a bundled remote exporter and document SSH setup, authentication, and recovery.
- Preserve SSH agent/config settings in the five-minute timer installer.

Upgrade: reinstall the Omarchy plugin and timer to apply their updates. Remote
collection is opt-in; configure sources and install the exporter as described in
`docs/sources.md`. Existing reset values stay frozen. Adding sources starts a new
calibration; historical resets are not retroactively valued.

## 0.1.0

Initial release.

- Track weekly Codex quota through the local app-server and persist samples in SQLite.
- Infer scheduled and early resets, tolerating small reset-timestamp changes.
- Report unused allowance by account and plan, including sampling gaps.
- Collect local tokens by model with response deduplication and cache-aware pricing.
- Estimate unused API value using observed quota consumption and local token costs.
- Provide versioned JSON output, offline reports, and a version command.
- Install an optional five-minute systemd timer and Omarchy bar plugin.

Limitations: resets and USD values are inferred; local logs do not guarantee full
account coverage. The app-server protocol is experimental. Linux is the tested
platform, and reference prices are verified as of 2026-10-15.

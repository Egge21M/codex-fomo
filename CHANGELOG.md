# Changelog

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

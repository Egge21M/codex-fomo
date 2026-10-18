# Project guidance

Use Bun and its built-in SQLite module. Keep runtime dependencies empty.
Run `bun run verify` after behavior changes. Tests use temporary databases and a
fake app-server; keep them isolated from real Codex sessions and credentials.

The public JSON contract lives in `src/output.ts`. Additive fields preserve its
schema version; breaking changes require a new version and updated consumers.
Missing observations, missing prices, and unknown values must remain distinct
from zero usage or zero cost.

For reset logic, read `docs/detection.md`. For token accounting or prices, read
`docs/api-value.md`. Preserve historical observations and frozen reset values
when changing storage. Tests must cover the relevant accounting boundaries.

For packaging changes, read `docs/releasing.md`. For plugin work, edit `omarchy/`
in this repository; the installer generates machine-specific runtime paths.
Installation changes the user's desktop or timer, so test with isolated fixtures
unless the user requested installation.

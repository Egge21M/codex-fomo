# Contributing

Use the Bun version in `.bun-version` on Linux:

```sh
bun install --frozen-lockfile
bun run verify
bun run release:pack
```

Tests use temporary databases, synthetic session logs, and a fake app-server.
They require subprocess pipes but no network access, Codex login, systemd, or
Omarchy. Avoid sharing real session logs or databases in issues or fixtures.

## Layout

- `index.ts`: command parsing and human output.
- `src/codex.ts`, `quota.ts`: app-server transport and weekly-window selection.
- `src/store.ts`, `value.ts`: persistence, reset history, and USD calibration.
- `src/tokens.ts`, `pricing.ts`: local token parsing and reference prices.
- `src/output.ts`: versioned JSON contract consumed by frontends.
- `omarchy/`: optional plugin; `Runtime.js` is configured by its installer.
- `scripts/`: installation and release packaging.

Keep runtime dependencies empty. Add regression tests for changes to detection,
accounting, persistence, or the public JSON contract. Keep money estimates and
unknown coverage explicit. Price updates should include a dated primary source.

For Omarchy UI changes, validate the source with `omarchy plugin validate omarchy`
and inspect the installed panel on an Omarchy desktop. The automated tests cover
its model logic, not QML rendering. Installation changes desktop configuration.

Before opening a PR, describe the behavior change, its tests, and any migration
or compatibility impact. See [the release process](docs/releasing.md) for builds.

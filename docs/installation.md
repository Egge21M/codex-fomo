# Installation and maintenance

Use Linux with Bun 1.4.3 or newer and a Codex CLI signed in with ChatGPT.
The tested Codex CLI version is 0.162.1. systemd is optional; Omarchy is only
needed for the desktop plugin. Other operating systems have not been verified.
The app-server protocol is experimental and may change between Codex versions.

## Install from a release

Download `codex-fomo-VERSION.tar.gz` and its `.sha256` file from the repository's
GitHub Releases page. In the download directory (replace VERSION with the release):

```sh
sha256sum --check codex-fomo-VERSION.tar.gz.sha256
mkdir -p ~/projects
tar -xzf codex-fomo-VERSION.tar.gz -C ~/projects
cd ~/projects/codex-fomo-VERSION
bun index.ts --version
bun index.ts poll
```

This is a source distribution: Bun runs the TypeScript directly. No runtime
packages or `bun install` are required. Keep the extracted folder in a permanent
location because the timer and plugin record its absolute path. Developers can
instead clone the repository and run `bun install --frozen-lockfile`.

## Five-minute collection

```sh
bun run install:timer
systemctl --user list-timers codex-usage.timer
journalctl --user -u codex-usage.service -n 20
```

The installer resolves the current Bun/Codex executable paths, writes `codex-usage.service` and `codex-usage.timer` to `~/.config/systemd/user` (respecting XDG_CONFIG_HOME), enables the timer, and collects an initial sample. Changed existing units are backed up. Re-run the installer if you move the project or change executable paths/settings.

Collection runs at minutes 00, 05, 10, etc., while the systemd user manager is running. It does not wake a sleeping machine. `Persistent=true` requests one catch-up poll after a missed timer activation; it cannot reconstruct usage during downtime. No system service or lingering setting is changed.

To stop automatic collection:

```sh
systemctl --user disable --now codex-usage.timer
```

## Upgrade

1. Stop the timer and any in-progress collection:
   `systemctl --user stop codex-usage.timer codex-usage.service`.
2. Back up your database. With the collector stopped, copy the state directory
   (including any SQLite WAL/SHM files) to a private backup location. The default
   is `~/.local/state/codex-usage/`; honor `CODEX_USAGE_DB` if customized.
3. Extract the new release into a permanent folder, or update your clone. Run
   `bun install --frozen-lockfile` only if you need development dependencies.
4. From that folder, rerun `bun run install:timer` and, if used,
   `bun run install:plugin`, with the same environment overrides as before.
5. Check `bun run status` and the service journal. Remove the old program folder
   only after both integrations point at the new one.

Data is stored outside the program folder and is preserved on upgrade. Database
schema changes are applied when opening it. Keep the backup if you might need to
roll back; older releases are not guaranteed to understand newer schemas.

## Uninstall

Disable the widget first if installed:

```sh
omarchy plugin disable egge.codex-usage
```

Then stop collection and remove the units from the config directory used during
installation (normally `~/.config`):

```sh
systemctl --user disable --now codex-usage.timer
systemctl --user stop codex-usage.service
rm -- ~/.config/systemd/user/codex-usage.timer ~/.config/systemd/user/codex-usage.service
systemctl --user daemon-reload
```

You can now remove the program folder and `~/.config/omarchy/plugins/egge.codex-usage/`.
Retained usage data and plugin backups are left in place. Remove the state
directory separately only if you intend to erase recording history.

## Troubleshooting

- **No observations:** run `bun run poll`; check `codex login` and `CODEX_BIN`.
- **Stale data:** inspect `systemctl --user status codex-usage.timer` and
  `journalctl --user -u codex-usage.service -n 20`. Sleeping machines do not poll.
- **No dollar estimate:** inspect `bun run summary --json`; the calibration reason
  explains insufficient usage, gaps, incomplete logs, or missing prices.
- **Plugin errors after moving the folder:** rerun `bun run install:plugin`.
- **Protocol errors:** include `codex --version`, `bun --version`, and the error
  code in a bug report. Review/redact debug logs before sharing them.

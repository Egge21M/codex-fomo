# Local and SSH token sources

Quota is account-wide. To estimate its API value, configure every machine where
you use the same Codex subscription. Each machine scans its own native logs;
only token metadata travels to the central collector over SSH. The central
collector alone polls quota, stores history, and calculates dollar estimates.

## Configure machines

Create `~/.config/codex-usage/config.json` (or use an absolute `XDG_CONFIG_HOME`):

```json
{
  "sources": [
    { "id": "laptop", "type": "local" },
    { "id": "vps", "type": "ssh", "host": "hermes" }
  ]
}
```

`CODEX_USAGE_CONFIG=/absolute/path/config.json` overrides this path. With no
configuration file, the collector scans the local machine only. Sources replace
the default list; include a local entry if you also work locally. One to eight
sources are supported, each with a unique ID. Every configured source is required
for USD calibration; no unreachable source is silently skipped.

`host` is an alias from `~/.ssh/config`. Put hostname, user, port, key, jump-host,
and other connection settings there. For example:

```sshconfig
Host hermes
    HostName vps.example.com
    User egge
    IdentityFile ~/.ssh/id_ed25519
```

The config can also specify paths:

```json
{
  "sources": [
    { "id": "laptop", "type": "local", "codexHome": "~/.codex" },
    {
      "id": "vps",
      "type": "ssh",
      "host": "hermes",
      "collectorPath": "~/.local/share/codex-fomo/index.ts",
      "bunPath": "~/.bun/bin/bun",
      "codexHome": "~/.codex"
    }
  ]
}
```

These are the remote defaults. Remote paths must be absolute or start with `~/`,
which resolves on that machine. `bunPath` may also be `bun` if it is on the remote
noninteractive PATH. Local `codexHome` defaults to `CODEX_HOME` or `~/.codex`.
No passwords, keys, or shell commands belong in this JSON file.

## Install the remote exporter

The remote machine needs Linux, GNU `timeout`, and Bun. The bundled exporter was
also tested with Bun 1.3.14; development/release tooling requires Bun 1.4.3+.
From a checkout or extracted release on the central machine:

```sh
bun run build:exporter
ssh hermes 'umask 077; mkdir -p "$HOME/.local/share/codex-fomo"'
scp dist/exporter/index.ts hermes:.local/share/codex-fomo/index.ts
```

For a custom `collectorPath`, install the bundle there instead. The bundle is the
CLI with its source modules included; `export-tokens` returns before opening any
database, loading source/pricing configuration, or connecting to Codex. Remote
polling never recurses into other SSH sources. Rebuild and recopy after exporter
protocol or log-parser changes. No remote background service is installed.

First establish and verify SSH host trust interactively. The collector uses
`BatchMode=yes`, `StrictHostKeyChecking=yes`, an eight-second connection timeout,
and a 25-second total deadline. Agent forwarding and SSH-config port forwards are
disabled. Password or host-key prompts fail rather than hang. A remote scan is
bounded by `timeout 20s`; export output is capped at 64 MiB per source per poll.
Sources are queried concurrently. There is no automatic credential installation.

## Run under systemd

```sh
bun run poll
bun run summary --json
bun run install:timer
```

The timer installer preserves `CODEX_USAGE_CONFIG`, `XDG_CONFIG_HOME`, and the
current `SSH_AUTH_SOCK`, if set. Its total service timeout is 90 seconds. Install
it from an environment that can run noninteractive SSH to each alias. Reinstall
if the agent socket moves; a locked/missing key or unavailable agent pauses USD
calibration and appears as a source failure. The default config file is reread
on every poll, so editing sources does not itself require reinstalling the timer.

## Coverage and recovery

Sources report availability, record counts, and warnings in
`summary.groups[].value.currentCalibration.sources` and `tokens.sources`.
The plugin shows failures on its compact report and source-by-source details on
the second page. A successful read confirms readable configured logs, not full
account coverage. Logs cannot prove which subscription or API key paid for a
request. Use only sources for the polled account; unconfigured machines, cloud
sessions, and deleted logs can still bias estimates.

All sources use the same requested timestamp interval. Responses with mismatched
bounds, invalid counts, incompatible protocol, or clock skew over 60 seconds are
rejected. Keep clocks synchronized. Response IDs deduplicate copies across
machines; conflicting duplicates pause calibration. Legacy records use the
existing turn/counter fingerprint. Historical token reports deduplicate across
source-configuration changes as well.

A failed or incomplete source still permits saving quota observations and reset
percentages, but blocks USD calibration. After recovery, calibration starts at
the next complete sample and needs five percentage points of new consumption.
Adding/removing a source, changing paths, or changing pricing also starts a fresh
baseline. Available historical logs since token recording began are imported on
subsequent scans, but old reset valuations are never recomputed.

Existing estimates remain frozen with their original `sourceScope: "local-only"`.
`localOnlyValuedResetCount` identifies how many of a group's valued resets had
only local coverage. New calibrations with SSH use `sourceScope:
"configured-machines"`. The old `coverage: "local-native-sessions"` field is
retained for compatibility as the native-log format label; use `sourceScope`
and `sources` to determine machine coverage. The `tokens` report's source status
is the latest scan, while its totals include all retained records.

## Export protocol

```sh
bun index.ts export-tokens --since 1792000000000 --until 1792000300000 --json
```

`--since` and `--until` are required Unix milliseconds (exclusive/inclusive).
`--codex-home /path` overrides the log directory. This command always emits the
versioned JSON envelope with `command: "export-tokens"`; `data` contains
`protocolVersion: 1`, the time bounds, `exportedAt`, and `scan` (source path,
complete flag, warnings, and metadata events). Incomplete scans return success
with `scan.complete: false`; callers must inspect that flag. Prompts, responses,
and authentication data are never included.

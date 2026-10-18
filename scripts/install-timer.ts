import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

function quote(value: string) {
  if (/[\r\n\0]/.test(value)) throw new Error("Systemd settings cannot contain newlines or NUL bytes.");
  return '"' + value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%") + '"';
}

async function main() {
  const root = resolve(import.meta.dir, "..");
  const codex = Bun.which(process.env.CODEX_BIN || "codex");
  if (!codex) throw new Error("Codex is not on PATH. Install/sign in to Codex first, or set CODEX_BIN.");
  const configHome = process.env.XDG_CONFIG_HOME;
  const directory = join(configHome && isAbsolute(configHome) ? configHome : join(homedir(), ".config"), "systemd/user");
  const environment: Record<string, string> = {
    CODEX_BIN: codex,
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
  };
  for (const name of ["CODEX_HOME", "XDG_STATE_HOME", "CODEX_USAGE_DB", "CODEX_USAGE_BUCKET", "CODEX_USAGE_PRICES", "XDG_CONFIG_HOME"]) {
    if (process.env[name]) environment[name] = process.env[name]!;
  }
  for (const name of ["CODEX_HOME", "CODEX_USAGE_DB", "CODEX_USAGE_PRICES"]) {
    if (environment[name]) environment[name] = resolve(environment[name]);
  }
  const service = `[Unit]
Description=Collect Codex weekly usage

[Service]
Type=oneshot
ExecStart=${quote(process.execPath).replaceAll("$", "$$")} run ${quote(join(root, "index.ts")).replaceAll("$", "$$")} poll
${Object.entries(environment).map(([key, value]) => `Environment=${quote(`${key}=${value}`)}`).join("\n")}
TimeoutStartSec=45
UMask=0077
`;
  const timer = `[Unit]
Description=Check Codex weekly usage every five minutes

[Timer]
OnCalendar=*-*-* *:0/5:00
AccuracySec=1s
Persistent=true
Unit=codex-usage.service

[Install]
WantedBy=timers.target
`;
  mkdirSync(directory, { recursive: true });
  for (const [name, content] of [["codex-usage.service", service], ["codex-usage.timer", timer]] as const) {
    const path = join(directory, name);
    if (existsSync(path) && await Bun.file(path).text() !== content) {
      copyFileSync(path, `${path}.bak.${Date.now()}`);
    }
    await Bun.write(path, content);
  }
  for (const command of [
    ["systemd-analyze", "--user", "verify", join(directory, "codex-usage.service"), join(directory, "codex-usage.timer")],
    ["systemctl", "--user", "daemon-reload"],
    ["systemctl", "--user", "enable", "--now", "codex-usage.timer"],
    ["systemctl", "--user", "start", "codex-usage.service"],
  ]) {
    const proc = Bun.spawn(command, { stdout: "inherit", stderr: "inherit" });
    if (await proc.exited !== 0) throw new Error(`${command.join(" ")} failed. Unit files are in ${directory}.`);
  }
  console.log("Installed and enabled codex-usage.timer; collection runs every five minutes while your user manager is running.");
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

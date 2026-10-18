import { copyFileSync, cpSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

async function run(command: string[]) {
  const proc = Bun.spawn(command, { stdout: "inherit", stderr: "inherit" });
  if (await proc.exited !== 0) throw new Error(`${command.join(" ")} failed.`);
}

async function main() {
  const root = resolve(import.meta.dir, "..");
  const source = join(root, "omarchy");
  const config = join(homedir(), ".config/omarchy");
  const target = join(config, "plugins/egge.codex-usage");
  const backupRoot = join(config, "plugin-backups", `codex-usage-${Date.now()}`);
  await run(["omarchy", "plugin", "validate", source]);
  await run(["omarchy-shell", "shell", "ping"]);

  mkdirSync(backupRoot, { recursive: true });
  if (existsSync(join(config, "shell.json"))) copyFileSync(join(config, "shell.json"), join(backupRoot, "shell.json"));
  if (existsSync(target)) cpSync(target, join(backupRoot, "plugin"), { recursive: true });
  mkdirSync(target, { recursive: true });
  const command = [process.execPath, join(root, "index.ts"), "summary", "--json"];
  const settings: string[] = [];
  for (const name of ["XDG_STATE_HOME", "CODEX_USAGE_DB", "CODEX_USAGE_BUCKET"]) {
    const value = process.env[name];
    if (value) settings.push(`${name}=${name === "CODEX_USAGE_DB" ? resolve(value) : value}`);
  }
  if (settings.length) command.unshift("env", ...settings);
  // Install the runtime paths before the entry point so the initial load is configured.
  await Bun.write(join(target, "Runtime.js"), `var command = ${JSON.stringify(command)};\n`);
  for (const name of ["Model.js", "Service.qml", "Panel.qml", "manifest.json"]) {
    copyFileSync(join(source, name), join(target, name));
  }
  await run(["omarchy", "plugin", "validate", target]);
  await run(["omarchy-shell", "shell", "rescanPlugins"]);
  // Rescanning is asynchronous; wait for discovery, not a fixed delay.
  let found = false;
  for (let attempt = 0; attempt < 25; attempt++) {
    const proc = Bun.spawn(["omarchy", "plugin", "list", "--json"], { stdout: "pipe", stderr: "inherit" });
    const output = await new Response(proc.stdout).text();
    if (await proc.exited === 0 && JSON.parse(output).some((plugin: { id: string }) => plugin.id === "egge.codex-usage")) {
      found = true;
      break;
    }
    await Bun.sleep(200);
  }
  if (!found) throw new Error("Omarchy did not discover egge.codex-usage within five seconds.");
  await run(["omarchy", "plugin", "enable", "egge.codex-usage", "--section", "right"]);
  console.log(`Installed Codex FOMO in ${target}. Previous configuration saved in ${backupRoot}.`);
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

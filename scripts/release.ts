import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

// Explicit distribution allowlist; never archive the working directory wholesale.
const files = [
  "package.json", "bun.lock", ".bun-version", "tsconfig.json", ".gitignore", ".editorconfig",
  "index.ts", "LICENSE", "README.md", "CHANGELOG.md", "CONTRIBUTING.md", "CLAUDE.md",
  "src/codex.ts", "src/output.ts", "src/pricing.ts", "src/quota.ts", "src/store.ts", "src/tokens.ts", "src/value.ts",
  "scripts/install-timer.ts", "scripts/install-plugin.ts", "scripts/release.ts",
  "omarchy/manifest.json", "omarchy/Runtime.js", "omarchy/Model.js", "omarchy/Service.qml", "omarchy/Panel.qml",
  "docs/installation.md", "docs/cli.md", "docs/detection.md", "docs/api-value.md", "docs/omarchy.md", "docs/releasing.md",
  "test/usage.test.ts", "test/cli.test.ts", "test/plugin.test.ts", "test/value.test.ts", "test/fixtures/app-server.ts",
];

async function run(command: string[], cwd: string, env = process.env): Promise<string> {
  const child = Bun.spawn(command, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (code !== 0) throw new Error(`${command[0]} failed (${code}): ${stderr || stdout}`);
  return stdout;
}

async function main() {
  const root = resolve(import.meta.dir, "..");
  const pkg = await Bun.file(join(root, "package.json")).json();
  const plugin = await Bun.file(join(root, "omarchy/manifest.json")).json();
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version)) throw new Error("Invalid release version.");
  if (pkg.version !== plugin.version) throw new Error("Package and Omarchy plugin versions must match.");
  if (process.env.RELEASE_TAG && process.env.RELEASE_TAG !== `v${pkg.version}`)
    throw new Error(`Tag ${process.env.RELEASE_TAG} does not match package version v${pkg.version}.`);
  if (pkg.license !== "MIT") throw new Error("Update release licensing checks when changing the license.");
  const changelog = await Bun.file(join(root, "CHANGELOG.md")).text();
  const notes = changelog.split(`\n## ${pkg.version}\n`)[1]?.split("\n## ")[0]?.trim();
  if (!notes) throw new Error(`CHANGELOG.md is missing notes for ${pkg.version}.`);
  const runtime = await Bun.file(join(root, "omarchy/Runtime.js")).text();
  if (!/^\/\/[^\n]*\nvar command = \[\];\s*$/.test(runtime))
    throw new Error("Omarchy Runtime.js must contain the portable empty command, not installed paths.");

  const scratch = mkdtempSync(join(tmpdir(), "codex-fomo-release-"));
  const name = `${pkg.name}-${pkg.version}`;
  const filename = `${name}.tar.gz`;
  try {
    const stage = join(scratch, name);
    for (const file of files) {
      const source = join(root, file);
      if (!lstatSync(source).isFile()) throw new Error(`Release entry must be a regular file: ${file}`);
      const target = join(stage, file);
      mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
      copyFileSync(source, target);
      chmodSync(target, 0o644);
    }
    const archive = join(scratch, filename);
    await run(["tar", "--sort=name", "--format=ustar", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner",
      "--mode=u+rwX,go+rX,go-w", "-czf", archive, "-C", scratch, name], root);
    const unpack = join(scratch, "unpack");
    mkdirSync(unpack);
    await run(["tar", "-xzf", archive, "-C", unpack], root);
    const extracted = join(unpack, name);
    const env = { ...process.env, CODEX_USAGE_DB: join(scratch, "state/usage.sqlite"),
      CODEX_HOME: join(scratch, "codex"), XDG_CONFIG_HOME: join(scratch, "config"),
      CODEX_BIN: "/missing-codex-release-smoke-test", CODEX_USAGE_BUCKET: "codex", CODEX_USAGE_PRICES: "" };
    for (const command of ["--version", "--help", "status", "history", "summary", "tokens"]) {
      const output = await run([process.execPath, "index.ts", command, "--json"], extracted, env);
      const response = JSON.parse(output);
      const expected = command === "--version" ? "version" : command === "--help" ? "help" : command;
      if (!response.ok || response.schemaVersion !== 1 || response.command !== expected)
        throw new Error(`Archive smoke test failed for ${command}.`);
      if (expected === "version" && response.data.version !== pkg.version)
        throw new Error("Archive version mismatch.");
    }
    const bytes = await Bun.file(archive).arrayBuffer();
    const checksum = createHash("sha256").update(new Uint8Array(bytes)).digest("hex");
    const output = join(root, "dist");
    mkdirSync(output, { recursive: true });
    await Bun.write(join(output, filename), bytes);
    await Bun.write(join(output, `${filename}.sha256`), `${checksum}  ${filename}\n`);
    await Bun.write(join(output, "RELEASE_NOTES.md"), `# ${pkg.name} ${pkg.version}\n\n${notes}\n`);
    console.log(`Verified source archive: ${join(output, filename)} (${bytes.byteLength} bytes)`);
    console.log(`SHA-256: ${checksum}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

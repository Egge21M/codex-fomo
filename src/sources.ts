import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { scanTokens, type TokenEvent, type TokenScan } from "./tokens";

export type LocalSource = { id: string; type: "local"; codexHome?: string };
export type SshSource = { id: string; type: "ssh"; host: string; collectorPath?: string; codexHome?: string; bunPath?: string };
export type Source = LocalSource | SshSource;
export type SourceStatus = { id: string; type: "local" | "ssh"; host?: string; complete: boolean; eventCount: number; warnings: string[] };
export type TokenExport = { protocolVersion: 1; since: number; until: number; exportedAt: number; scan: TokenScan };

export function localPath(path: string): string {
  return resolve(path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);
}

export function parseSources(value: unknown): Source[] {
  const config = value as { sources?: unknown };
  if (!config || typeof config !== "object" || Array.isArray(config) || !Array.isArray(config.sources) ||
      config.sources.length < 1 || config.sources.length > 8) throw new Error("Config must contain 1–8 sources.");
  const ids = new Set<string>();
  return config.sources.map((raw: any): Source => {
    if (!raw || typeof raw.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(raw.id || "") || ids.has(raw.id))
      throw new Error("Source IDs must be unique, short names containing letters, digits, dots, underscores or hyphens.");
    ids.add(raw.id);
    if (raw.type !== "local" && raw.type !== "ssh") throw new Error(`Unknown source type for ${raw.id}.`);
    const allowed = raw.type === "local" ? ["id", "type", "codexHome"] : ["id", "type", "host", "collectorPath", "codexHome", "bunPath"];
    if (Object.keys(raw).some(key => !allowed.includes(key))) throw new Error(`Unknown setting for source ${raw.id}.`);
    for (const field of ["codexHome", "collectorPath", "bunPath"]) {
      const path = raw[field];
      if (path !== undefined && (typeof path !== "string" || !path || /[\x00-\x1f\x7f]/.test(path)))
        throw new Error(`Invalid ${field} for ${raw.id}.`);
      if (raw.type === "ssh" && path !== undefined && !path.startsWith("/") && !path.startsWith("~/") &&
          !(field === "bunPath" && path === "bun")) throw new Error(`${field} for ${raw.id} must be absolute or start with ~/.`);
    }
    if (raw.type === "local") return { id: raw.id, type: "local", codexHome: localPath(raw.codexHome || process.env.CODEX_HOME || join(homedir(), ".codex")) };
    if (typeof raw.host !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,252}$/.test(raw.host))
      throw new Error(`Invalid SSH alias for ${raw.id}; use an alias from ~/.ssh/config.`);
    return { id: raw.id, type: "ssh", host: raw.host,
      collectorPath: raw.collectorPath || "~/.local/share/codex-fomo/index.ts",
      bunPath: raw.bunPath || "~/.bun/bin/bun", codexHome: raw.codexHome || "~/.codex" };
  });
}

export async function loadSources(): Promise<Source[]> {
  const config = process.env.XDG_CONFIG_HOME;
  const path = process.env.CODEX_USAGE_CONFIG || join(config && isAbsolute(config) ? config : join(homedir(), ".config"), "codex-usage/config.json");
  const file = Bun.file(path);
  if (!await file.exists()) {
    if (process.env.CODEX_USAGE_CONFIG) throw new Error(`Source config not found: ${path}`);
    return parseSources({ sources: [{ id: "local", type: "local" }] });
  }
  return parseSources(await file.json());
}

function quote(value: string): string { return "'" + value.replaceAll("'", "'\\''") + "'"; }
function remotePath(value: string): string { return value.startsWith("~/") ? '"$HOME"/' + quote(value.slice(2)) : quote(value); }

export function sshCommand(source: SshSource, since: number, until: number): string[] {
  // SSH passes its final argument through a remote shell, so quote every path.
  const command = ["exec timeout 20s", remotePath(source.bunPath || "~/.bun/bin/bun"),
    remotePath(source.collectorPath || "~/.local/share/codex-fomo/index.ts"), "export-tokens --json",
    "--since", String(since), "--until", String(until), "--codex-home", remotePath(source.codexHome || "~/.codex")].join(" ");
  return ["ssh", "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=8",
    "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=2", "-o", "ForwardAgent=no", "-o", "ClearAllForwardings=yes",
    source.host, command];
}

/** Bound output and elapsed time even if SSH connects but the exporter hangs. */
export async function capture(command: string[], timeoutMs = 25_000): Promise<string> {
  const child = Bun.spawn(command, { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
  try {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for await (const chunk of child.stdout) {
      bytes += chunk.length;
      if (bytes > 64 * 1024 * 1024) throw new Error("Remote export exceeded the 64 MiB limit.");
      chunks.push(chunk);
    }
    const code = await child.exited;
    if (timedOut) throw new Error("Remote token export timed out.");
    if (code !== 0) throw new Error(`SSH/export failed (exit ${code}); check the alias, key/agent access, and exporter installation.`);
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    clearTimeout(timer);
    child.kill("SIGKILL");
    await child.exited;
  }
}

export function parseExport(text: string, since: number, until: number, requestedAt: number, receivedAt = Date.now()): TokenScan {
  const response = JSON.parse(text);
  const data = response?.data as TokenExport;
  if (response?.schemaVersion !== 1 || response.command !== "export-tokens" || response.ok !== true ||
      data?.protocolVersion !== 1 || data.since !== since || data.until !== until)
    throw new Error("Invalid or incompatible remote token export; update the exporter.");
  if (!Number.isSafeInteger(data.exportedAt) || data.exportedAt < requestedAt - 60_000 || data.exportedAt > receivedAt + 60_000)
    throw new Error("Remote clock differs by more than 60 seconds; synchronize the machines.");
  const scan = data.scan;
  if (!scan || typeof scan.source !== "string" || typeof scan.complete !== "boolean" || !Array.isArray(scan.events) ||
      !Array.isArray(scan.warnings) || !scan.warnings.every(x => typeof x === "string" && x.length <= 1000))
    throw new Error("Invalid remote scan metadata.");
  const events = scan.events.map((e): TokenEvent => {
    if (!e || typeof e.key !== "string" || !/^(response|legacy):.{1,512}$/.test(e.key) ||
        !Number.isSafeInteger(e.timestamp) || e.timestamp <= since || e.timestamp > until ||
        typeof e.model !== "string" || e.model.length < 1 || e.model.length > 200 || /[\x00-\x1f\x7f]/.test(e.model) ||
        !["response", "legacy"].includes(e.source) ||
        ![e.inputTokens, e.cachedInputTokens, e.cacheWriteTokens, e.outputTokens].every(n => Number.isSafeInteger(n) && n >= 0))
      throw new Error("Invalid remote token record.");
    // Project onto the metadata contract: ignore any extra fields from the remote process.
    return { key: e.key, timestamp: e.timestamp, model: e.model, source: e.source,
      inputTokens: e.inputTokens, cachedInputTokens: e.cachedInputTokens, cacheWriteTokens: e.cacheWriteTokens, outputTokens: e.outputTokens };
  });
  return { source: scan.source, complete: scan.complete && scan.warnings.length === 0, warnings: scan.warnings, events };
}

type Readers = {
  local: typeof scanTokens;
  remote: (source: SshSource, since: number, until: number) => Promise<TokenScan>;
};
const readers: Readers = {
  local: scanTokens,
  remote: async (source, since, until) => {
    const at = Date.now();
    return parseExport(await capture(sshCommand(source, since, until)), since, until, at);
  },
};

export async function collectSources(sources: Source[], since: number, until: number, read: Readers = readers): Promise<TokenScan> {
  const results = await Promise.all(sources.map(async source => {
    try {
      const scan = source.type === "local" ? await read.local(since, until, source.codexHome) : await read.remote(source, since, until);
      return { source, scan };
    } catch (error) {
      return { source, scan: { source: "unavailable", events: [], complete: false,
        warnings: [error instanceof Error ? error.message : "Token collection failed."] } as TokenScan };
    }
  }));
  const events = new Map<string, TokenEvent>();
  const warnings: string[] = [];
  const statuses: SourceStatus[] = [];
  for (const { source, scan } of results) {
    statuses.push({ id: source.id, type: source.type, ...(source.type === "ssh" ? { host: source.host } : {}),
      complete: scan.complete && scan.warnings.length === 0, eventCount: scan.events.length, warnings: scan.warnings });
    warnings.push(...scan.warnings.map(w => `${source.id}: ${w}`));
    for (const event of scan.events) {
      const previous = events.get(event.key);
      if (previous) {
        const countsMatch = ["timestamp", "source", "inputTokens", "cachedInputTokens", "cacheWriteTokens", "outputTokens"]
          .every(key => previous[key as keyof TokenEvent] === event[key as keyof TokenEvent]);
        if (!countsMatch || (previous.model !== event.model && previous.model !== "unknown" && event.model !== "unknown")) {
          warnings.push(`Conflicting duplicate token record from ${source.id}.`);
          continue;
        }
        if (event.model === "unknown") continue;
      }
      events.set(event.key, event);
    }
  }
  const identity = results.map(({ source, scan }) => ({ ...source, resolvedHome: scan.source })).sort((a, b) => a.id.localeCompare(b.id));
  return { source: "sources:" + createHash("sha256").update(JSON.stringify(identity)).digest("hex"),
    sourceScope: sources.some(s => s.type === "ssh") ? "configured-machines" : "local-only",
    sources: statuses, events: [...events.values()].sort((a, b) => a.timestamp - b.timestamp),
    complete: statuses.every(s => s.complete) && warnings.length === 0, warnings: [...new Set(warnings)] };
}

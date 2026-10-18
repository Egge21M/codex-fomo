import type { SourceStatus } from "./sources";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

export type TokenUsage = { inputTokens: number; cachedInputTokens: number; cacheWriteTokens: number; outputTokens: number };
export type TokenEvent = TokenUsage & { key: string; timestamp: number; model: string; source: "response" | "legacy" };
export type TokenScan = { events: TokenEvent[]; complete: boolean; warnings: string[]; source: string; sourceScope?: "local-only" | "configured-machines"; sources?: SourceStatus[] };
type Context = { model: string; provider: string };
type Candidate = { key: string; timestamp: number; turn: string; context: Context; usage: TokenUsage; source: "response" | "legacy" };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export function normalizeUsage(value: any): TokenUsage | null {
  if (!value || typeof value !== "object") return null;
  const values = [value.input_tokens, value.cached_input_tokens ?? 0, value.cache_write_input_tokens ?? 0, value.output_tokens];
  if (!values.every(n => Number.isSafeInteger(n) && n >= 0)) return null;
  const [input, cached, write, output] = values as [number, number, number, number];
  if (cached + write > input) return null;
  // Reasoning output is already part of output_tokens.
  return { inputTokens: input - cached - write, cachedInputTokens: cached, cacheWriteTokens: write, outputTokens: output };
}

/** Omarchy's native-session approach, with per-response IDs and turn-model lookup.
 * Only metadata and counts survive parsing; no prompts or responses are stored.
 */
export async function scanTokens(since: number, until: number, home = process.env.CODEX_HOME || join(homedir(), ".codex")): Promise<TokenScan> {
  const source = resolve(home);
  const warnings = new Set<string>();
  const contexts = new Map<string, Context>();
  const candidates: Candidate[] = [];
  const granularTurns = new Set<string>();
  let fileCount = 0;
  async function walk(directory: string): Promise<string[]> {
    try {
      const result: string[] = [];
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) result.push(...await walk(path));
        else if (entry.isFile() && entry.name.endsWith(".jsonl")) result.push(path);
      }
      return result;
    } catch (error: any) {
      if (error.code !== "ENOENT") warnings.add("Some session directories could not be read.");
      return [];
    }
  }
  for (const root of ["sessions", "archived_sessions"]) {
    for (const path of await walk(join(source, root))) {
      fileCount++;
      let session = path, turn = "", context: Context = { model: "unknown", provider: "openai" };
      let previousTotal = "";
      const input = createReadStream(path, { encoding: "utf8" });
      const lines = createInterface({ input, crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          if (!line.trim()) continue;
          let entry: any;
          try { entry = JSON.parse(line); }
          catch { warnings.add("Some session records are malformed or still being written."); continue; }
          if (!entry || typeof entry !== "object") continue;
          const payload = entry.payload;
          if (!payload || typeof payload !== "object") continue;
          if (entry.type === "session_meta") {
            session = payload.id || session;
            context = { ...context, provider: payload.model_provider || "openai" };
          } else if (entry.type === "turn_context") {
            turn = payload.turn_id || "";
            context = { model: payload.model || payload.model_slug || "unknown", provider: context.provider };
            if (turn) contexts.set(turn, context);
          } else if (entry.type === "token_usage_record" || payload.type === "token_count") {
            const detailed = entry.type === "token_usage_record";
            const recordTurn = detailed ? String(payload.turn_id || "") : turn;
            if (detailed && recordTurn) granularTurns.add(recordTurn);
            // Repeated cumulative snapshots may have new timestamps but no new usage.
            const total = payload.info?.total_token_usage;
            const totalKey = total ? JSON.stringify(total) : "";
            if (!detailed && totalKey && totalKey === previousTotal) continue;
            if (!detailed) previousTotal = totalKey;
            const timestamp = Date.parse(entry.timestamp);
            if (!Number.isFinite(timestamp)) { warnings.add("A token record has no valid timestamp."); continue; }
            if (timestamp <= since || timestamp > until) continue;
            const raw = detailed ? payload.usage : payload.info?.last_token_usage;
            // info:null is a rate-limit notification, not token usage.
            if (!raw && !detailed) continue;
            const usage = normalizeUsage(raw);
            if (!usage) { warnings.add("A token record has invalid counts."); continue; }
            if (Object.values(usage).every(n => n === 0)) continue;
            const key = detailed && payload.response_id ? "response:" + payload.response_id :
              "legacy:" + hash(JSON.stringify([recordTurn || session, totalKey || timestamp, usage]));
            candidates.push({ key, timestamp, turn: recordTurn,
              context: detailed ? { model: "unknown", provider: context.provider } : context,
              usage, source: detailed ? "response" : "legacy" });
          }
        }
      } catch { warnings.add("Some session files could not be read completely."); }
      finally { lines.close(); input.destroy(); }
    }
  }
  if (!fileCount) warnings.add("No native Codex session logs found.");
  const events = new Map<string, TokenEvent>();
  for (const candidate of candidates) {
    if (candidate.source === "legacy" && candidate.turn && granularTurns.has(candidate.turn)) continue;
    const context = contexts.get(candidate.turn) || candidate.context;
    // Auto-review safety checks are free and do not consume the subscription.
    if (context.provider !== "openai" || context.model === "codex-auto-review") continue;
    const event = { key: candidate.key, timestamp: candidate.timestamp, model: context.model, source: candidate.source, ...candidate.usage };
    const previous = events.get(event.key);
    if (previous && JSON.stringify(previous) !== JSON.stringify(event)) warnings.add("Conflicting duplicate token records found.");
    else events.set(event.key, event);
  }
  return { events: [...events.values()].sort((a, b) => a.timestamp - b.timestamp), complete: warnings.size === 0, warnings: [...warnings], source };
}

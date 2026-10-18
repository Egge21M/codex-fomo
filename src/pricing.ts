import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { TokenUsage } from "./tokens";

export type ModelPrice = {
  input: number; cachedInput: number; cacheWrite: number; output: number;
  longContextThreshold?: number;
  longContextInputMultiplier?: number;
  longContextOutputMultiplier?: number;
};
export type PriceBook = { version: string; source: string; verifiedAt: string; models: Record<string, ModelPrice> };
const longContext = { longContextThreshold: 272_000, longContextInputMultiplier: 2, longContextOutputMultiplier: 1.5 };
// Standard API reference prices, USD per million tokens; not subscription billing.
// https://developers.openai.com/api/docs/pricing (verified 2026-10-15)
const defaults: Record<string, ModelPrice> = {
  "gpt-6-astra": { input: 10, cachedInput: 1, cacheWrite: 12.5, output: 50, ...longContext },
  "gpt-6.1-sol": { input: 2, cachedInput: 0.1, cacheWrite: 2.5, output: 10, ...longContext },
  "gpt-6-sol": { input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 10, ...longContext },
  "gpt-6-luna": { input: 0.1, cachedInput: 0.01, cacheWrite: 0.125, output: 0.5, ...longContext },
  "gpt-5.6-sol": { input: 4, cachedInput: 0.4, cacheWrite: 5, output: 20, ...longContext },
  // No cache-write rate is published for this model. Requests with writes stay unpriced.
  "gpt-5.3-codex": { input: 1.75, cachedInput: 0.175, cacheWrite: 0, output: 14 },
};

export function priceBook(models = defaults): PriceBook {
  const sorted = Object.fromEntries(Object.entries(models).sort(([a], [b]) => a.localeCompare(b)));
  return { version: createHash("sha256").update(JSON.stringify(sorted)).digest("hex").slice(0, 16),
    source: "https://developers.openai.com/api/docs/pricing", verifiedAt: "2026-10-15", models: sorted };
}

export async function loadPrices(): Promise<PriceBook> {
  const config = process.env.XDG_CONFIG_HOME;
  const path = process.env.CODEX_USAGE_PRICES || join(config && isAbsolute(config) ? config : join(homedir(), ".config"), "codex-usage/prices.json");
  const file = Bun.file(path);
  if (!await file.exists()) {
    if (process.env.CODEX_USAGE_PRICES) throw new Error(`Pricing file not found: ${path}`);
    return priceBook();
  }
  const overrides = await file.json();
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) throw new Error("Pricing file must contain a model-to-rates object.");
  for (const [model, rates] of Object.entries(overrides)) {
    if (!rates || typeof rates !== "object" || Array.isArray(rates)) throw new Error(`Invalid prices for ${model}`);
    const r = rates as Record<string, unknown>;
    for (const key of ["input", "cachedInput", "cacheWrite", "output"]) {
      if (typeof r[key] !== "number" || !Number.isFinite(r[key]) || r[key] < 0) throw new Error(`Invalid ${key} price for ${model}`);
    }
    for (const key of ["longContextThreshold", "longContextInputMultiplier", "longContextOutputMultiplier"]) {
      if (r[key] !== undefined && (typeof r[key] !== "number" || !Number.isFinite(r[key]) || r[key] <= 0)) throw new Error(`Invalid ${key} for ${model}`);
    }
    if (r.longContextThreshold !== undefined && (r.longContextInputMultiplier === undefined || r.longContextOutputMultiplier === undefined))
      throw new Error(`Long-context multipliers are required for ${model}`);
  }
  return { ...priceBook({ ...defaults, ...overrides }), source: path };
}

export function apiCost(model: string, usage: TokenUsage, book: PriceBook): number | null {
  const rate = Object.hasOwn(book.models, model) ? book.models[model] : undefined;
  if (!rate || (usage.cacheWriteTokens > 0 && rate.cacheWrite === 0)) return null;
  const long = rate.longContextThreshold !== undefined && usage.inputTokens + usage.cachedInputTokens + usage.cacheWriteTokens > rate.longContextThreshold;
  const inputMultiplier = long ? rate.longContextInputMultiplier! : 1;
  const outputMultiplier = long ? rate.longContextOutputMultiplier! : 1;
  return ((usage.inputTokens * rate.input + usage.cachedInputTokens * rate.cachedInput + usage.cacheWriteTokens * rate.cacheWrite) * inputMultiplier
    + usage.outputTokens * rate.output * outputMultiplier) / 1_000_000;
}

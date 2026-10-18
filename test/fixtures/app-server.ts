import { createInterface } from "node:readline";

const mode = process.env.CODEX_USAGE_TEST_MODE ?? process.argv[2];
let initialized = false;
let ready = false;
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (mode === "hang") continue;
  if (mode === "exit") process.exit(1);
  if (mode === "malformed") { console.log("not json"); continue; }
  if (message.method === "initialize") {
    initialized = true;
    console.log(JSON.stringify({ id: message.id, result: {} }));
  } else if (message.method === "initialized") {
    ready = initialized;
  } else if (message.method === "account/rateLimits/read") {
    if (!ready) throw new Error("Client skipped the initialization handshake");
    if (mode === "error") {
      console.log(JSON.stringify({ id: message.id, error: { code: -32000, message: "Sign in with ChatGPT first" } }));
      continue;
    }
    console.log(JSON.stringify({ method: "account/rateLimits/updated", params: {} }));
    const response = JSON.stringify({ id: message.id, result: {
      accountId: "test-account",
      rateLimitsByLimitId: { codex: {
        planType: "pro",
        primary: { usedPercent: 63, resetsAt: 2_000_000_000, windowDurationMins: 10080 },
        secondary: { usedPercent: 99, resetsAt: 1_999_999_000, windowDurationMins: 300 },
      } },
    } });
    // Exercise partial lines and notifications interleaved with responses.
    process.stdout.write(response.slice(0, 40));
    await Bun.sleep(10);
    process.stdout.write(response.slice(40) + "\n");
  } else throw new Error(`Unexpected method: ${message.method}`);
}

import { selectWeeklyQuota, type WeeklyQuota } from "./quota";
import { version } from "../package.json";

/** One short-lived stdio connection; never starts an inference thread or turn. */
export async function readWeeklyQuota(options: {
  command?: string[];
  bucket?: string;
  timeoutMs?: number;
} = {}): Promise<WeeklyQuota> {
  const proc = Bun.spawn(options.command ?? [process.env.CODEX_BIN || "codex", "app-server"], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  let nextId = 0;
  let failure: Error | undefined;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const fail = (error: Error) => {
    failure ??= error;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  const timeout = setTimeout(() => {
    fail(new Error("Codex usage read timed out. Check your network and Codex login."));
    proc.kill("SIGKILL");
  }, options.timeoutMs ?? 30_000);

  const send = async (message: unknown) => {
    proc.stdin.write(JSON.stringify(message) + "\n");
    await proc.stdin.flush();
  };
  const request = (method: string, params = {}): Promise<unknown> => {
    if (failure) return Promise.reject(failure);
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      void send({ id, method, params }).catch((error) => fail(new Error(`Cannot write to Codex: ${error}`)));
    });
  };
  const reader = (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of proc.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        if (message.method) {
          // This read-only client does not service server-initiated requests.
          if (message.id !== undefined) await send({ id: message.id, error: { code: -32601, message: "Method not supported" } });
          continue;
        }
        const waiting = pending.get(message.id);
        if (!waiting) continue;
        pending.delete(message.id);
        if (message.error) waiting.reject(new Error(`Codex: ${message.error.message ?? "RPC request failed"}`));
        else waiting.resolve(message.result);
      }
    }
    fail(new Error("Codex app-server closed its output before the request completed."));
  })().catch((error) => fail(new Error(`Cannot read Codex response: ${error}`)));
  // Drain diagnostics so the child cannot block on a full stderr pipe. Opt in for troubleshooting.
  const diagnostics = (async () => {
    for await (const chunk of proc.stderr) {
      if (process.env.CODEX_USAGE_DEBUG === "1") process.stderr.write(chunk);
    }
  })().catch(() => {});

  try {
    await request("initialize", {
      clientInfo: { name: "codex_fomo", title: "Codex FOMO", version },
    });
    await send({ method: "initialized", params: {} });
    const result = await request("account/rateLimits/read", { excludeResetCreditDetails: true });
    return selectWeeklyQuota(result, options.bucket);
  } finally {
    clearTimeout(timeout);
    proc.stdin.end();
    proc.kill("SIGTERM");
    const forceKill = setTimeout(() => proc.kill("SIGKILL"), 1_000);
    await proc.exited;
    clearTimeout(forceKill);
    await Promise.all([reader, diagnostics]);
  }
}

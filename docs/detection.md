# Reset detection

1. Start a short-lived `codex app-server`, perform its initialization handshake, and call `account/rateLimits/read`.
2. Select the `codex` bucket and its window with `windowDurationMins = 10080`, regardless of whether it is `primary` or `secondary`. Missing/invalid weekly data is an error, never zero usage.
3. Compare its reset timestamp with the previous observation for this account and bucket. A change greater than 60 seconds in either direction is an inferred reset, even when usage increased between polls. Smaller changes are ignored as timestamp jitter; the raw timestamps are still saved. A changed plan establishes a new baseline.
4. Record the reset with the preceding observation's usage and `max(0, 100 - usedPercent)` as estimated unused allowance. Save the new observation and event in one transaction.

Reset estimates are upper bounds, assuming a stable quota and usage counter: consumption between the last poll and the reset is unobserved. Each event includes the actual sample gap. Gaps longer than six minutes are marked as missing polls, and multiple intervening resets cannot be reconstructed. A reset timestamp change could also be a service-side correction; these are inferred events, not authoritative reset notifications.

An event is classified as `early` when detected before the previous scheduled reset and `scheduled` otherwise. The latter describes timing, not a verified cause. Usage drops without a timestamp shift beyond the tolerance are reported as anomalies and do not create reset events. Elapsed reset times without new timestamps do not create events either. The 60-second tolerance is a heuristic: an actual reset whose deadline shifts by at most 60 seconds cannot be distinguished reliably from jitter and will not be counted.

The account ID returned by Codex separates account histories. Older servers that omit it share an `unknown` account namespace; use a separate database when switching accounts on those servers. All successful samples are retained. No authentication tokens or raw API responses are stored.

The SQLite write lock covers the whole poll, preventing concurrent collectors from recording out-of-order results. Requests time out after 30 seconds and the child process is terminated. The timer also bounds the whole service run to 90 seconds. Polling never starts a model turn.

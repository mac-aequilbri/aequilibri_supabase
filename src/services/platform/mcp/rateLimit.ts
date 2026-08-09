// Per-org MCP rate limiting (mcp-assistant-plan W6). Fixed one-minute window
// per org slug, applied at the endpoint BEFORE session resolution so a
// misbehaving (or brute-forcing) client is shed before it can hammer the
// control-plane key lookup. In-process state is correct here for the same
// reason the scheduler lock is: the deployment is pinned to a single
// instance (AWS plan §1) — revisit alongside the shared-Redis item if that
// pin is ever lifted.
//
//   MCP_RATE_LIMIT_PER_MIN — requests per org per minute (default 120;
//                            0 or negative disables limiting).

const WINDOW_MS = 60_000;
const DEFAULT_LIMIT = 120;
const BUCKET_CAP = 500; // orgs tracked at once — far above any real tenant count

interface Bucket {
  count: number;
  windowStart: number;
}

const buckets = new Map<string, Bucket>();

function configuredLimit(): number {
  const raw = Number(process.env.MCP_RATE_LIMIT_PER_MIN ?? DEFAULT_LIMIT);
  return Number.isFinite(raw) ? raw : DEFAULT_LIMIT;
}

export interface RateDecision {
  allowed: boolean;
  /** Seconds until the window resets — the 429 Retry-After value. */
  retryAfterSeconds: number;
}

export function checkMcpRateLimit(orgSlug: string, now = Date.now()): RateDecision {
  const limit = configuredLimit();
  if (limit <= 0) return { allowed: true, retryAfterSeconds: 0 };

  const bucket = buckets.get(orgSlug);
  if (!bucket || now - bucket.windowStart >= WINDOW_MS) {
    buckets.set(orgSlug, { count: 1, windowStart: now });
    if (buckets.size > BUCKET_CAP) {
      const oldest = buckets.keys().next().value;
      if (oldest) buckets.delete(oldest);
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }

  bucket.count += 1;
  if (bucket.count <= limit) return { allowed: true, retryAfterSeconds: 0 };
  return {
    allowed: false,
    retryAfterSeconds: Math.max(1, Math.ceil((bucket.windowStart + WINDOW_MS - now) / 1000)),
  };
}

/** Test hook — clears all windows. */
export function resetMcpRateLimit(): void {
  buckets.clear();
}

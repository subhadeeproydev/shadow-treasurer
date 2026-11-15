// Airwallex webhook verification: HMAC-SHA256 over `${x-timestamp}${rawBody}` with the endpoint secret,
// constant-time comparison, a freshness window, and event-id dedupe (duplicate / replayed events are ignored).
import { createHmac, timingSafeEqual } from 'node:crypto';

export const MAX_SKEW_MS = 5 * 60_000;

export interface WebhookEvent {
  readonly id: string;
  readonly name: string;
  readonly data: Record<string, unknown>;
}

export type WebhookResult =
  | { readonly status: 'accepted'; readonly event: WebhookEvent }
  | { readonly status: 'duplicate'; readonly eventId: string }
  | { readonly status: 'rejected'; readonly reason: string };

export const signWebhook = (secret: string, timestamp: string, rawBody: string): string =>
  createHmac('sha256', secret).update(`${timestamp}${rawBody}`).digest('hex');

export class WebhookReceiver {
  private readonly seen = new Set<string>();
  private readonly secret: string;
  private readonly now: () => number;

  constructor(secret: string, now: () => number = Date.now) {
    this.secret = secret;
    this.now = now;
  }

  receive(rawBody: string, timestamp: string | undefined, signature: string | undefined): WebhookResult {
    if (!timestamp || !signature) return { status: 'rejected', reason: 'missing signature headers' };
    const ts = Number(timestamp);
    if (!Number.isFinite(ts) || Math.abs(this.now() - ts) > MAX_SKEW_MS) return { status: 'rejected', reason: 'stale timestamp' };
    const expected = Buffer.from(signWebhook(this.secret, timestamp, rawBody), 'hex');
    const given = Buffer.from(signature, 'hex');
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { status: 'rejected', reason: 'bad signature' };
    let parsed: unknown;
    try { parsed = JSON.parse(rawBody); } catch { return { status: 'rejected', reason: 'invalid json' }; }
    const evt = parsed as { id?: unknown; name?: unknown; data?: unknown };
    if (typeof evt.id !== 'string' || typeof evt.name !== 'string') return { status: 'rejected', reason: 'missing id/name' };
    if (this.seen.has(evt.id)) return { status: 'duplicate', eventId: evt.id };
    this.seen.add(evt.id);
    return { status: 'accepted', event: { id: evt.id, name: evt.name, data: (evt.data as Record<string, unknown>) ?? {} } };
  }
}

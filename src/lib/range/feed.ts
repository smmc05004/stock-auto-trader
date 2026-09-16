import type { Sample } from "./strategy";
type Socket = { readyState: number; close(): void };
type Connect = (quote: (s: Sample) => void, trade: (at: number) => void, down: (reason?: string) => void, ack: (tr: string, ok: boolean, code: string) => void) => Promise<Socket>;
export class FeedController {
  socket?: Socket;
  generation = 0;
  connecting = false;
  ready = false;
  attempts = 0;
  failures = 0;
  nextRetryAt = 0;
  lastQuoteAt = 0;
  lastTradeAt = 0;
  private startedAt = 0;
  private failed = false;
  private acknowledgements = new Set<string>();
  constructor(readonly connect: Connect, readonly quote: (s: Sample) => void, readonly trade: (at: number) => void, readonly disconnect: () => void, readonly event: (kind: string, data: unknown) => void, readonly clock = Date.now, readonly random = Math.random) {}
  private down(reason: string, generation: number) {
    if (generation !== this.generation || this.failed) return;
    this.failed = true; this.ready = false;
    this.failures++;
    this.nextRetryAt = this.clock() + [1000, 2000, 5000, 10000, 30000][Math.min(this.failures - 1, 4)] + Math.floor(this.random() * 250);
    this.event("feed_down", { generation, reason, lastQuoteAt: this.lastQuoteAt, lastTradeAt: this.lastTradeAt, nextRetryAt: this.nextRetryAt });
    this.disconnect(); this.socket?.close();
  }
  async tick(enabled: boolean) {
    const now = this.clock();
    if (!enabled) {
      if (this.socket || this.connecting) this.down("session_or_shutdown", this.generation);
      return;
    }
    if (this.socket && !this.failed && (now - (this.lastQuoteAt || this.startedAt) > 30_000 || now - (this.lastTradeAt || this.startedAt) > 30_000 || (!this.ready && now - this.startedAt > 15_000))) this.down("stale_feed_or_subscription_timeout", this.generation);
    if (this.connecting || (this.socket && this.socket.readyState !== 3) || now < this.nextRetryAt) return;
    this.connecting = true; this.failed = false; this.ready = false;
    this.acknowledgements.clear(); this.lastQuoteAt = 0; this.lastTradeAt = 0;
    this.startedAt = now; const generation = ++this.generation; this.attempts++;
    this.event("feed_connecting", { generation, attempt: this.attempts });
    const active = () => generation === this.generation && !this.failed;
    try {
      const socket = await this.connect(s => {
        if (!active() || !this.ready) return;
        this.lastQuoteAt = s.at;
        if (this.lastTradeAt && this.clock() - this.lastTradeAt < 5000 && this.clock() - this.startedAt >= 60_000) this.failures = 0;
        this.quote(s);
      }, at => { if (active() && this.ready) { this.lastTradeAt = at; this.trade(at); } }, reason => this.down(reason ?? "socket_closed", generation), (tr, ok, code) => {
        if (!active()) return;
        this.event("feed_subscription", { generation, tr, ok, code });
        if (!ok) { this.down("subscription_rejected", generation); return; }
        this.acknowledgements.add(tr);
        this.ready = this.acknowledgements.has("H0STASP0") && this.acknowledgements.has("H0STCNT0");
      });
      this.socket = socket;
      if (!active()) socket.close();
    } catch { this.down("connection_or_approval_failed", generation); }
    finally { this.connecting = false; }
  }
  stop() { this.down("shutdown", this.generation); }
  snapshot() { return { ready: this.ready, connecting: this.connecting, generation: this.generation, attempts: this.attempts, nextRetryAt: this.nextRetryAt, lastQuoteAt: this.lastQuoteAt, lastTradeAt: this.lastTradeAt }; }
}

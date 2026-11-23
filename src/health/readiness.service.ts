import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';

import { PG_POOL } from '../db/database.module';
import { OrderStatusFeed } from '../realtime/order-status.feed';

// How long a probe waits for Postgres before calling the instance not ready. Below
// the compose and kubelet probe timeouts, so the probe answers 503 instead of
// timing out.
const DB_PROBE_TIMEOUT_MS = 1000;

export interface Readiness {
  status: 'ready' | 'not_ready' | 'draining';
  checks: {
    database: 'up' | 'down';
    // Reported, never gating: checkout writes the event to the outbox in its own
    // transaction, so an API instance without a broker still takes orders. Only the
    // live push to WS/SSE waits for it, and SSE replays from history on reconnect.
    broker: 'up' | 'down' | 'disabled';
  };
}

// The two probe answers of the API, kept apart on purpose:
//   /healthz — "should I be restarted?" Nothing but the event loop: a database
//              outage must not get every replica killed at once.
//   /readyz  — "may I get traffic?" Postgres answers and SIGTERM has not come.
@Injectable()
export class ReadinessService {
  private isDraining = false;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly feed: OrderStatusFeed,
  ) {}

  get draining(): boolean {
    return this.isDraining;
  }

  // One way: once the instance is leaving, readiness never comes back.
  drain(): void {
    this.isDraining = true;
  }

  async check(): Promise<Readiness> {
    const database = (await this.databaseUp()) ? 'up' : 'down';
    const broker = !this.feed.enabled ? 'disabled' : this.feed.connected ? 'up' : 'down';
    const status = this.isDraining ? 'draining' : database === 'up' ? 'ready' : 'not_ready';
    return { status, checks: { database, broker } };
  }

  private async databaseUp(): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), DB_PROBE_TIMEOUT_MS);
    });
    const query = this.pool.query('SELECT 1').then(
      () => true,
      () => false,
    );
    try {
      return await Promise.race([query, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}

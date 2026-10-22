import 'reflect-metadata';

import { DataSource } from 'typeorm';

import { dataSourceOptions } from './data-source';
import { brokerAddress, connectBroker } from './messaging/broker';
import { EVENTS_EXCHANGE } from './messaging/events';
import { EventPublisher } from './messaging/publisher';
import { relayBatch } from './outbox/relay';

// The outbox relay as a process of its own:
//
//   node dist/relay.js                               poll until SIGTERM
//   node dist/relay.js --hold-after-publish=<id>     publish, then never mark
//
// Every step is one JSON line on stdout, which is what the demos read. The second
// form exists for demo:crash-relay: once a batch containing <id> is confirmed by
// the broker, the process stops right before the UPDATE that would mark it and
// waits to be killed with SIGKILL — a crash between publish and published_at.

export type RelayEvent =
  | { kind: 'ready'; pid: number }
  | { kind: 'tick'; picked: number }
  | { kind: 'published'; eventId: string }
  | { kind: 'marked'; eventIds: string[] }
  | { kind: 'failed'; eventId: string; reason: string }
  | { kind: 'holding'; eventIds: string[] };

const POLL_MS = 100;
const NAME = `relay-${process.pid}`;
const HOLD_FOR = process.argv.find((arg) => arg.startsWith('--hold-after-publish='))?.split('=')[1];

const emit = (event: RelayEvent): void => {
  process.stdout.write(`${JSON.stringify(event)}\n`);
};

async function main(): Promise<void> {
  const dataSource = new DataSource({ ...dataSourceOptions, logging: ['error'] });
  await dataSource.initialize();

  const connection = await connectBroker(NAME);
  // The producer's side of the topology: the exchange it publishes to. Who is
  // bound to it is the consumers' business (topology.ts).
  const setup = await connection.createChannel();
  await setup.assertExchange(EVENTS_EXCHANGE, 'topic', { durable: true });
  await setup.close();
  const publisher = await EventPublisher.open(connection);

  let stopping = false;
  connection.on('close', () => {
    if (stopping) return;
    console.error(`[${NAME}] connection closed by the broker — exiting`);
    process.exit(1);
  });

  emit({ kind: 'ready', pid: process.pid });
  console.error(`[${NAME}] relaying outbox → ${brokerAddress()}${HOLD_FOR ? ` (holding after ${HOLD_FOR})` : ''}`);

  // Graceful: the pass in hand finishes (publish and mark), then the loop ends.
  const stop = (): void => {
    stopping = true;
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  while (!stopping) {
    const batch = await relayBatch(dataSource, publisher, {
      onPublished: (eventId) => emit({ kind: 'published', eventId }),
      beforeMark:
        HOLD_FOR === undefined
          ? undefined
          : async (published) => {
              if (!published.includes(HOLD_FOR)) return;
              emit({ kind: 'holding', eventIds: published });
              await new Promise<void>(() => undefined);
            },
    });
    emit({ kind: 'tick', picked: batch.picked });
    if (batch.published.length > 0) emit({ kind: 'marked', eventIds: batch.published });
    for (const { id, reason } of batch.failed) emit({ kind: 'failed', eventId: id, reason });

    if (batch.picked === 0) await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }

  await publisher.close();
  await connection.close();
  await dataSource.destroy();
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error(`[${NAME}] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

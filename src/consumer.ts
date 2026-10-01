import 'reflect-metadata';

import { DataSource } from 'typeorm';

import { dataSourceOptions } from './data-source';
import { brokerAddress, connectBroker } from './messaging/broker';
import { ConsumerEvent, consumeOrderPlaced } from './messaging/order-placed.consumer';

// The order.placed consumer as a process of its own:
//
//   node dist/consumer.js                         consume until SIGTERM
//   node dist/consumer.js --hold-ack-after-effect apply the effect, then never ack
//
// Every step is one JSON line on stdout, which is what the demos read. The second
// form exists for demo:duplicate: the effect is in the database, the ack is not
// sent, and the demo kills this process with SIGKILL — a crash, not a shutdown.

const HOLD_ACK = process.argv.includes('--hold-ack-after-effect');
const NAME = `fulfilment-${process.pid}`;

const emit = (event: ConsumerEvent | { kind: string; [key: string]: unknown }): void => {
  process.stdout.write(`${JSON.stringify(event)}\n`);
};

async function main(): Promise<void> {
  const dataSource = new DataSource({ ...dataSourceOptions, logging: ['error'] });
  await dataSource.initialize();

  const connection = await connectBroker(NAME);
  const channel = await connection.createChannel();

  let stopping = false;
  // A channel or connection the broker closed under us is not something to limp
  // on with: exit non-zero and let whatever supervises the process start a new one.
  const abort = (what: string) => () => {
    if (stopping) return;
    console.error(`[${NAME}] ${what} closed by the broker — exiting`);
    process.exit(1);
  };
  channel.on('close', abort('channel'));
  connection.on('close', abort('connection'));

  const consumer = await consumeOrderPlaced(channel, dataSource, {
    name: NAME,
    observe: (event) => {
      emit(event);
      if (event.kind === 'cancelled') abort('subscription')();
    },
    beforeAck: HOLD_ACK
      ? (event) => {
          emit({ kind: 'holding', eventId: event.eventId });
          return new Promise<void>(() => undefined);
        }
      : undefined,
  });

  console.error(`[${NAME}] consuming from ${brokerAddress()}${HOLD_ACK ? ' (holding acks)' : ''}`);

  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await consumer.stop();
    await channel.close();
    await connection.close();
    await dataSource.destroy();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

main().catch((error: unknown) => {
  console.error(`[${NAME}] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

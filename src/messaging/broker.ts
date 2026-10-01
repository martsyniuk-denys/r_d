import { readFileSync } from 'node:fs';

import { ChannelModel, connect } from 'amqplib';

const HINT =
  'The broker address comes from the environment only. Either go through the secret store ' +
  '(bash scripts/with-secrets.sh dev <command> — every npm script that talks to the broker ' +
  'already does), or export BROKER_URL=amqp://user:pass@host:5672 yourself and set SKIP_VAULT=1.';

const MANAGEMENT_PORT = '15672';

function readPassword(): string {
  const inline = process.env.BROKER_PASSWORD;
  if (inline !== undefined && inline !== '') return inline;

  const file = process.env.BROKER_PASSWORD_FILE;
  if (file !== undefined && file !== '') return readFileSync(file, 'utf8').trim();

  throw new Error(
    `BROKER_URL carries no password, and neither BROKER_PASSWORD nor BROKER_PASSWORD_FILE is set. ${HINT}`,
  );
}

// Two shapes, the same two data-source.ts accepts for Postgres: the store keeps
// the URL without a password and the password in a file next to db_password; the
// grader exports one URL with the password inside it.
export function brokerUrl(): string {
  const raw = process.env.BROKER_URL;
  if (raw === undefined || raw === '') throw new Error(`BROKER_URL is not set. ${HINT}`);

  const url = new URL(raw);
  if (url.protocol !== 'amqp:' && url.protocol !== 'amqps:') {
    throw new Error(`BROKER_URL must be amqp:// or amqps://, got ${url.protocol}//. ${HINT}`);
  }
  if (url.port === MANAGEMENT_PORT) {
    throw new Error(
      `BROKER_URL points at port ${MANAGEMENT_PORT}, which is the management UI and does not ` +
        'speak AMQP. The AMQP listener is 5672.',
    );
  }
  if (url.password === '') url.password = encodeURIComponent(readPassword());

  return url.toString();
}

// For log lines: the address without the credentials in it.
export function brokerAddress(): string {
  const url = new URL(brokerUrl());
  return `${url.protocol}//${url.host}${url.pathname === '' ? '/' : url.pathname}`;
}

export async function connectBroker(clientName: string): Promise<ChannelModel> {
  const connection = await connect(brokerUrl(), {
    clientProperties: { connection_name: clientName },
  });
  // Without a listener an 'error' event is an uncaught exception that takes the
  // process down with a stack trace instead of the broker's reason.
  connection.on('error', (error: Error) => {
    console.error(`[${clientName}] broker connection error: ${error.message}`);
  });
  return connection;
}

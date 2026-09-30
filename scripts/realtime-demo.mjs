import { io } from 'socket.io-client';

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const USER = process.env.DEMO_USER_ID ?? 'u_demo';
const SETTLE_MS = Number(process.env.DEMO_SETTLE_MS ?? 750);
const ACK_TIMEOUT_MS = 5000;

// The control run differs from the main run by these two lines and nothing else:
// the room the second client joins, and therefore what it is expected to hear.
// One code path, two outcomes — a script that printed a constant would fail one.
const SAME_ROOM = process.argv.includes('--same-room');

const log = (...args) => console.error(...args);

async function api(method, path, { body, headers } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function firstProductId() {
  const page = await api('GET', '/products?limit=1');
  if (!page.items?.length) {
    throw new Error('the catalogue is empty — run `npm run migrate && npm run seed` first');
  }
  return page.items[0].id;
}

async function createOrder(productId, label) {
  const order = await api('POST', '/orders', {
    body: { items: [{ product_id: productId, qty: 1 }] },
    headers: {
      'Idempotency-Key': `realtime-demo-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      'X-User-Id': USER,
    },
  });
  log(`  order ${label}: ${order.id} (buyer ${order.buyer_id}, status ${order.status})`);
  return order.id;
}

function connect(userId) {
  const socket = io(BASE, {
    transports: ['websocket'],
    auth: userId === null ? {} : { userId },
    reconnection: false,
  });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no WebSocket connection to ${BASE}`)), ACK_TIMEOUT_MS);
    socket.on('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.on('connect_error', (err) => {
      clearTimeout(timer);
      reject(new Error(`WebSocket connection refused: ${err.message}`));
    });
  });
}

// Resolves with the server's ack, refusal included: a refused join is a result
// the demo asserts on, not an error.
function join(socket, orderId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`join ${orderId} was never acknowledged`)), ACK_TIMEOUT_MS);
    socket.emit('join', { orderId }, (ack) => {
      clearTimeout(timer);
      resolve(ack);
    });
  });
}

function collect(socket) {
  const received = [];
  socket.on('order.status', (event) => received.push(event));
  return received;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  log(`Realtime room-isolation demo → ${BASE}`);
  log(`Mode: ${SAME_ROOM ? 'CONTROL — both clients in order A' : 'MAIN — one client per order'}\n`);

  const productId = await firstProductId();
  const orderA = await createOrder(productId, 'a');
  const orderB = await createOrder(productId, 'b');

  const roomB = SAME_ROOM ? orderA : orderB;
  const expectedB = SAME_ROOM ? 1 : 0;

  log('\n  the ownership guard:');
  const anonymous = await connect(null);
  const anonymousAck = await join(anonymous, orderA);
  log(`    anonymous join   → ${JSON.stringify(anonymousAck)}`);

  const intruder = await connect('u_intruder');
  const intruderAck = await join(intruder, orderA);
  log(`    foreign user     → ${JSON.stringify(intruderAck)}`);

  anonymous.close();
  intruder.close();

  const clientA = await connect(USER);
  const clientB = await connect(USER);
  const eventsA = collect(clientA);
  const eventsB = collect(clientB);

  // Join is acknowledged before the status changes: emitting into a room the
  // client has not entered yet loses the event with no error anywhere.
  const ackA = await join(clientA, orderA);
  const ackB = await join(clientB, roomB);
  log(`\n  client A joined ${JSON.stringify(ackA)}`);
  log(`  client B joined ${JSON.stringify(ackB)}`);

  if (!ackA.ok || !ackB.ok) {
    throw new Error('a client was refused its own order — the demo cannot measure anything');
  }

  log(`\n  PATCH /orders/${orderA}/status {"status":"paid"}`);
  await api('PATCH', `/orders/${orderA}/status`, {
    body: { status: 'paid' },
    headers: { 'X-User-Id': USER },
  });

  await sleep(SETTLE_MS);

  clientA.close();
  clientB.close();

  const aReceived = eventsA.some((e) => e.order_id === orderA) ? 1 : 0;
  const bReceived = eventsB.some((e) => e.order_id === orderA) ? 1 : 0;

  const guardAnonymous = anonymousAck.ok === false && anonymousAck.reason === 'anonymous' ? 1 : 0;
  const guardForeign = intruderAck.ok === false && intruderAck.reason === 'forbidden' ? 1 : 0;

  console.log(`MODE=${SAME_ROOM ? 'same-room' : 'different-rooms'}`);
  console.log(`A_RECEIVED=${aReceived}`);
  console.log(`B_RECEIVED=${bReceived}`);
  console.log(`EXPECTED_B_RECEIVED=${expectedB}`);
  console.log(`GUARD_ANONYMOUS_REFUSED=${guardAnonymous}`);
  console.log(`GUARD_FOREIGN_REFUSED=${guardForeign}`);

  const ok = aReceived === 1 && bReceived === expectedB && guardAnonymous === 1 && guardForeign === 1;
  log(`\n${ok ? 'PASS' : 'FAIL'} — B was expected to ${expectedB ? 'hear' : 'stay silent'}, and it ${bReceived ? 'heard' : 'stayed silent'}.`);
  return ok ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    log(`\nrealtime-demo failed: ${err.message}`);
    log('Is the API up? `npm start`, with Postgres running and seeded.');
    process.exit(1);
  });

'use strict';

const crypto = require('node:crypto');
const { badRequest } = require('./problem');

// ── In-memory дані ───────────────────────────────────────────────────────────
const products = [];
const orders = [];

// Ключі ідемпотентності: `${route}:${key}` -> { fingerprint, status, body }
const idempotency = new Map();

let productSeq = 0;
let orderSeq = 0;

function seed() {
  const catalog = [
    ['Механічна клавіатура', 260000],
    ['Бездротова миша', 89000],
    ['Монітор 27"', 1149900],
    ['USB-C хаб', 45000],
    ['Навушники ANC', 799900],
    ['Веб-камера 1080p', 210000],
    ['Підставка для ноутбука', 68000],
  ];
  for (const [title, price_cents] of catalog) {
    products.push({
      id: `p_${++productSeq}`,
      title,
      price_cents,
      currency: 'UAH',
      created_at: new Date(Date.UTC(2026, 0, productSeq, 10, 0, 0)).toISOString(),
    });
  }
}

// ── Непрозорий курсор ────────────────────────────────────────────────────────
// Формат — деталь реалізації: base64url від "offset:<n>". Клієнт його не парсить.
function encodeCursor(offset) {
  return Buffer.from(`offset:${offset}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor) {
  if (cursor === undefined) return 0;
  let decoded;
  try {
    decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw badRequest('query/cursor is not a valid opaque cursor token');
  }
  const match = /^offset:(\d+)$/.exec(decoded);
  if (!match) throw badRequest('query/cursor is not a valid opaque cursor token');
  return Number(match[1]);
}

/** Сторінка з items + next_cursor (null = сторінок більше немає). */
function paginate(collection, { limit, cursor }) {
  const offset = decodeCursor(cursor);
  const items = collection.slice(offset, offset + limit);
  const nextOffset = offset + items.length;
  const hasMore = nextOffset < collection.length;
  return { items, next_cursor: hasMore ? encodeCursor(nextOffset) : null };
}

// ── Ідемпотентність ──────────────────────────────────────────────────────────
const fingerprint = (body) =>
  crypto.createHash('sha256').update(JSON.stringify(body ?? null)).digest('hex');

const rememberKey = (route, key, body, status, response) =>
  idempotency.set(`${route}:${key}`, { fingerprint: fingerprint(body), status, body: response });

const recallKey = (route, key) => idempotency.get(`${route}:${key}`);

module.exports = {
  products,
  orders,
  seed,
  paginate,
  encodeCursor,
  decodeCursor,
  fingerprint,
  rememberKey,
  recallKey,
  nextProductId: () => `p_${++productSeq}`,
  nextOrderId: () => `o_${++orderSeq}`,
};

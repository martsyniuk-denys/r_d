'use strict';

const path = require('node:path');
const express = require('express');
const OpenApiValidator = require('express-openapi-validator');

const store = require('./store');
const { ProblemError, notFound, idempotencyKeyReuse, TYPE_BASE, TITLES, SLUGS } = require('./problem');

const API_SPEC = path.join(__dirname, '..', 'openapi', 'openapi.yaml');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());

  // ── Кордон: усе, що суперечить openapi.yaml, далі не проходить ─────────────
  // validateRequests  — відхиляє невалідні запити (у т.ч. відсутній Idempotency-Key);
  // validateResponses — не дає застосунку віддати те, чого немає у спеці (drift).
  app.use(
    OpenApiValidator.middleware({
      apiSpec: API_SPEC,
      validateRequests: true,
      validateResponses: true,
      validateApiSpec: true,
    }),
  );

  // ── /products ─────────────────────────────────────────────────────────────
  app.get('/products', (req, res) => {
    const limit = req.query.limit ?? 20;
    res.json(store.paginate(store.products, { limit, cursor: req.query.cursor }));
  });

  app.post('/products', (req, res) => {
    withIdempotency(req, res, 'POST /products', () => {
      const product = {
        id: store.nextProductId(),
        title: req.body.title,
        price_cents: req.body.price_cents,
        currency: req.body.currency,
        created_at: new Date().toISOString(),
      };
      store.products.push(product);
      return product;
    });
  });

  app.get('/products/:productId', (req, res) => {
    const product = store.products.find((p) => p.id === req.params.productId);
    if (!product) throw notFound(`Product '${req.params.productId}' does not exist.`);
    res.json(product);
  });

  // ── /orders ───────────────────────────────────────────────────────────────
  app.get('/orders', (req, res) => {
    const limit = req.query.limit ?? 20;
    res.json(store.paginate(store.orders, { limit, cursor: req.query.cursor }));
  });

  app.post('/orders', (req, res) => {
    withIdempotency(req, res, 'POST /orders', () => {
      // Ціни бере сервер із каталогу — клієнт їх не диктує.
      const lines = req.body.items.map((line) => {
        const product = store.products.find((p) => p.id === line.product_id);
        if (!product) throw notFound(`Product '${line.product_id}' does not exist.`);
        return { product_id: product.id, qty: line.qty, unit_price_cents: product.price_cents };
      });

      const order = {
        id: store.nextOrderId(),
        status: 'created',
        currency: 'UAH',
        items: lines,
        // Гроші — цілі копійки, ніякої плаваючої арифметики.
        total_cents: lines.reduce((sum, l) => sum + l.unit_price_cents * l.qty, 0),
        created_at: new Date().toISOString(),
      };
      store.orders.push(order);
      return order;
    });
  });

  app.get('/orders/:orderId', (req, res) => {
    const order = store.orders.find((o) => o.id === req.params.orderId);
    if (!order) throw notFound(`Order '${req.params.orderId}' does not exist.`);
    res.json(order);
  });

  // ── problem+json для всього, що впало ─────────────────────────────────────
  app.use(problemHandler);

  return app;
}

/**
 * Семантика Idempotency-Key:
 *   той самий ключ + те саме тіло  → та сама відповідь + Idempotency-Replay: true
 *   той самий ключ + інше тіло     → 422 problem+json
 */
function withIdempotency(req, res, route, create) {
  const key = req.headers['idempotency-key']; // валідатор уже гарантував наявність
  const seen = store.recallKey(route, key);

  if (seen) {
    if (seen.fingerprint !== store.fingerprint(req.body)) {
      throw idempotencyKeyReuse(
        `Idempotency-Key '${key}' was already used with a different request body.`,
      );
    }
    res.set('Idempotency-Replay', 'true');
    res.status(seen.status).json(seen.body);
    return;
  }

  const created = create();
  store.rememberKey(route, key, req.body, 201, created);
  res.status(201).json(created);
}

function problemHandler(err, req, res, _next) {
  const status = Number(err.status || err.statusCode || 500);
  const title = err.title || TITLES[status] || 'Error';
  const type = err.type || `${TYPE_BASE}/${SLUGS[status] || 'error'}`;
  // У express-openapi-validator `message` — це вже зібраний детальний опис,
  // напр. "request/headers must have required property 'idempotency-key'".
  const detail = err.detail || err.message || 'Unexpected error.';

  if (status >= 500 && !(err instanceof ProblemError)) {
    console.error('[problem]', status, detail);
  }

  res
    .status(status)
    .type('application/problem+json')
    .json({ type, title, status, detail, instance: req.originalUrl });
}

module.exports = { createApp };

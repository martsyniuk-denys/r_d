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

  // ── The boundary: nothing that contradicts openapi.yaml gets through ──────
  // validateRequests  — rejects invalid requests (a missing Idempotency-Key included);
  // validateResponses — stops the app from serving anything the spec does not describe.
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
      // Prices come from the catalogue on the server — the client does not dictate them.
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
        // Money is integer cents — no floating-point arithmetic anywhere.
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

  // ── problem+json for everything that failed ───────────────────────────────
  app.use(problemHandler);

  return app;
}

/**
 * Idempotency-Key semantics:
 *   same key + same body      → the same response plus Idempotency-Replay: true
 *   same key + different body → 422 problem+json
 */
function withIdempotency(req, res, route, create) {
  const key = req.headers['idempotency-key']; // presence already guaranteed by the validator
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
  // In express-openapi-validator `message` is already the assembled detail,
  // e.g. "request/headers must have required property 'idempotency-key'".
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

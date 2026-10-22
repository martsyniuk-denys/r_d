import { Server } from 'node:http';
import { AddressInfo } from 'node:net';

import express, { Request, Response } from 'express';
import { DataSource } from 'typeorm';

import { placeOrderOnce } from './place-order-once';

// The database-backed checkout at the API edge:
//
//   POST /checkout
//   Idempotency-Key: <client-generated, one per intent>
//   X-User-Id: <buyer id>
//   { "productId": "…", "qty": 1 }
//
// 201 on the request that placed the order, 200 + Idempotency-Replay: true on any
// repeat with the same key, 422 for the same key with a different body. It is a
// bare express app rather than a route of the Nest application: the Nest orders
// resource is the in-memory one of the contract homework, and this endpoint needs
// nothing but a DataSource.

interface CheckoutBody {
  productId?: unknown;
  qty?: unknown;
}

function problem(res: Response, status: number, title: string, detail: string): void {
  res.status(status).type('application/problem+json').json({ type: 'about:blank', title, status, detail });
}

export function checkoutApp(dataSource: DataSource): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());

  app.post('/checkout', async (req: Request, res: Response) => {
    const key = req.header('idempotency-key');
    const buyerId = req.header('x-user-id');
    const body = req.body as CheckoutBody;

    if (key === undefined || key === '') {
      return problem(res, 400, 'Bad Request', 'Idempotency-Key header is required.');
    }
    if (buyerId === undefined || !/^\d+$/.test(buyerId)) {
      return problem(res, 400, 'Bad Request', 'X-User-Id header must be a buyer id.');
    }
    if (typeof body.productId !== 'string' || !/^\d+$/.test(body.productId)) {
      return problem(res, 400, 'Bad Request', 'productId must be a product id.');
    }
    if (!Number.isInteger(body.qty) || (body.qty as number) < 1) {
      return problem(res, 400, 'Bad Request', 'qty must be a positive integer.');
    }

    try {
      const result = await placeOrderOnce(dataSource, {
        idempotencyKey: key,
        command: { buyerId, productId: body.productId, qty: body.qty as number },
      });

      switch (result.kind) {
        case 'created':
          return res.status(201).json({ orderId: result.orderId });
        case 'replayed':
          res.setHeader('Idempotency-Replay', 'true');
          return res.status(200).json({ orderId: result.orderId });
        case 'key-reused':
          return problem(res, 422, 'Unprocessable Content', result.detail);
        case 'rejected':
          return problem(res, 409, 'Conflict', `Checkout declined: ${result.reason}.`);
      }
    } catch (error) {
      return problem(res, 500, 'Internal Server Error', error instanceof Error ? error.message : String(error));
    }
  });

  return app;
}

export async function listen(app: express.Express): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

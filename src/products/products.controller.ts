import { Body, Controller, Get, Headers, Param, Post, Query, Res } from '@nestjs/common';
import { Response } from 'express';

import { IdempotencyService } from '../common/idempotency.service';
import { Page } from '../common/cursor';
import { CreateProduct, Product, ProductsService } from './products.service';

const ROUTE = 'POST /products';

@Controller('products')
export class ProductsController {
  constructor(
    private readonly products: ProductsService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  list(@Query('limit') limit?: string, @Query('cursor') cursor?: string): Page<Product> {
    return this.products.list(Number(limit ?? 20), cursor);
  }

  @Post()
  create(
    @Headers('idempotency-key') key: string,
    @Body() body: CreateProduct,
    @Res({ passthrough: true }) res: Response,
  ): Product {
    const result = this.idempotency.run(ROUTE, key, body, () => this.products.create(body));
    if (result.replayed) res.setHeader('Idempotency-Replay', 'true');
    return result.body;
  }

  @Get(':productId')
  get(@Param('productId') productId: string): Product {
    return this.products.get(productId);
  }
}

import { Module } from '@nestjs/common';

import { IdempotencyService } from './common/idempotency.service';
import { OrdersController } from './orders/orders.controller';
import { OrdersService } from './orders/orders.service';
import { ProductsController } from './products/products.controller';
import { ProductsService } from './products/products.service';

@Module({
  controllers: [ProductsController, OrdersController],
  providers: [ProductsService, OrdersService, IdempotencyService],
})
export class AppModule {}

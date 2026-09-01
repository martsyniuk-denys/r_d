import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { IdempotencyService } from './common/idempotency.service';
import { DatabaseModule } from './db/database.module';
import { HealthController } from './health/health.controller';
import { OrdersController } from './orders/orders.controller';
import { OrdersService } from './orders/orders.service';
import { ProductsController } from './products/products.controller';
import { ProductsService } from './products/products.service';
import { validate } from './config/env.schema';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate,
    }),
    DatabaseModule,
  ],
  controllers: [HealthController, ProductsController, OrdersController],
  providers: [ProductsService, OrdersService, IdempotencyService],
})
export class AppModule {}

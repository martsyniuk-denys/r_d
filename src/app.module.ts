import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { AccessTokenGuard, RolesGuard } from './auth/guards';
import { IdempotencyService } from './common/idempotency.service';
import { DatabaseModule } from './db/database.module';
import { FilesController } from './files/files.controller';
import { FilesService } from './files/files.service';
import { HealthController } from './health/health.controller';
import { OrdersController } from './orders/orders.controller';
import { OrdersService } from './orders/orders.service';
import { ProductsController } from './products/products.controller';
import { ProductsService } from './products/products.service';
import { OrderEventsService } from './realtime/order-events.service';
import { OrdersGateway } from './realtime/orders.gateway';
import { StorageModule } from './storage/storage.module';
import { validate } from './config/env.schema';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate,
    }),
    DatabaseModule,
    StorageModule,
  ],
  controllers: [HealthController, AuthController, ProductsController, OrdersController, FilesController],
  providers: [
    AuthService,
    AccessTokenGuard,
    RolesGuard,
    ProductsService,
    OrdersService,
    IdempotencyService,
    OrderEventsService,
    OrdersGateway,
    FilesService,
  ],
})
export class AppModule {}

import { Body, Controller, Headers, HttpCode, Post, Req } from '@nestjs/common';
import { Request } from 'express';

import { layerLogger } from '../observability/logger';
import { PaymentWebhook, PaymentsService, WebhookReceipt } from './payments.service';
import { SIGNATURE_HEADER } from './signature';

const log = layerLogger('payments.controller');

// The provider calls this, not a user: no bearer token. The signature over the
// raw body is the authentication, and it is checked before the body is trusted.
@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post('webhook')
  @HttpCode(200)
  async webhook(
    @Req() req: Request & { rawBody?: Buffer },
    @Headers(SIGNATURE_HEADER) signature: string | undefined,
    @Body() body: PaymentWebhook,
  ): Promise<WebhookReceipt> {
    log.info({ eventId: body.event_id }, 'webhook received');
    this.payments.authenticate(req.rawBody, signature);
    return this.payments.handle(body);
  }
}

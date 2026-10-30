import { Body, Controller, Get, Headers, HttpCode, Param, Post, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';

import { AccessTokenGuard, CurrentPrincipal } from '../auth/guards';
import { Principal } from '../auth/principal';
import { IdempotencyService } from '../common/idempotency.service';
import { FilesService, FileView, Intent, IntentInput, PartsStatus } from './files.service';

const ROUTE = 'POST /uploads/intent';

interface CommitBody {
  file_id: string;
}

// Every route needs a token: an upload is always somebody's.
@Controller()
@UseGuards(AccessTokenGuard)
export class FilesController {
  constructor(
    private readonly files: FilesService,
    private readonly idempotency: IdempotencyService,
  ) {}

  // A double tap on "upload" sends the same Idempotency-Key twice and gets the same
  // intent back, not a second PENDING row and a second multipart upload.
  @Post('uploads/intent')
  @HttpCode(200)
  async intent(
    @Headers('idempotency-key') key: string,
    @CurrentPrincipal() principal: Principal,
    @Body() body: IntentInput,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Intent> {
    const result = await this.idempotency.run(`${ROUTE}:${principal.userId}`, key, body, () =>
      this.files.intent(principal, body),
    );
    if (result.replayed) res.setHeader('Idempotency-Replay', 'true');
    return result.body;
  }

  @Get('uploads/:fileId/parts')
  parts(@Param('fileId') fileId: string, @CurrentPrincipal() principal: Principal): Promise<PartsStatus> {
    return this.files.parts(principal, fileId);
  }

  @Post('uploads/commit')
  @HttpCode(200)
  commit(@Body() body: CommitBody, @CurrentPrincipal() principal: Principal): Promise<FileView> {
    return this.files.commit(principal, body.file_id);
  }

  @Get('files/:fileId')
  async download(
    @Param('fileId') fileId: string,
    @CurrentPrincipal() principal: Principal,
    @Res() res: Response,
  ): Promise<void> {
    const url = await this.files.downloadUrl(principal, fileId);
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(302, url);
  }
}

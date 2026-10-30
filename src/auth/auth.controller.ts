import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';

import { AuthService, TokenPair } from './auth.service';
import { AccessTokenGuard, CurrentPrincipal } from './guards';
import { Principal } from './principal';

interface LoginBody {
  email: string;
  password: string;
}

interface RefreshBody {
  refresh_token: string;
}

export interface Me {
  user_id: string;
  role: Principal['role'];
  expires_at: string;
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  @HttpCode(200)
  login(@Body() body: LoginBody): Promise<TokenPair> {
    return this.auth.login(body.email, body.password);
  }

  @Post('refresh')
  @HttpCode(200)
  refresh(@Body() body: RefreshBody): Promise<TokenPair> {
    return this.auth.refresh(body.refresh_token);
  }

  // Needs the access token, not the refresh token: the token carries its family
  // (sid), so one bearer header is enough to end both halves of the session.
  @Post('logout')
  @HttpCode(204)
  @UseGuards(AccessTokenGuard)
  async logout(@CurrentPrincipal() principal: Principal): Promise<void> {
    await this.auth.logout(principal);
  }

  @Get('me')
  @UseGuards(AccessTokenGuard)
  me(@CurrentPrincipal() principal: Principal): Me {
    return {
      user_id: principal.userId,
      role: principal.role,
      expires_at: new Date(principal.expiresAt * 1000).toISOString(),
    };
  }
}

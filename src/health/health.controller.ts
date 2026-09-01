import { Controller, Get } from '@nestjs/common';

export interface Health {
  status: 'ok';
  uptime_seconds: number;
  pid: number;
}

@Controller('health')
export class HealthController {
  @Get()
  get(): Health {
    return {
      status: 'ok',
      uptime_seconds: Math.round(process.uptime() * 1000) / 1000,
      pid: process.pid,
    };
  }
}

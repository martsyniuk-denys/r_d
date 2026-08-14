import { Controller } from '../decorators/controller';
import { Get } from '../decorators/methods';

@Controller()
export class HealthController {
  @Get('health')
  check(): { status: string } {
    return { status: 'ok' };
  }
}

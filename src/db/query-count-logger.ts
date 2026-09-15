import { Logger, QueryRunner } from 'typeorm';

export class QueryCountLogger implements Logger {
  count = 0;

  print = false;

  reset(print: boolean): void {
    this.count = 0;
    this.print = print;
  }

  logQuery(query: string, parameters?: unknown[]): void {
    this.count += 1;
    if (!this.print) return;

    const flat = query.replace(/\s+/g, ' ').trim();
    const shown = flat.length > 120 ? `${flat.slice(0, 117)}...` : flat;
    const args = parameters && parameters.length > 0 ? ` -- ${JSON.stringify(parameters)}` : '';
    console.log(`    ${String(this.count).padStart(3, ' ')}  ${shown}${args}`);
  }

  logQueryError(error: string | Error, query: string): void {
    console.error(`[sql error] ${String(error)}\n  ${query}`);
  }

  logQuerySlow(time: number, query: string): void {
    console.warn(`[sql slow ${time}ms] ${query}`);
  }

  logSchemaBuild(): void {}

  logMigration(message: string): void {
    console.log(message);
  }

  log(level: 'log' | 'info' | 'warn', message: unknown, _queryRunner?: QueryRunner): void {
    if (level === 'warn') console.warn(message);
  }
}

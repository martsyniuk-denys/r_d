import { getRequestId } from '../context/request-context';
import { Injectable } from '../decorators/injectable';

export interface AuditEntry {
  requestId: string;
  action: string;
}

@Injectable()
export class AuditService {
  private readonly log: AuditEntry[] = [];

  record(action: string): AuditEntry {
    const entry: AuditEntry = { requestId: getRequestId() ?? 'no-request-context', action };

    this.log.push(entry);

    return entry;
  }

  entries(): readonly AuditEntry[] {
    return this.log;
  }
}

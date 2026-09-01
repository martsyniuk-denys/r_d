import { badRequest } from './problem';

/**
 * Opaque cursor. The format — base64url of "offset:<n>" — is an implementation
 * detail: the spec tells clients not to parse it, so it can change freely.
 */
export function encodeCursor(offset: number): string {
  return Buffer.from(`offset:${offset}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw badRequest('query/cursor is not a valid opaque cursor token');
  }
  const match = /^offset:(\d+)$/.exec(decoded);
  if (!match) throw badRequest('query/cursor is not a valid opaque cursor token');
  return Number(match[1]);
}

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

/** A page of items plus next_cursor (null = no more pages). */
export function paginate<T>(collection: T[], limit: number, cursor?: string): Page<T> {
  const offset = decodeCursor(cursor);
  const items = collection.slice(offset, offset + limit);
  const nextOffset = offset + items.length;
  return { items, next_cursor: nextOffset < collection.length ? encodeCursor(nextOffset) : null };
}

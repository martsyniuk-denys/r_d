import { sign, verify } from '../../src/payments/signature';

describe('webhook signature', () => {
  const secret = 'a'.repeat(64);
  const body = Buffer.from('{"event_id":"evt_1","amount_cents":100}');

  it('accepts the signature of the exact body', () => {
    expect(verify(body, sign(body, secret), secret)).toBe(true);
  });

  it('rejects another key, another body, and a re-serialised body', () => {
    expect(verify(body, sign(body, 'b'.repeat(64)), secret)).toBe(false);
    expect(verify(Buffer.from('{"event_id":"evt_1","amount_cents":101}'), sign(body, secret), secret)).toBe(false);
    // Same JSON, different bytes: the HMAC is over what was sent, not over its meaning.
    expect(verify(Buffer.from('{ "event_id": "evt_1", "amount_cents": 100 }'), sign(body, secret), secret)).toBe(false);
  });

  it('rejects a missing, truncated or differently prefixed header without throwing', () => {
    expect(verify(body, undefined, secret)).toBe(false);
    expect(verify(body, sign(body, secret).slice(0, -1), secret)).toBe(false);
    expect(verify(body, sign(body, secret).replace('sha256=', 'sha1='), secret)).toBe(false);
  });
});

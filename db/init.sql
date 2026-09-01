CREATE SEQUENCE IF NOT EXISTS products_seq;

CREATE TABLE IF NOT EXISTS products (
  id           text        PRIMARY KEY DEFAULT ('p_' || nextval('products_seq')),
  title        text        NOT NULL,
  price_cents  integer     NOT NULL CHECK (price_cents >= 0),
  currency     text        NOT NULL CHECK (currency IN ('UAH', 'USD', 'EUR')),
  created_at   timestamptz NOT NULL DEFAULT now()
);

INSERT INTO products (title, price_cents, currency, created_at) VALUES
  ('Mechanical keyboard',    260000,  'UAH', '2026-01-01T10:00:00Z'),
  ('Wireless mouse',          89000,  'UAH', '2026-01-02T10:00:00Z'),
  ('27" monitor',           1149900,  'UAH', '2026-01-03T10:00:00Z'),
  ('USB-C hub',               45000,  'UAH', '2026-01-04T10:00:00Z'),
  ('ANC headphones',         799900,  'UAH', '2026-01-05T10:00:00Z'),
  ('1080p webcam',           210000,  'UAH', '2026-01-06T10:00:00Z'),
  ('Laptop stand',            68000,  'UAH', '2026-01-07T10:00:00Z')
ON CONFLICT DO NOTHING;

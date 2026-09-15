-- Marketplace data layer — tables, constraints, generated search vector.
-- Applies to a clean database in one command:
--   docker compose exec -T postgres psql -U marketplace -d marketplace -f /dev/stdin < db/schema.sql
-- Re-runnable: every object is dropped first.

DROP TABLE IF EXISTS order_items CASCADE;
DROP TABLE IF EXISTS orders CASCADE;
DROP TABLE IF EXISTS products CASCADE;
DROP TABLE IF EXISTS users CASCADE;

-- Sellers and buyers. Email is stored as written, matched case-insensitively
-- (see idx_users_email_lower in db/indexes.sql).
CREATE TABLE users (
  id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email        text        NOT NULL UNIQUE,
  display_name text        NOT NULL CHECK (length(display_name) > 0),
  country      text        NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Catalogue. Money is numeric — never float, never a decimal string.
CREATE TABLE products (
  id          bigint         GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  seller_id   bigint         NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  name        text           NOT NULL CHECK (length(name) > 0),
  description text           NOT NULL DEFAULT '',
  price       numeric(12, 2) NOT NULL CHECK (price >= 0),
  currency    text           NOT NULL CHECK (currency IN ('UAH', 'USD', 'EUR')),
  status      text           NOT NULL CHECK (status IN ('draft', 'active', 'archived')),
  created_at  timestamptz    NOT NULL DEFAULT now(),

  -- Maintained by Postgres on every INSERT and UPDATE: no trigger, no application
  -- code, and no way for the index to drift from the row it describes.
  search_vector tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', name || ' ' || description)
  ) STORED
);

CREATE TABLE orders (
  id         bigint         GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  buyer_id   bigint         NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  status     text           NOT NULL CHECK (status IN ('pending', 'paid', 'shipped', 'cancelled', 'refunded')),
  total      numeric(12, 2) NOT NULL CHECK (total >= 0),
  currency   text           NOT NULL CHECK (currency IN ('UAH', 'USD', 'EUR')),
  created_at timestamptz    NOT NULL DEFAULT now()
);

CREATE TABLE order_items (
  id         bigint         GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id   bigint         NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  product_id bigint         NOT NULL REFERENCES products (id) ON DELETE RESTRICT,
  qty        integer        NOT NULL CHECK (qty > 0),
  unit_price numeric(12, 2) NOT NULL CHECK (unit_price >= 0),

  UNIQUE (order_id, product_id)
);

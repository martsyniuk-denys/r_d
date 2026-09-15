-- The minimal set that cures q1..q4. Nothing is created "just in case": every
-- index below is the one a specific query's plan names, and an index that no
-- query uses is pure cost — disk plus a slower INSERT.

-- q1: a buyer's orders inside a period. Composite, buyer first (equality), then
-- the range/sort column, so the index also delivers the ORDER BY for free.
CREATE INDEX idx_orders_buyer_created_at
  ON orders (buyer_id, created_at DESC);

-- q2: refunds are 1.5% of the table. A PARTIAL index stores only those rows, so
-- it is a fraction of the size of a full index on status and never has to carry
-- the 98.5% of orders this query will never look at.
CREATE INDEX idx_orders_refunded_created_at
  ON orders (created_at DESC)
  WHERE status = 'refunded';

-- q3: the lookup is case-insensitive, so a plain index on email is unusable —
-- the planner cannot see through lower(). An EXPRESSION index stores exactly
-- what the query computes.
CREATE INDEX idx_users_email_lower
  ON users (lower(email));

-- q4: full-text search over the generated tsvector column. GIN, not B-tree:
-- a B-tree indexes whole values, while GIN indexes every lexeme inside them.
CREATE INDEX idx_products_search_vector
  ON products USING GIN (search_vector);

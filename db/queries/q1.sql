SELECT id, status, total, created_at
FROM orders
WHERE buyer_id = 42
  AND created_at >= timestamptz '2026-01-01'
  AND created_at <  timestamptz '2026-04-01'
ORDER BY created_at DESC
LIMIT 20

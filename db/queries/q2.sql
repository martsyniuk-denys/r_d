SELECT id, buyer_id, total, created_at
FROM orders
WHERE status = 'refunded'
  AND created_at >= timestamptz '2026-06-01'
ORDER BY created_at DESC
LIMIT 50

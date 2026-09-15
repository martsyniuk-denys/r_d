-- Realistic volume for the Marketplace data layer.
--   users        20 000
--   products    120 000   (the table q4 searches)
--   orders      150 000   (the main table)
--   order_items ~300 000
--
-- Distributions are deliberately skewed, the way real marketplaces are: most
-- orders are paid, refunds are rare, and a small group of buyers places a
-- disproportionate share of the orders. A uniform 33/33/33 would let the planner
-- make choices it would never make on production data.
--
-- Catalogue text is Ukrainian on purpose: the full-text part of this homework
-- (q4 and the morphology section of OPTIMIZATIONS.md) has nothing to show on
-- transliterated names.

TRUNCATE order_items, orders, products, users RESTART IDENTITY CASCADE;

INSERT INTO users (email, display_name, country, created_at)
SELECT
  'user' || g || '@' || (ARRAY['example.com', 'mail.example', 'shop.example'])[1 + g % 3],
  (ARRAY['Олена', 'Андрій', 'Марія', 'Дмитро', 'Софія', 'Іван', 'Наталія', 'Тарас'])[1 + g % 8]
    || ' ' ||
  (ARRAY['Коваленко', 'Шевченко', 'Бондаренко', 'Ткаченко', 'Мельник', 'Кравчук'])[1 + g % 6],
  (ARRAY['UA', 'UA', 'UA', 'UA', 'PL', 'DE', 'US'])[1 + g % 7],
  timestamptz '2024-01-01' + (g % 700) * interval '1 day'
FROM generate_series(1, 20000) AS g;

-- Nouns and adjectives repeat inside the arrays to create the skew: 'Кросівки'
-- and 'шкіряні' are three entries out of twenty each, so roughly 15% of the
-- catalogue carries either word and ~2% carries both — which is what keeps q4
-- selective enough for the planner to prefer the index over a sequential scan.
INSERT INTO products (seller_id, name, description, price, currency, status, created_at)
SELECT
  1 + (g % 20000),
  noun || ' ' || adj || ' ' || brand || ' модель ' || (1000 + g % 9000),
  'Якісні ' || lower(noun) || ' ' || adj || ' для щоденного використання. Матеріал: '
    || material || '. Розмір: ' || (35 + g % 12)
    || '. Доставка по всій Україні, обмін протягом 14 днів.',
  round((150 + random() * random() * 9850)::numeric, 2),
  'UAH',
  CASE
    WHEN r_status < 0.85 THEN 'active'
    WHEN r_status < 0.97 THEN 'draft'
    ELSE 'archived'
  END,
  timestamptz '2024-06-01' + power(random(), 0.6) * interval '820 days'
FROM (
  SELECT
    g,
    (ARRAY['Кросівки','Кросівки','Кросівки','Черевики','Черевики','Чоботи','Чоботи','Сандалі',
           'Кеди','Кеди','Босоніжки','Капці','Рукавички','Рукавички','Окуляри','Навушники',
           'Навушники','Джинси','Джинси','Шкарпетки'])[1 + floor(random() * 20)::int] AS noun,
    (ARRAY['шкіряні','шкіряні','шкіряні','замшеві','замшеві','спортивні','спортивні','спортивні',
           'зимові','зимові','літні','літні','класичні','класичні','дитячі','дитячі',
           'чоловічі','чоловічі','жіночі','туристичні'])[1 + floor(random() * 20)::int] AS adj,
    (ARRAY['Лідер','Комфорт','Стиль','Практик','Гарант'])[1 + floor(random() * 5)::int] AS brand,
    (ARRAY['натуральна шкіра','замша','текстиль','нубук','сітка'])[1 + floor(random() * 5)::int] AS material,
    random() AS r_status
  FROM generate_series(1, 120000) AS g
) AS src;

INSERT INTO orders (buyer_id, status, total, currency, created_at)
SELECT
  CASE WHEN r_buyer < 0.30 THEN 1 + floor(random() * 200)::bigint
       ELSE 201 + floor(random() * 19800)::bigint END,
  CASE
    WHEN r_status < 0.680 THEN 'paid'
    WHEN r_status < 0.860 THEN 'shipped'
    WHEN r_status < 0.950 THEN 'pending'
    WHEN r_status < 0.985 THEN 'cancelled'
    ELSE 'refunded'
  END,
  0,
  'UAH',
  timestamptz '2025-01-01' + power(random(), 0.6) * interval '610 days'
FROM (
  SELECT random() AS r_buyer, random() AS r_status
  FROM generate_series(1, 150000)
) AS src;

-- One to three distinct products per order. The offsets differ by a constant that
-- is coprime with the catalogue size, so the UNIQUE (order_id, product_id)
-- constraint never fires.
INSERT INTO order_items (order_id, product_id, qty, unit_price)
SELECT o.id, p.id, 1 + (o.id + i) % 3, p.price
FROM orders AS o
CROSS JOIN LATERAL generate_series(1, 1 + (o.id % 3)) AS i
JOIN products AS p ON p.id = 1 + ((o.id * 7919 + i * 104729) % 120000);

UPDATE orders AS o
SET total = agg.total
FROM (
  SELECT order_id, sum(qty * unit_price) AS total
  FROM order_items
  GROUP BY order_id
) AS agg
WHERE agg.order_id = o.id;

-- ANALYZE alone gives the planner statistics, but only VACUUM sets the visibility
-- map — and without it an Index Only Scan still visits the heap (Heap Fetches in
-- the plan), which ruins the buffer numbers this homework is measuring.
VACUUM (ANALYZE);

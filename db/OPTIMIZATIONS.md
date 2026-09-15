# Оптимізації дата-шару

Усі числа зняті на цій машині (Docker Desktop, `postgres:16-alpine`, 120 000 товарів /
150 000 замовлень / 300 000 позицій) рівно в тому порядку, у якому їх відтворює грейдер:

```
docker compose down -v && docker compose up -d --wait
psql -f db/schema.sql
psql -f db/seed.sql          # завершується VACUUM (ANALYZE)
EXPLAIN (ANALYZE, BUFFERS)   # «до» — чотири Seq Scan
psql -f db/indexes.sql
psql -c "ANALYZE;"
EXPLAIN (ANALYZE, BUFFERS)   # «після»
```

Кожен запит прогнано тричі й узято останній прогін — і «до», і «після». Перший виклик q4
одразу після `CREATE INDEX` іде по холодному GIN і дає число в рази гірше за справжнє.

## Підсумок

| Запит | Execution Time до | після | Прискорення | Buffers до | після | Індекс у плані |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| q1 | 8.201 ms | 0.131 ms | **63×** | 2641 | 25 | `idx_orders_buyer_created_at` |
| q2 | 9.842 ms | 0.196 ms | **50×** | 2607 | 52 | `idx_orders_refunded_created_at` |
| q3 | 5.540 ms | 0.050 ms | **111×** | 250 | 3 | `idx_users_email_lower` |
| q4 | 31.346 ms | 6.577 ms | **5×** | 12018 | 2535 | `idx_products_search_vector` |

## q1 — замовлення покупця за період

```sql
SELECT id, status, total, created_at
FROM orders
WHERE buyer_id = 42
  AND created_at >= timestamptz '2026-01-01'
  AND created_at <  timestamptz '2026-04-01'
ORDER BY created_at DESC
LIMIT 20
```

### До індексів

```
                                                                                         QUERY PLAN                                                                                         
--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
 Limit  (cost=5148.71..5151.01 rows=20 width=29) (actual time=6.783..8.154 rows=20 loops=1)
   Buffers: shared hit=2641
   ->  Gather Merge  (cost=5148.71..5151.58 rows=25 width=29) (actual time=6.782..8.144 rows=20 loops=1)
         Workers Planned: 1
         Workers Launched: 1
         Buffers: shared hit=2641
         ->  Sort  (cost=4148.70..4148.76 rows=25 width=29) (actual time=5.606..5.607 rows=16 loops=2)
               Sort Key: created_at DESC
               Sort Method: quicksort  Memory: 26kB
               Buffers: shared hit=2641
               Worker 0:  Sort Method: quicksort  Memory: 26kB
               ->  Parallel Seq Scan on orders  (cost=0.00..4148.12 rows=25 width=29) (actual time=1.322..5.541 rows=24 loops=2)
                     Filter: ((created_at >= '2026-01-01 00:00:00+00'::timestamp with time zone) AND (created_at < '2026-04-01 00:00:00+00'::timestamp with time zone) AND (buyer_id = 42))
                     Rows Removed by Filter: 74976
                     Buffers: shared hit=2604
 Planning:
   Buffers: shared hit=97
 Planning Time: 0.395 ms
 Execution Time: 8.201 ms
(19 rows)
```

### Після індексів

```
                                                                                     QUERY PLAN                                                                                     
------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
 Limit  (cost=0.42..82.57 rows=20 width=29) (actual time=0.033..0.106 rows=20 loops=1)
   Buffers: shared hit=25
   ->  Index Scan using idx_orders_buyer_created_at on orders  (cost=0.42..193.48 rows=47 width=29) (actual time=0.032..0.103 rows=20 loops=1)
         Index Cond: ((buyer_id = 42) AND (created_at >= '2026-01-01 00:00:00+00'::timestamp with time zone) AND (created_at < '2026-04-01 00:00:00+00'::timestamp with time zone))
         Buffers: shared hit=25
 Planning:
   Buffers: shared hit=136
 Planning Time: 0.482 ms
 Execution Time: 0.131 ms
(9 rows)
```

У план став **`idx_orders_buyer_created_at`** — вузлом `Index Scan using idx_orders_buyer_created_at on orders`.

Зник `Parallel Seq Scan`, а разом із ним і `Sort`. Колонки в індексі стоять у порядку «спершу
рівність (`buyer_id`), потім діапазон і сортування (`created_at DESC`)», тому індекс віддає рядки
вже впорядкованими, і `LIMIT 20` забирає перші двадцять, не читаючи решту. Постгресу більше не
треба зачитувати всю таблицю двома воркерами й відкидати 74 976 рядків —
`Rows Removed by Filter` зникає з плану взагалі. Buffers упали з 2641 до 25:
замість сторінок усієї таблиці читаються сторінки індексу та ті кілька сторінок купи, де реально
лежать потрібні замовлення.

## q2 — повернення за останні місяці

```sql
SELECT id, buyer_id, total, created_at
FROM orders
WHERE status = 'refunded'
  AND created_at >= timestamptz '2026-06-01'
ORDER BY created_at DESC
LIMIT 50
```

### До індексів

```
                                                         QUERY PLAN                                                         
----------------------------------------------------------------------------------------------------------------------------
 Limit  (cost=4870.54..4870.67 rows=50 width=31) (actual time=9.797..9.804 rows=50 loops=1)
   Buffers: shared hit=2607
   ->  Sort  (cost=4870.54..4871.79 rows=498 width=31) (actual time=9.796..9.799 rows=50 loops=1)
         Sort Key: created_at DESC
         Sort Method: top-N heapsort  Memory: 31kB
         Buffers: shared hit=2607
         ->  Seq Scan on orders  (cost=0.00..4854.00 rows=498 width=31) (actual time=1.745..9.697 rows=553 loops=1)
               Filter: ((created_at >= '2026-06-01 00:00:00+00'::timestamp with time zone) AND (status = 'refunded'::text))
               Rows Removed by Filter: 149447
               Buffers: shared hit=2604
 Planning:
   Buffers: shared hit=100
 Planning Time: 0.334 ms
 Execution Time: 9.842 ms
(14 rows)
```

### Після індексів

```
                                                                     QUERY PLAN                                                                     
----------------------------------------------------------------------------------------------------------------------------------------------------
 Limit  (cost=0.28..184.33 rows=50 width=31) (actual time=0.023..0.169 rows=50 loops=1)
   Buffers: shared hit=52
   ->  Index Scan using idx_orders_refunded_created_at on orders  (cost=0.28..1925.43 rows=523 width=31) (actual time=0.023..0.163 rows=50 loops=1)
         Index Cond: (created_at >= '2026-06-01 00:00:00+00'::timestamp with time zone)
         Buffers: shared hit=52
 Planning:
   Buffers: shared hit=136
 Planning Time: 0.504 ms
 Execution Time: 0.196 ms
(9 rows)
```

У план став **`idx_orders_refunded_created_at`** — вузлом `Index Scan using idx_orders_refunded_created_at on orders`.

Це partial-індекс: у ньому лежать тільки рядки зі `status = 'refunded'` — 1.5% таблиці. Тому умова
по статусу взагалі зникла з `Index Cond`, де лишилося саме `created_at >= ...`: належність до статусу
гарантована вже тим фактом, що рядок є в індексі. `Seq Scan` із `Rows Removed by Filter:
149 447` і наступний `Sort` зникли, buffers — з 2607 до 52.
Повний індекс по `(status, created_at)` дав би той самий план, але зберігав би ще й 98.5% замовлень,
яких цей запит ніколи не торкається.

## q3 — пошук користувача за e-mail без урахування регістру

```sql
SELECT id, email, display_name, country, created_at
FROM users
WHERE lower(email) = lower('User13579@Mail.Example')
```

### До індексів

```
                                             QUERY PLAN                                             
----------------------------------------------------------------------------------------------------
 Seq Scan on users  (cost=0.00..550.00 rows=100 width=70) (actual time=3.738..5.511 rows=1 loops=1)
   Filter: (lower(email) = 'user13579@mail.example'::text)
   Rows Removed by Filter: 19999
   Buffers: shared hit=250
 Planning:
   Buffers: shared hit=90
 Planning Time: 0.331 ms
 Execution Time: 5.540 ms
(8 rows)
```

### Після індексів

```
                                                          QUERY PLAN                                                          
------------------------------------------------------------------------------------------------------------------------------
 Index Scan using idx_users_email_lower on users  (cost=0.29..8.30 rows=1 width=70) (actual time=0.016..0.016 rows=1 loops=1)
   Index Cond: (lower(email) = 'user13579@mail.example'::text)
   Buffers: shared hit=3
 Planning:
   Buffers: shared hit=110
 Planning Time: 0.428 ms
 Execution Time: 0.050 ms
(7 rows)
```

У план став **`idx_users_email_lower`** — вузлом `Index Scan using idx_users_email_lower on users`.

Це expression-індекс. Звичайний індекс по `email` тут марний: планер не має права зазирнути всередину
`lower()` і мусить обчислити функцію для кожного рядка — саме тому «до» стоїть `Seq Scan` із
`Rows Removed by Filter: 19 999`. Індекс зберігає вже обчислений `lower(email)`,
тобто рівно те, що стоїть у `WHERE`, і пошук стає точковим: 3 buffers замість 250.

## q4 — повнотекстовий пошук по каталогу

```sql
SELECT id, name, ts_rank(search_vector, plainto_tsquery('simple', 'шкіряні кросівки')) AS rank
FROM products
WHERE search_vector @@ plainto_tsquery('simple', 'шкіряні кросівки')
ORDER BY rank DESC, id
LIMIT 20
```

### До індексів

```
                                                        QUERY PLAN                                                        
--------------------------------------------------------------------------------------------------------------------------
 Limit  (cost=13589.26..13589.31 rows=20 width=73) (actual time=31.308..31.311 rows=20 loops=1)
   Buffers: shared hit=10163 read=1855
   ->  Sort  (cost=13589.26..13595.89 rows=2654 width=73) (actual time=31.306..31.308 rows=20 loops=1)
         Sort Key: (ts_rank(search_vector, '''шкіряні'' & ''кросівки'''::tsquery)) DESC, id
         Sort Method: top-N heapsort  Memory: 27kB
         Buffers: shared hit=10163 read=1855
         ->  Seq Scan on products  (cost=0.00..13518.64 rows=2654 width=73) (actual time=0.122..30.922 rows=2765 loops=1)
               Filter: (search_vector @@ '''шкіряні'' & ''кросівки'''::tsquery)
               Rows Removed by Filter: 117235
               Buffers: shared hit=10157 read=1855
 Planning:
   Buffers: shared hit=96
 Planning Time: 0.341 ms
 Execution Time: 31.346 ms
(14 rows)
```

### Після індексів

```
                                                                      QUERY PLAN                                                                      
------------------------------------------------------------------------------------------------------------------------------------------------------
 Limit  (cost=6564.88..6564.93 rows=20 width=73) (actual time=6.508..6.511 rows=20 loops=1)
   Buffers: shared hit=2535
   ->  Sort  (cost=6564.88..6571.60 rows=2688 width=73) (actual time=6.506..6.508 rows=20 loops=1)
         Sort Key: (ts_rank(search_vector, '''шкіряні'' & ''кросівки'''::tsquery)) DESC, id
         Sort Method: top-N heapsort  Memory: 27kB
         Buffers: shared hit=2535
         ->  Bitmap Heap Scan on products  (cost=35.63..6493.35 rows=2688 width=73) (actual time=1.961..6.133 rows=2765 loops=1)
               Recheck Cond: (search_vector @@ '''шкіряні'' & ''кросівки'''::tsquery)
               Heap Blocks: exact=2512
               Buffers: shared hit=2529
               ->  Bitmap Index Scan on idx_products_search_vector  (cost=0.00..34.96 rows=2688 width=0) (actual time=1.702..1.702 rows=2765 loops=1)
                     Index Cond: (search_vector @@ '''шкіряні'' & ''кросівки'''::tsquery)
                     Buffers: shared hit=17
 Planning:
   Buffers: shared hit=121
 Planning Time: 0.510 ms
 Execution Time: 6.577 ms
(17 rows)
```

У план став **`idx_products_search_vector`** — вузлом `Bitmap Index Scan on idx_products_search_vector`.

`Seq Scan`, який перевіряв `search_vector @@ tsquery` для всіх 120 000 товарів і відкидав
117 235 з них, замінився парою `Bitmap Index Scan` → `Bitmap Heap Scan`. Сам похід
у GIN коштує **121 buffers** — проти 12018 сторінок, які «до» перечитував послідовний скан.

Прискорення тут 4.8×, а не «десятки разів», і це чесне число, яке варто вміти
пояснити. Після індексу час запиту визначає вже не пошук, а `Bitmap Heap Scan`, якому треба підняти
2765 знайдених рядків, розкиданих по 2512 сторінках купи (`Heap Blocks: exact=2512`).
Індексна частина прискорилась у сотні разів, і впиратися далі нема в що: ці рядки потрібні фізично, бо
`ts_rank` рахується по `search_vector` кожного з них, а GIN не вміє Index Only Scan.

## Ціна збереженої tsvector-колонки

Згенерована колонка не безкоштовна, і це нормальна ціна, яку треба вміти назвати вголос.
Заміряно на цій же базі:

| | Розмір таблиці `products` | Вставка 20 000 рядків |
| --- | ---: | ---: |
| без `search_vector` | 45 MB | 13.4 ms |
| зі `search_vector` | 93 MB | 230.7 ms |

Таблиця роздувається вдвічі (47194112 → 98402304 байтів), вставка сповільнюється
приблизно у 17 разів. Сам GIN-індекс поверх неї — ще
5064 kB. Взамін пошук по каталогу перестає бути послідовним читанням усієї таблиці.
Для каталогу, який читають значно частіше, ніж пишуть, розмін вигідний; для таблиці з інтенсивним
записом це вже предмет окремого рішення.

## Морфологія

Пошук знаходить товар за словом у тій формі, у якій воно записане в назві, і не знаходить той
самий товар за іншим відмінком того ж слова. Числа з цієї бази (120 000 товарів):

| Запит | Форма | Збігів |
| --- | --- | ---: |
| `plainto_tsquery('simple', 'кросівки')` | називний відмінок, як у каталозі | 17951 |
| `plainto_tsquery('simple', 'кросівок')` | родовий відмінок того ж слова | 0 |

Причина в тому, що конфігурація `simple` не робить стемінгу взагалі: вона лише переводить слово в
нижній регістр і кладе його в індекс як є, тому `'кросівки'` і `'кросівок'` — це дві різні лексеми,
а не дві форми однієї. Видно це прямо в розборі: `to_tsvector('simple', 'Кросівки шкіряні')` дає
`'кросівки':1 'шкіряні':2`, а `to_tsvector('simple', 'кросівок шкіряних')` дає
`'кросівок':1 'шкіряних':2` — жодного спільного елемента.

Підміною `simple` на іншу вбудовану конфігурацію це не лікується: `SELECT count(*) FROM pg_ts_config`
на цьому сервері повертає 29 конфігурацій, і серед них немає жодної української —
`SELECT count(*) FROM pg_ts_config WHERE cfgname ILIKE '%ukrain%'` дає 0. Взяти замість неї
`russian` — не фікс, а самообман: чужий стемер розбиратиме українські закінчення за своїми правилами
й даватиме і хибні збіги, і пропуски, причому мовчки.

Той самий розрив видно й на матеріалі: слово «шкіра» в описах дає 24141 збігів, а «шкіряні»
в назвах — 17862, хоча для покупця це одне поняття. Реальне рішення — словник (`ispell` з
українським словником або `unaccent` плюс власний `synonym`-словник), і саме тут закінчується те, що
Postgres дає «з коробки»: за цією межею починається окремий пошуковий рушій.

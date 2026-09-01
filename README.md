# Marketplace API — ДЗ-09: контракт першим

Обраний варіант contract-частини: **Б — runtime-валідація на кордоні**
(`express` + `express-openapi-validator`).

Спека `openapi/openapi.yaml` — це не документація «поруч із кодом», а джерело правди,
проти якого валідатор перевіряє **і запити, і відповіді**. Усе, що суперечить спеці,
не проходить кордон: невалідний запит відхиляється до хендлера (400), а відповідь,
яка розійшлася зі схемою, не доїжджає до клієнта (500 замість тихого дрейфу).

## Швидкий старт

```bash
npm install
npm start          # http://localhost:3000
```

## Команди

| Команда | Що робить |
| --- | --- |
| `npm start` | піднімає застосунок із валідатором на порті 3000 (`PORT=3001 npm start` — інший порт) |
| `npm run lint` | `redocly lint openapi/openapi.yaml` |
| `npm run bundle` | `redocly bundle openapi/openapi.yaml -o spec.json` |
| `npm run check` | усі acceptance-критерії по спеці (пункти 1–4) одним прогоном |
| `npm run smoke` | усі acceptance-критерії варіанта Б + додатковий виклик, на живому застосунку |

`npm run check` і `npm run smoke` — це та сама перевірка, що й «сирі» команди нижче,
просто зібрана в один запуск із читабельним виводом.

## Що є у спеці

**2 ресурси, 6 операцій:**

| Операція | `operationId` |
| --- | --- |
| `GET /products` | `listProducts` |
| `POST /products` | `createProduct` |
| `GET /products/{productId}` | `getProduct` |
| `GET /orders` | `listOrders` |
| `POST /orders` | `createOrder` |
| `GET /orders/{orderId}` | `getOrder` |

* **Cursor-пагінація** — на обох спискових операціях: query `limit` (1..100, default 20)
  і `cursor`. Відповідь — `{ items, next_cursor }`, де `next_cursor: null` означає,
  що сторінок більше немає. Курсор непрозорий: у реалізації це base64url від
  `offset:<n>`, але це деталь реалізації, і клієнт не має права її розбирати.
* **Idempotency-Key** — header-параметр із `required: true` на обох POST-операціях.
  Саме `required: true` дає валідатору право вимагати заголовок замість `if` у коді.
* **problem+json** — кожна 4xx/5xx-відповідь віддається як `application/problem+json`
  зі схемою `Problem` (`type`, `title`, `status`, `detail`, `instance` — усі обовʼязкові).
* **Гроші — цілі копійки:** `price_cents`, `unit_price_cents`, `total_cents` — `integer`.
  Жодних float і жодних decimal-рядків на кшталт `"2600.00"`.

Авторизації в API поки свідомо немає, тому на корені стоїть явний `security: []` —
без нього redocly-правило `security-defined` дає error і `lint` завершується з exit 1.

## Перевірка acceptance criteria «сирими» командами

### 1. Спека валідна (exit code 0)

```bash
npx @redocly/cli lint openapi/openapi.yaml
echo $?   # 0
```

Одне попередження (`no-server-example.com` на `http://localhost:3000`) — очікуване:
warnings дозволені, errors — ні.

### 2. Обсяг спеки

```bash
npx @redocly/cli bundle openapi/openapi.yaml -o spec.json

node -e "const s=require('./spec.json'),M=['get','post','put','patch','delete'];\
const ops=Object.entries(s.paths).flatMap(([p,v])=>Object.keys(v).filter(m=>M.includes(m)).map(m=>[p,m]));\
const idem=ops.flatMap(([p,m])=>s.paths[p][m].parameters??[]).find(x=>x.in==='header'&&/idempotency-key/i.test(x.name));\
console.log('операцій:',ops.length,'· ресурсів:',new Set(Object.keys(s.paths).map(p=>p.split('/')[1])).size);\
console.log('Idempotency-Key: required =',idem?.required,'· опис, символів =',(idem?.description??'').trim().length)"
```

Фактичний вивід:

```
операцій: 6 · ресурсів: 2
Idempotency-Key: required = true · опис, символів = 405
```

Параметри навмисно записані в операціях inline, а не через
`$ref: '#/components/parameters/...'`: `redocly bundle` зберігає `$ref` у результаті,
і перевірка вище тоді побачила б `{ $ref: ... }` замість `in`/`name`/`required`.

### 3–5. Grep-критерії

```bash
grep -c 'Idempotency-Key' openapi/openapi.yaml          # 8  (≥ 1)
grep -c 'next_cursor' openapi/openapi.yaml              # 8  (≥ 1)
grep -c 'application/problem+json' openapi/openapi.yaml # 7  (≥ 2)
```

### 6. Contract-частина працює (варіант Б)

Підняти сервер: `npm start`. Далі, в іншому терміналі:

**Без `Idempotency-Key` → 400 `application/problem+json`** (заголовок вимагає спека, а не `if` у коді):

```bash
curl -i -X POST localhost:3000/orders \
  -H 'Content-Type: application/json' \
  -d '{"items":[{"product_id":"p_1","qty":2}]}'
```

```
HTTP/1.1 400 Bad Request
Content-Type: application/problem+json; charset=utf-8

{"type":"https://marketplace.example/problems/validation-error","title":"Bad Request",
 "status":400,"detail":"request/headers must have required property 'idempotency-key'",
 "instance":"/orders"}
```

`detail` каже `'idempotency-key'` з маленької літери: валідатор шукає header-параметри
у `req.headers`, а Node приводить імена заголовків до lowercase. У спеці при цьому
заголовок записаний як заведено — `Idempotency-Key`.

**Невалідне тіло (порожній `items`) → 400 з деталлю від валідатора:**

```bash
curl -i -X POST localhost:3000/orders \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: 6f1f8f4e-4d4b-4a53-9a0e-2c1f0b7a1c11' \
  -d '{"items":[]}'
```

```
HTTP/1.1 400 Bad Request
detail: "request/body/items must NOT have fewer than 1 items"
```

**Валідний запит → 201:**

```bash
curl -i -X POST localhost:3000/orders \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: 6f1f8f4e-4d4b-4a53-9a0e-2c1f0b7a1c11' \
  -d '{"items":[{"product_id":"p_1","qty":2}]}'
```

```
HTTP/1.1 201 Created

{"id":"o_1","status":"created","currency":"UAH",
 "items":[{"product_id":"p_1","qty":2,"unit_price_cents":260000}],
 "total_cents":520000,"created_at":"..."}
```

## Додатковий виклик: повна семантика Idempotency-Key

**Той самий ключ + те саме тіло → той самий 201 + `Idempotency-Replay: true`**
(нового замовлення не створюється, повертається те саме `id`):

```bash
curl -i -X POST localhost:3000/orders \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: 6f1f8f4e-4d4b-4a53-9a0e-2c1f0b7a1c11' \
  -d '{"items":[{"product_id":"p_1","qty":2}]}'
```

```
HTTP/1.1 201 Created
Idempotency-Replay: true
```

**Той самий ключ + інше тіло → 422 `application/problem+json`:**

```bash
curl -i -X POST localhost:3000/orders \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: 6f1f8f4e-4d4b-4a53-9a0e-2c1f0b7a1c11' \
  -d '{"items":[{"product_id":"p_2","qty":9}]}'
```

```
HTTP/1.1 422 Unprocessable Entity
Content-Type: application/problem+json; charset=utf-8

{"type":"https://marketplace.example/problems/idempotency-key-reuse",
 "title":"Unprocessable Entity","status":422,
 "detail":"Idempotency-Key '6f1f8f4e-...' was already used with a different request body.",
 "instance":"/orders"}
```

Тіло запиту порівнюється за sha256-відбитком, ключі зберігаються окремо для кожного
маршруту (`POST /orders` і `POST /products` не конфліктують між собою).

## Cursor-пагінація в дії

```bash
curl -s 'localhost:3000/products?limit=3'
# {"items":[p_1,p_2,p_3],"next_cursor":"b2Zmc2V0OjM"}

curl -s 'localhost:3000/products?limit=3&cursor=b2Zmc2V0OjM'
# {"items":[p_4,p_5,p_6],"next_cursor":"b2Zmc2V0OjY"}

curl -s 'localhost:3000/products?limit=100'
# {"items":[...усі 7...],"next_cursor":null}   ← сторінок більше немає
```

## Чому `validateResponses: true`

Спека сама по собі нічого не примушує. Кордон примушує в обидва боки:

```js
OpenApiValidator.middleware({
  apiSpec: 'openapi/openapi.yaml',
  validateRequests: true,   // невалідний запит не доходить до хендлера
  validateResponses: true,  // невалідна відповідь не доходить до клієнта
})
```

Перевірено на живому дрейфі: якщо в хендлері `POST /orders` перейменувати
`total_cents` → `totalCents` (класична помилка при рефакторингу), застосунок віддає
не «майже правильний» 201, а:

```
HTTP/1.1 500 Internal Server Error
{"type":"https://marketplace.example/problems/internal-server-error",
 "title":"Internal Server Error","status":500,
 "detail":"/response must have required property 'total_cents'","instance":"/orders"}
```

Це рантайм-аналог `contract/check.mjs` із лекції, який ловив `DRIFT=1`.

## Структура

```
openapi/openapi.yaml   спека: 2 ресурси, 6 операцій, cursor-пагінація,
                       Idempotency-Key, problem+json
src/app.js             express-застосунок: валідатор на кордоні + хендлери
src/server.js          точка входу (npm start)
src/store.js           in-memory дані, курсор, сховище ключів ідемпотентності
src/problem.js         типи помилок і фабрики problem+json
scripts/check-spec.js  acceptance-критерії по спеці (npm run check)
scripts/smoke.js       acceptance-критерії застосунку (npm run smoke)
```

## Версії

Зафіксовані ті самі, на яких прогнані критерії:
`express@4.22.2`, `express-openapi-validator@5.6.2`, `@redocly/cli@2.46.0`.
`express@4` — свідомо, з ним `express-openapi-validator` працює без сюрпризів.
У `package.json` немає `"type": "module"`, тому і код застосунку, і команда
`node -e "require('./spec.json')"` з критеріїв працюють як є.

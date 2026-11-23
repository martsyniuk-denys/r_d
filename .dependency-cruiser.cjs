// Step 3 of the gates: "the modules do not reach into each other", as rules a
// machine checks. Paths are matched with (^|/) in front, so the same rules hold for
// the broken fixture in test/gates/arch/, which mirrors the src/ layout.
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'catalog-does-not-know-orders',
      comment:
        'Orders depend on the catalog (a line item needs a product), never the other way round. ' +
        'Below the order flow nobody imports orders or the realtime push that follows them.',
      severity: 'error',
      from: { path: '(^|/)src/(products|files|storage|auth|entities|repositories|common|config|db|observability|cache)/' },
      to: { path: '(^|/)src/(orders|realtime)/' },
    },
    {
      name: 'storage-only-through-files',
      comment: 'The S3 client is an implementation detail of the files module; other modules ask files.',
      severity: 'error',
      from: { path: '(^|/)src/[^/]+/', pathNot: '(^|/)src/(files|storage)/' },
      to: { path: '(^|/)src/storage/' },
    },
    {
      name: 'leaves-stay-leaves',
      comment: 'Entities and observability are imported by everyone and import no other module.',
      severity: 'error',
      from: { path: '(?:^|/)src/(entities|observability)/' },
      to: { path: '(?:^|/)src/', pathNot: '(?:^|/)src/$1/' },
    },
    {
      name: 'controllers-stay-thin',
      comment:
        'A controller reads the request and calls its service. SQL, transactions and the outbox live ' +
        'below it (service → domain operation → repository), so no business rule can hide in a route.',
      severity: 'error',
      from: { path: '(^|/)src/[^/]+/[^/]+\\.controller\\.ts$' },
      to: {
        path: [
          '(^|/)src/(repositories|db|outbox|concurrency|messaging)/',
          '(^|/)src/orders/(place-order|place-order-once|lifecycle)\\.ts$',
          '(^|/)node_modules/(pg|typeorm)/',
        ],
      },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(dist|node_modules)/' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
  },
};

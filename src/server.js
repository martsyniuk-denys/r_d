'use strict';

const { createApp } = require('./app');
const store = require('./store');

const PORT = Number(process.env.PORT || 3000);

store.seed();

createApp().listen(PORT, () => {
  console.log(`Marketplace API listening on http://localhost:${PORT}`);
  console.log('Spec: openapi/openapi.yaml (requests and responses are validated against it)');
});

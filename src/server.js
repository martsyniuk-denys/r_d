'use strict';

const { createApp } = require('./app');
const store = require('./store');

const PORT = Number(process.env.PORT || 3000);

store.seed();

createApp().listen(PORT, () => {
  console.log(`Marketplace API слухає http://localhost:${PORT}`);
  console.log('Спека: openapi/openapi.yaml (запити й відповіді валідуються проти неї)');
});

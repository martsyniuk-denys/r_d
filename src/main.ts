import { createApp, API_SPEC } from './bootstrap';

const PORT = Number(process.env.PORT || 3000);

async function main(): Promise<void> {
  const app = await createApp();
  await app.listen(PORT);
  console.log(`Marketplace API listening on http://localhost:${PORT}`);
  console.log(`Spec: ${API_SPEC} (requests and responses are validated against it)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

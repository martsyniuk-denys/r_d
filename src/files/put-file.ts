import { readFileSync } from 'node:fs';

// A client that holds nothing but a URL: started by demo:upload with an
// environment of PATH alone — no storage key, no token, no database. Whatever
// it uploads goes from here to the bucket and nowhere else.
//
//   node dist/files/put-file.js <url> <file> <content-type>   prints {"status":…}

async function main(): Promise<void> {
  const [url, file, contentType] = process.argv.slice(2);
  const body = readFileSync(file);
  const response = await fetch(url, { method: 'PUT', body, headers: { 'Content-Type': contentType } });
  console.log(JSON.stringify({ status: response.status }));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

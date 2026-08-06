# r_d

A minimal HTTP/1.1 server built directly on Node's `net` and `tls` modules —
no `http`/`https` module, no framework. Raw TCP bytes are read from the
socket, the request line and headers are parsed by hand, and a valid
HTTP/1.1 response (status line, `Content-Type`, `Content-Length`, blank line,
body) is written back manually.

## Routes

| Request        | Response                                   |
| -------------- | ------------------------------------------- |
| `GET /`        | `200 OK`, `Content-Type: text/plain`         |
| `GET /headers` | `200 OK`, parsed request headers as raw text |
| anything else  | `404 Not Found`                              |

## Running

```
node src/server.js       # HTTP server on http://localhost:3000  (net.createServer)
node src/https-server.js # HTTPS server on https://localhost:3443 (tls.createServer)
```

Both listen on fixed default ports (`3000` / `3443`) — no flags or env vars
required. `npm start` / `npm run start:https` run the same two commands.

The HTTPS server needs `certs/key.pem` and `certs/cert.pem` to exist; generate
them first (see below), otherwise it exits immediately with an error telling
you to do so.

## HTTPS: generating a self-signed certificate

```
npm run gen-cert
```

runs (`scripts/generate-cert.sh`):

```
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout certs/key.pem \
  -out certs/cert.pem \
  -days 365 \
  -subj "/CN=localhost"
```

`certs/key.pem` and `certs/cert.pem` are not committed (see `.gitignore`).

## Debug session: inspecting the TLS certificate

Output of `openssl s_client -connect localhost:3443 -servername localhost`
against the running HTTPS server (`node src/https-server.js`), certificate body
omitted for brevity:

```
Connecting to ::1
depth=0 CN=localhost
verify error:num=18:self-signed certificate
verify return:1
depth=0 CN=localhost
verify return:1
CONNECTED(00000005)
---
Certificate chain
 0 s:CN=localhost
   i:CN=localhost
   a:PKEY: RSA, 2048 (bit); sigalg: sha256WithRSAEncryption
   v:NotBefore: Aug  6 16:36:11 2026 GMT; NotAfter: Aug  6 16:36:11 2027 GMT
---
Server certificate
subject=CN=localhost
issuer=CN=localhost
---
No client certificate CA names sent
Peer signing digest: SHA256
Peer signature type: rsa_pss_rsae_sha256
Negotiated TLS1.3 group: X25519MLKEM768
---
SSL handshake has read 2425 bytes and written 1620 bytes
Verification error: self-signed certificate
---
New, TLSv1.3, Cipher is TLS_AES_256_GCM_SHA384
Protocol: TLSv1.3
Server public key is 2048 bit
Verify return code: 18 (self-signed certificate)
---
DONE
```

**Error code 18** (`X509_V_ERR_DEPTH_ZERO_SELF_SIGNED_CERT`) means OpenSSL
walked the chain to depth 0 and found the leaf certificate signed by itself
rather than by a trusted CA — expected and harmless for a self-signed
certificate generated with `openssl req -x509`.

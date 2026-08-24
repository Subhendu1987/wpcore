# wpcore

> A focused WhatsApp Web gateway for QR login, messaging, chat access, and webhooks.

`wpcore` wraps [`whatsapp-web.js`](https://github.com/pedroslopez/whatsapp-web.js) in a small Express service. It is designed for local tools, internal automation, prototypes, and controlled integrations where a WhatsApp Web session is appropriate.

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new)

## What it does

| Capability | Route |
|---|---|
| Start QR or pairing-code login | `POST /api/login` |
| Serve the current QR image | `GET /api/login/qr/:id.png` |
| Send text and media | `POST /api/messages/send` |
| Configure outbound webhooks | `WEBHOOK_URL` in `.env` |
| List chats and read history | `GET /api/chats`, `GET /api/chats/history` |
| Monitor connection health | `GET /api/health` |
| View live server logs | `GET /` |

## Requirements

- Node.js 18 or newer
- An active WhatsApp account
- Chrome or Chromium available for Puppeteer
- A phone able to scan a WhatsApp Web QR code, or use the pairing-code flow

## Run locally

```bash
npm install
npm start
```

The service starts at `http://localhost:3000` and prints one startup line:

```text
Server is Live on http://localhost:3000
```

For development with Node's watch mode:

```bash
npm run dev
```

## Deploy on Railway

1. Create a Railway project from this GitHub repository.
2. Open the service's **Variables** tab and add:

```env
API_KEY=generate-a-new-long-random-secret
SESSION_DIR=/data/.wwebjs_auth
WEBHOOK_CONFIG_FILE=/data/.webhook.json
WEBHOOK_URL=https://your-webhook.example/whatsapp
```

Do not add `PORT`; Railway provides it automatically. `WEBHOOK_URL` is optional.
Add a Railway volume mounted at `/data` so the WhatsApp login session survives
deployments. After the service starts, use the generated Railway domain as
`baseUrl` in Postman and call `POST /api/login` with the same `API_KEY` in the
`x-api-key` header.

## Configuration

Create `.env` in the project root:

```env
PORT=3000
API_KEY=replace-with-a-long-random-secret
SESSION_DIR=./.wwebjs_auth
WEBHOOK_URL=https://example.com/whatsapp-events
```

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port. |
| `API_KEY` | required | Shared API key for protected routes. |
| `SESSION_DIR` | `./.wwebjs_auth` | Persistent WhatsApp browser session directory. |
| `WEBHOOK_URL` | unset | Initial outbound webhook URL. |

Use a long random `API_KEY` outside local development. Keep `.env` and `.wwebjs_auth` out of source control.

## Authentication

Every `/api` request requires the API key in the `x-api-key` header:

```bash
curl http://localhost:3000/api/health \
  -H "x-api-key: replace-with-a-long-random-secret"
```

API keys are not accepted in query parameters. This prevents them from being
recorded in browser history, proxy logs, and access logs. The browser log
viewer exchanges the header for a short-lived HttpOnly cookie before opening
its live stream.

The QR PNG route is the intentional exception. Its rotating ID allows the image to load directly in a browser.

## First login

### QR flow

1. Start the service with `npm start`.
2. Request the login state:

```bash
curl -X POST http://localhost:3000/api/login \
  -H "x-api-key: replace-with-a-long-random-secret"
```

3. Repeat the request until the response contains a `qr` URL.
4. Open that URL in a browser and scan it from WhatsApp: **Linked Devices > Link a Device**.
5. Confirm readiness:

```bash
curl http://localhost:3000/api/health \
  -H "x-api-key: replace-with-a-long-random-secret"
```

A successful health response has `connected: true` and `status: "ready"`. The session is persisted in `SESSION_DIR`, so subsequent starts can reuse it.

### Pairing-code flow

Include the phone number, with country code and digits only, in the `phone` header:

```bash
curl -X POST http://localhost:3000/api/login \
  -H "x-api-key: replace-with-a-long-random-secret" \
  -H "phone: 919641114583"
```

The response can include an 8-character pairing code. Enter it immediately on the phone under **Linked Devices > Link with phone number**. Pairing requests are rate-limited; avoid repeatedly requesting new codes.

## Send a message

Phone numbers should include the country code and contain digits only. Full chat IDs such as `919876543210@c.us` and group IDs ending in `@g.us` are also accepted.

```bash
curl -X POST http://localhost:3000/api/messages/send \
  -H "x-api-key: replace-with-a-long-random-secret" \
  -H "Content-Type: application/json" \
  -d '{"to":"919876543210","message":"Hello from wpcore!"}'
```

Media can be uploaded with multipart form data:

```bash
curl -X POST http://localhost:3000/api/messages/send \
  -H "x-api-key: replace-with-a-long-random-secret" \
  -F "to=919876543210" \
  -F "media=@C:/path/to/image.jpg" \
  -F "caption=Sent by wpcore"
```

The client must be in the `ready` state before sending messages.

## Realtime visibility

### Browser log console

Open `http://localhost:3000/` in a browser. Enter the API key to access recent and live server logs. The console supports message search, level filtering, event counts, and a live connection indicator.

After connecting, select **Download Postman JSON** to download a collection generated for the current server URL and API key. The collection is also refreshed at startup and saved to `postman/wpcore.postman_collection.json`.

## Webhooks

Configure the outbound destination in `.env`:

```bash
WEBHOOK_URL=https://example.com/whatsapp-events
```

Configured destinations receive incoming WhatsApp messages and outgoing-message acknowledgements as JSON. Use `GET /api/info` to show the configured destination along with account and connection details.

## Endpoint overview

All routes below are prefixed with `http://localhost:3000` and require `x-api-key` unless noted.

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/api/login` | Start or inspect QR and pairing-code login. |
| `GET` | `/api/login/qr/:id.png` | Return the current QR PNG; API key not required. |
| `POST` | `/api/login/restart` | Restart the WhatsApp client. |
| `POST` | `/api/logout` | Log out; matching `phone` header required. |
| `POST` | `/api/messages/send` | Send text or media. |
| `GET` | `/api/info` | Show account, connection, uptime, and webhook information. |
| `GET` / `POST` | `/api/chats` | List chats. |
| `GET` / `POST` | `/api/chats/history` | Read messages for a chat. |
| `GET` | `/api/health` | Return connection health. |
| `GET` | `/postman/collection.json` | Download the current Postman collection. |
| `GET` | `/` | Open the protected browser log console. |

## Project layout

```text
src/
├── server.js            Express server, API-key middleware, and log console
├── routes/
│   └── api.js           REST endpoints
└── whatsapp/
    └── manager.js       WhatsApp lifecycle, QR, messaging, and webhooks
```

## Operational notes

- The first run may download a Chromium build for Puppeteer.
- The WhatsApp session is stored locally under `SESSION_DIR`.
- Do not expose this service publicly without a strong API key, TLS, and network access controls.
- Avoid bulk messaging, unsolicited messaging, and automation that violates WhatsApp policies. For production business messaging, evaluate the official WhatsApp Business Platform.

## License and usage

This project is intended for responsible, authorized use with accounts you control. Review the terms and policies of WhatsApp and all dependencies before deploying it.

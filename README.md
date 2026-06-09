# WB — WhatsApp Connector

WB is the service that holds the live connection to WhatsApp. It links to a business's
existing WhatsApp number (the same way WhatsApp Web does), receives incoming messages,
and sends outgoing replies. It is the bridge between WhatsApp and the ChatPilot AI
backend.

It is part of a three-service system:

- **ChatPilot API** — the AI brain and business logic
- **WB** (this repo) — the live WhatsApp connection
- **Frontend** — the dashboard used to scan the QR code and manage everything

---

## What it does

WB uses the [Baileys](https://github.com/WhiskeySockets/Baileys) library to connect to
WhatsApp through a linked device (QR code or pairing code — no official WhatsApp Business
API required, and the phone's WhatsApp app keeps working normally).

When a customer sends a message, WB receives it, downloads any media (voice, image, PDF),
and forwards it to the ChatPilot API through a webhook. When ChatPilot generates a reply,
it calls WB to send that reply back to the customer.

WB can manage **multiple WhatsApp sessions at once** — one per business — and keeps each
session alive, reconnecting automatically if the connection drops.

---

## Key features

- **Link any WhatsApp number** via QR code or pairing code — no Meta Business API.
- **Multiple sessions** — run many businesses' WhatsApp numbers from one service.
- **Receives all message types** — text, voice notes, images, documents, and forwards
  them to the AI backend.
- **Sends replies** — text and media back to customers.
- **Auto-reconnect** — handles drops, session conflicts, and restarts gracefully.
- **Session persistence** — login credentials are stored in PostgreSQL, so sessions
  survive restarts without re-scanning the QR.
- **Presence & typing** — shows "online" and "typing…" so replies feel natural.
- **Read receipts** — marks incoming messages as read.

---

## Tech stack

| Layer | Technology |
|---|---|
| Framework | NestJS (TypeScript) |
| WhatsApp | Baileys (`@whiskeysockets/baileys`) |
| Database | PostgreSQL + Prisma ORM (session storage) |
| Logging | pino |
| QR codes | `qrcode` |
| HTTP | axios (webhook calls to the AI backend) |

---

## Project structure

```
src/
├── whatsapp/
│   ├── session-manager.ts        # creates & manages WhatsApp sessions (core)
│   ├── whatsapp.controller.ts    # REST endpoints (connect, send, status, QR)
│   ├── whatsapp.service.ts       # restores sessions on startup
│   ├── storage-service.ts        # uploads incoming media
│   └── helpers/
│       └── prisma-auth-state.ts  # stores Baileys auth state in PostgreSQL
├── prisma/                       # Prisma service
├── global-exception-filter...    # graceful error handling
└── main.ts                       # bootstrap
```

---

## Getting started

### Requirements

- Node.js 20+ (Baileys v7 requires Node 20 or newer)
- PostgreSQL database
- The ChatPilot API running (to receive the webhooks)

### Setup

```bash
# 1. Install dependencies
npm install

# 2. Apply database migrations
npx prisma migrate deploy

# 3. Create a .env file (see below)

# 4. Start in development
npm run start:dev
```

The service runs on `http://localhost:3001` with the prefix `/api/v1`.
Swagger docs are at `http://localhost:3001/api`.

### Environment variables

```env
PORT=3001
DATABASE_URL=postgresql://user:password@host:5432/chatpilot?schema=public

# Where to forward incoming WhatsApp messages
WEBHOOK_URL=http://localhost:3000/api/v1/webhook/whats-bailey

ENABLE_MESSAGE_RECEIPT=true     # mark incoming messages as read
```

---

## Main API endpoints

All endpoints are under `/api/v1/whatsapp`.

| Method | Endpoint | What it does |
|---|---|---|
| `POST` | `/connect` | Start a new WhatsApp session |
| `GET`  | `/getQrCodeImage/:id` | Get the QR code image to scan |
| `GET`  | `/sessions/pairingcode/:id` | Get a pairing code instead of QR |
| `POST` | `/:id/send-message` | Send a message from a session |
| `GET`  | `/sessions` | List all sessions |
| `GET`  | `/sessions/:id/status` | Check a session's connection status |
| `GET`  | `/sessions/:id/remove` | Remove a session |
| `POST` | `/:id/is-on-whatsapp` | Check if a number is on WhatsApp |

---

## How a session connects

```
1. POST /connect            →  WB creates a session
2. GET  /getQrCodeImage/:id →  returns a QR code
3. Scan it in WhatsApp      →  Linked Devices → Link a Device
4. Session goes "open"      →  credentials saved to PostgreSQL
5. Messages flow            →  incoming forwarded to ChatPilot via webhook
```

If WB restarts, it reads saved credentials from the database and reconnects all sessions
automatically — no re-scanning needed.

---

## Running with Docker

A `Dockerfile` is included. In production WB runs as a container alongside the rest of the
system (PostgreSQL, Redis, ChatPilot API, frontend) behind Nginx.

```bash
docker compose up -d
```

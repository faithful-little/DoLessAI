# Function Backend

Lightweight backend for sharing and retrieving extension automation functions.

## Features
- Stores function definitions + metadata in SQLite.
- Supports hybrid retrieval:
  - BM25 full-text search (SQLite FTS5)
  - cosine similarity against client-provided embeddings
- Filters by applicable site patterns (`urlPatterns`) when `currentUrl` is provided.
- Includes a simple web UI for health, stats, and interactive search.

## Why no API keys on backend
The extension client generates embeddings and sends them with upload/search requests.
The backend only stores vectors and runs retrieval math.

## Start with Docker
From this folder:

```bash
docker compose up --build
```

Backend will be available at:
- API: `http://localhost:8787/api`
- UI: `http://localhost:8787`

## API

### `GET /api/health`
Returns service status and stored function count.

### `POST /api/functions/upsert`
Upserts one function document.

Payload example:

```json
{
  "clientId": "chrome-extension-id",
  "functionDef": {
    "name": "searchAmazonProducts",
    "description": "Extracts title + price from Amazon search",
    "urlPatterns": ["https://www.amazon.com/*"],
    "inputs": [],
    "steps": []
  },
  "embedding": [0.01, -0.22, 0.004],
  "metadata": {
    "source": "ai-task",
    "testsPassed": true,
    "applicableSites": ["https://www.amazon.com/*"]
  },
  "fingerprint": "optional-deterministic-id"
}
```

### `POST /api/functions/search`
Runs BM25 + embedding hybrid retrieval.

Payload example:

```json
{
  "query": "scrape amazon price and title",
  "queryEmbedding": [0.01, -0.22, 0.004],
  "currentUrl": "https://www.amazon.com/s?k=keyboard",
  "topK": 8
}
```

### `GET /api/functions`
Lists recent stored functions.

## Persistence
SQLite file is mounted to the named volume `function_backend_data`.

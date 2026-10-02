# youtube-ingest

Shared YouTube transcript ingestion service. Monitors channels for new videos,
fetches transcripts via yt-dlp, and stores them in a local SQLite database for
downstream consumers.

## Features

- Multi-channel monitoring with configurable refresh intervals
- Automatic transcript fetching via yt-dlp (handles YouTube's API changes)
- SQLite storage with schema migration
- Cron-friendly: designed to run as a periodic background service
- No API keys required (uses yt-dlp's public endpoint access)

## Requirements

- Node.js 18+ or Bun
- yt-dlp installed and on PATH
- SQLite3

## Setup

```bash
npm install
# or
bun install
```

## Usage

### Watcher mode (recommended)

```bash
bun watcher.ts scan    # Check channels for new videos, add to queue
bun watcher.ts process # Process queued videos (fetch transcripts)
bun watcher.ts status  # Show queue status
```

### One-shot ingest (legacy)

```bash
bun ingest.ts CHANNEL_ID [--limit 10]
```

## Configuration

Edit `channels.json` to configure monitored channels:

```json
[
  {
    "id": "UCxxxx",
    "name": "Channel Name",
    "interval_minutes": 60
  }
]
```

## Database

The service stores data in `youtube.db` (SQLite). Key tables:

- `channels` — monitored channels
- `videos` — discovered videos with status
- `transcripts` — fetched transcripts

## License

MIT License — free to use for companies under $1M revenue.
#!/usr/bin/env bun
// Discord YouTube Link Extractor
// Reads recent messages from Discord channel(s), extracts YouTube URLs,
// and queues them in the youtube-ingest database for processing.
//
// Usage:
//   bun discord-ingest.ts --channel <channel_id> [--limit N] [--days N]
//   bun discord-ingest.ts --urls "url1 url2"  # manual URL mode
//
// Env:
//   DISCORD_BOT_TOKEN - or reads from pass store (discord/bot-token)
//   DISCORD_CHANNEL - default channel ID
//
// Config:
//   Channels to watch stored in discord-channels.json

import { execFileSync, execSync } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { Database } from "bun:sqlite";

const DB_PATH = "/home/aaron/lib/youtube-ingest/youtube.db";
const CONFIG_PATH = "/home/aaron/lib/youtube-ingest/discord-channels.json";

interface DiscordChannel {
  channel_id: string;
  name: string;
}

// --- Discord API ---
function getDiscordToken(): string {
  if (process.env.DISCORD_BOT_TOKEN) return process.env.DISCORD_BOT_TOKEN;
  try {
    return execSync("pass show discord/bot-token", { encoding: "utf8" }).trim();
  } catch (e) {
    throw new Error("No Discord bot token found. Set DISCORD_BOT_TOKEN or store in pass store at discord/bot-token");
  }
}

async function fetchDiscordMessages(token: string, channelId: string, limit: number = 100): Promise<any[]> {
  const url = `https://discord.com/api/v10/channels/${channelId}/messages?limit=${limit}`;
  try {
    const result = execSync(
      `curl -s -H "Authorization: Bot ${token}" "${url}"`,
      { encoding: "utf8", timeout: 30000 }
    );
    const data = JSON.parse(result);
    if (data.message) {
      throw new Error(`Discord API error ${data.code}: ${data.message}`);
    }
    return data;
  } catch (e: any) {
    if (e.message?.includes("Discord API error")) throw e;
    throw new Error(`Failed to fetch Discord messages: ${e.message}`);
  }
}

// --- YouTube URL Extraction ---
function extractYouTubeUrls(text: string): string[] {
  // Match youtube.com/watch?v=ID, youtu.be/ID, youtube.com/live/ID, youtube.com/embed/ID
  const patterns = [
    /https?:\/\/(?:www\.)?youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})/g,
    /https?:\/\/(?:www\.)?youtu\.be\/([a-zA-Z0-9_-]{11})/g,
    /https?:\/\/(?:www\.)?youtube\.com\/live\/([a-zA-Z0-9_-]{11})/g,
    /https?:\/\/(?:www\.)?youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/g,
  ];

  const ids = new Set<string>();
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      ids.add(match[1]);
    }
  }
  return Array.from(ids);
}

// --- Database ---
function openDb(): Database {
  if (!existsSync(DB_PATH)) {
    throw new Error(`Database not found at ${DB_PATH}`);
  }
  const db = new Database(DB_PATH);
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec("PRAGMA busy_timeout=5000;");
  return db;
}

function isVideoInDb(db: Database, videoId: string): boolean {
  const row = db.prepare("SELECT 1 FROM videos WHERE video_id = ?").get(videoId);
  return !!row;
}

function queueVideo(db: Database, videoId: string, source: string): boolean {
  // Check if already queued or processed
  const queued = db.prepare("SELECT 1 FROM queue WHERE video_id = ?").get(videoId);
  if (queued) return false;

  const processed = db.prepare("SELECT status FROM videos WHERE video_id = ?").get(videoId);
  if (processed && processed.status === 'processed') return false;

  try {
    // Get video info via yt-dlp
    const info = execSync(
      `yt-dlp --no-update --no-warnings --skip-download --print "%(title)s|%(upload_date)s|%(channel_id)s" "https://www.youtube.com/watch?v=${videoId}"`,
      { encoding: "utf8", timeout: 30000, env: { ...process.env, PATH: `${process.env.PATH}:/home/aaron/.local/bin` } }
    ).trim().split("|");

    const title = info[0] || "Unknown title";
    const uploadDate = info[1] || new Date().toISOString().split("T")[0];
    const channelId = info[2] || "discord-stream";

    // Ensure channel exists
    db.run("INSERT OR IGNORE INTO channels (id, name, trust_tier) VALUES (?, ?, 2)", [channelId, `discord:${source}`]);

    // Queue it
    db.run("INSERT OR IGNORE INTO queue (video_id, channel_id, title, published_at) VALUES (?, ?, ?, ?)",
      [videoId, channelId, title, uploadDate]);
    db.run("INSERT OR IGNORE INTO videos (video_id, channel_id, title, published_at, status) VALUES (?, ?, ?, ?, 'queued')",
      [videoId, channelId, title, uploadDate]);

    return true;
  } catch (e: any) {
    console.warn(`  Failed to queue ${videoId}: ${e.message?.slice(0, 100)}`);
    return false;
  }
}

// --- Main ---
async function main() {
  const args = process.argv.slice(2);
  let queued = 0;
  let seen = 0;

  const db = openDb();

  try {
    if (args.includes("--urls")) {
      // Manual URL mode
      const urlsArg = args[args.indexOf("--urls") + 1];
      const urls = urlsArg.split(/\s+/);
      for (const url of urls) {
        const ids = extractYouTubeUrls(url);
        for (const id of ids) {
          seen++;
          if (isVideoInDb(db, id)) {
            console.log(`[skip] ${id} already in DB`);
            continue;
          }
          if (queueVideo(db, id, "manual")) {
            console.log(`[queued] ${id}`);
            queued++;
          }
        }
      }
    } else {
      // Discord mode
      const token = getDiscordToken();

      // Determine channel(s)
      let channels: DiscordChannel[] = [];
      if (args.includes("--channel")) {
        const chId = args[args.indexOf("--channel") + 1];
        channels = [{ channel_id: chId, name: chId }];
      } else if (existsSync(CONFIG_PATH)) {
        channels = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
      } else {
        throw new Error("No channel specified. Use --channel <id> or configure discord-channels.json");
      }

      const limit = args.includes("--limit") ? parseInt(args[args.indexOf("--limit") + 1]) : 100;

      for (const ch of channels) {
        console.log(`\n[discord] Fetching messages from ${ch.name} (${ch.channel_id})...`);
        try {
          const messages = await fetchDiscordMessages(token, ch.channel_id, limit);
          console.log(`  Retrieved ${messages.length} messages`);

          for (const msg of messages) {
            const text = msg.content || "";
            const ids = extractYouTubeUrls(text);
            for (const id of ids) {
              seen++;
              if (isVideoInDb(db, id)) {
                console.log(`  [skip] ${id} (msg ${msg.id}) already in DB`);
                continue;
              }
              if (queueVideo(db, id, ch.name)) {
                console.log(`  [queued] ${id} from msg ${msg.id}`);
                queued++;
              }
            }
          }
        } catch (e: any) {
          console.error(`  Error: ${e.message}`);
        }
      }
    }

    console.log(`\nDone. ${seen} links found, ${queued} queued, ${seen - queued} skipped.`);
  } finally {
    db.close();
  }
}

main().catch(e => {
  console.error(`Fatal: ${e.message}`);
  process.exit(1);
});

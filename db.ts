/**
 * SQLite database for YouTube transcripts.
 * Location: ~/lib/youtube-ingest/data/youtube.db
 */
import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'youtube.db');

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS channels (
        channel_id TEXT PRIMARY KEY,
        handle TEXT NOT NULL,
        name TEXT,
        subscribed_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS videos (
        video_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL REFERENCES channels(channel_id),
        title TEXT NOT NULL,
        published_at TEXT NOT NULL,
        fetched_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS transcripts (
        video_id TEXT PRIMARY KEY REFERENCES videos(video_id),
        transcript TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'api',
        fetched_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_videos_channel ON videos(channel_id, published_at DESC);
      CREATE INDEX IF NOT EXISTS idx_videos_published ON videos(published_at DESC);
    `);
  }
  return db;
}

export function upsertChannel(channelId: string, handle: string, name?: string): void {
  const d = getDb();
  d.prepare(`
    INSERT OR REPLACE INTO channels (channel_id, handle, name)
    VALUES (?, ?, ?)
  `).run(channelId, handle, name ?? handle);
}

export function hasVideo(videoId: string): boolean {
  const d = getDb();
  const row = d.prepare('SELECT 1 FROM videos WHERE video_id = ?').get(videoId);
  return !!row;
}

export function upsertVideo(videoId: string, channelId: string, title: string, publishedAt: string): void {
  const d = getDb();
  d.prepare(`
    INSERT OR IGNORE INTO videos (video_id, channel_id, title, published_at)
    VALUES (?, ?, ?, ?)
  `).run(videoId, channelId, title, publishedAt);
}

export function upsertTranscript(videoId: string, transcript: string, source: string = 'api'): void {
  const d = getDb();
  d.prepare(`
    INSERT OR REPLACE INTO transcripts (video_id, transcript, source)
    VALUES (?, ?, ?)
  `).run(videoId, transcript, source);
}

export function getTranscript(videoId: string): string | null {
  const d = getDb();
  const row = d.prepare('SELECT transcript FROM transcripts WHERE video_id = ?').get(videoId);
  return row ? (row as any).transcript : null;
}

export function getVideoTitle(videoId: string): string | null {
  const d = getDb();
  const row = d.prepare('SELECT title FROM videos WHERE video_id = ?').get(videoId);
  return row ? (row as any).title : null;
}

/** Get recent videos for a channel, with transcripts if available. */
export function getRecentVideos(channelId: string, days: number): Array<{ video_id: string; title: string; published_at: string; transcript: string | null }> {
  const d = getDb();
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  return d.prepare(`
    SELECT v.video_id, v.title, v.published_at, t.transcript
    FROM videos v
    LEFT JOIN transcripts t ON v.video_id = t.video_id
    WHERE v.channel_id = ? AND v.published_at >= ?
    ORDER BY v.published_at DESC
  `).all(channelId, cutoff) as any[];
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = undefined as any;
  }
}

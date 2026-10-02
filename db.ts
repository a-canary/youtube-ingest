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

export interface Chapter { start_seconds: number; title: string; }
export interface Link { url: string; type: string; title?: string; }
export interface Screenshot { timestamp: number; path: string; }

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
        chapters TEXT,
        links TEXT,
        screenshots TEXT,
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
    // Migrate existing DBs missing the JSON columns
    const cols = db.prepare("PRAGMA table_info(videos)").all() as any[];
    const colNames = cols.map(c => c.name);
    if (!colNames.includes('chapters')) db.exec('ALTER TABLE videos ADD COLUMN chapters TEXT');
    if (!colNames.includes('links')) db.exec('ALTER TABLE videos ADD COLUMN links TEXT');
    if (!colNames.includes('screenshots')) db.exec('ALTER TABLE videos ADD COLUMN screenshots TEXT');
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

export function getChapters(videoId: string): Chapter[] {
  const row = getDb().prepare('SELECT chapters FROM videos WHERE video_id = ?').get(videoId) as any;
  return row?.chapters ? JSON.parse(row.chapters) : [];
}
export function setChapters(videoId: string, chapters: Chapter[]): void {
  getDb().prepare('UPDATE videos SET chapters = ? WHERE video_id = ?').run(JSON.stringify(chapters), videoId);
}
export function getLinks(videoId: string): Link[] {
  const row = getDb().prepare('SELECT links FROM videos WHERE video_id = ?').get(videoId) as any;
  return row?.links ? JSON.parse(row.links) : [];
}
export function setLinks(videoId: string, links: Link[]): void {
  getDb().prepare('UPDATE videos SET links = ? WHERE video_id = ?').run(JSON.stringify(links), videoId);
}
export function getScreenshots(videoId: string): Screenshot[] {
  const row = getDb().prepare('SELECT screenshots FROM videos WHERE video_id = ?').get(videoId) as any;
  return row?.screenshots ? JSON.parse(row.screenshots) : [];
}
export function setScreenshots(videoId: string, screenshots: Screenshot[]): void {
  getDb().prepare('UPDATE videos SET screenshots = ? WHERE video_id = ?').run(JSON.stringify(screenshots), videoId);
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = undefined as any;
  }
}

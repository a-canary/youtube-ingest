#!/usr/bin/env bun
// YouTube Watcher Service
// Scans subscribed channels for new videos, queues them, processes serially.
//
// Modes:
//   scan     - Check all channels for new videos, queue unseen ones (runs every 4h)
//   process  - Process next video from queue (runs every 5m)
//   status   - Show queue status
//   process-all - Process all queued videos (one-shot)
//
// Architecture:
//   Trade-cycle reads SQLite DB only (no YouTube API calls).
//   Watcher is the sole YouTube consumer, runs on its own schedule.
//
// Usage:
//   bun watcher.ts scan
//   bun watcher.ts process
//   bun watcher.ts status
//   bun watcher.ts process-all

import { execFileSync, execSync } from "child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, statSync } from "fs";
import path from "path";
import os from "os";
import { Database } from "bun:sqlite";

// --- Config ---
const DB_PATH = "/home/aaron/lib/youtube-ingest/youtube.db";
const CHANNELS_PATH = "/home/aaron/lib/youtube-ingest/channels.json";
const IMG_BASE = "/home/aaron/lib/youtube-ingest/images";

// Transcript API (uses pip packages)
const TRANSCRIPT_API = "/usr/local/lib/python3.10/dist-packages/youtube_transcript_api";

// --- Ensure DB exists ---
function ensureDB(): Database {
  if (!existsSync(DB_PATH)) {
    console.log("Creating database...");
    mkdirSync(path.dirname(DB_PATH), { recursive: true });
  }
  const db = new Database(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      name TEXT,
      trust_tier INTEGER
    );
    CREATE TABLE IF NOT EXISTS videos (
      video_id TEXT PRIMARY KEY,
      channel_id TEXT,
      title TEXT,
      published_at TEXT,
      transcript TEXT,
      status TEXT DEFAULT 'queued',
      created_at TEXT DEFAULT (datetime('now')),
      processed_at TEXT,
      error TEXT,
      FOREIGN KEY (channel_id) REFERENCES channels(id)
    );
    CREATE TABLE IF NOT EXISTS images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id TEXT,
      file_path TEXT,
      timestamp_sec INTEGER,
      caption TEXT,
      FOREIGN KEY (video_id) REFERENCES videos(video_id)
    );
    CREATE TABLE IF NOT EXISTS queue (
      video_id TEXT PRIMARY KEY,
      channel_id TEXT,
      title TEXT,
      published_at TEXT,
      enqueued_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (video_id) REFERENCES videos(video_id)
    );
  `);
  return db;
}

// --- Channel Management ---
function loadChannels(): any[] {
  const data = readFileSync(CHANNELS_PATH, "utf-8");
  return JSON.parse(data);
}

function upsertChannels(db: Database): void {
  const channels = loadChannels();
  for (const ch of channels) {
    db.run(`INSERT OR REPLACE INTO channels (id, name, trust_tier) VALUES (?, ?, ?)`,
      [ch.channel_id, ch.name, ch.trust_tier || 1]);
  }
  console.log(`Loaded ${channels.length} channels from ${CHANNELS_PATH}`);
}

// --- Scan Mode: Find new videos ---
function scan(): void {
  const db = ensureDB();
  upsertChannels(db);
  const channels = loadChannels();
  let queued = 0;

  for (const ch of channels) {
    console.log(`\nScanning: ${ch.name}`);
    try {
      // List latest 10 videos from channel using yt-dlp flat-playlist
      const listing = execFileSync("yt-dlp", [
        "--flat-playlist", "--playlist-end", "10",
        "--print", "%(id)s|%(title)s|%(upload_date)s",
        `https://www.youtube.com/${ch.handle}/videos`
      ], { timeout: 60000, env: { ...process.env, PATH: `${process.env.PATH}:/home/aaron/.local/bin` } })
        .toString()
        .trim()
        .split("\n");

      for (const line of listing) {
        if (!line.trim()) continue;
        const parts = line.split("|");
        if (parts.length < 3) continue;
        const [videoId, title, uploadDate] = parts;

        // Check if already processed
        const existing = db.prepare("SELECT status FROM videos WHERE video_id = ?").get(videoId);
        if (existing && (existing.status === 'processed' || existing.status === 'failed')) {
          continue;
        }

        // Check if already queued
        const queuedCheck = db.prepare("SELECT 1 FROM queue WHERE video_id = ?").get(videoId);
        if (queuedCheck) continue;

        // Queue it
        db.run(`INSERT OR IGNORE INTO queue (video_id, channel_id, title, published_at) VALUES (?, ?, ?, ?)`,
          [videoId, ch.channel_id, title, uploadDate]);
        db.run(`INSERT OR IGNORE INTO videos (video_id, channel_id, title, published_at, status) VALUES (?, ?, ?, ?, 'queued')`,
          [videoId, ch.channel_id, title, uploadDate]);
        queued++;
      }
    } catch (e: any) {
      console.error(`  Error scanning ${ch.name}: ${e.message}`);
    }
  }

  console.log(`\nScan complete. ${queued} new videos queued.`);
  db.close();
}

// --- Transcript Fetching (yt-dlp auto-subs with 429 detection) ---
// Uses yt-dlp to download auto-generated subtitles, then parses the VTT file.
// This works around IP bans that affect the youtube_transcript_api Python package.
// Returns { transcript: string|null, rateLimited: boolean }
function fetchTranscript(videoId: string): { transcript: string | null, rateLimited: boolean } {
  const tmpDir = `/tmp/yt-sub-${videoId}`;
  mkdirSync(tmpDir, { recursive: true });
  try {
    // Download auto-generated English subtitles
    const result = execSync(
      `yt-dlp --skip-download --write-auto-subs --sub-langs en --sub-format vtt -o "${tmpDir}/t" "https://www.youtube.com/watch?v=${videoId}" 2>&1`,
      { timeout: 60000, env: { ...process.env, PATH: `${process.env.PATH}:/home/aaron/.local/bin` } }
    ).toString();

    // Check for 429 rate limit
    if (result.includes("429") || result.includes("Too Many Requests")) {
      return { transcript: null, rateLimited: true };
    }

    // Find the downloaded VTT file
    const vttFiles = readdirSync(tmpDir).filter(f => f.endsWith(".en.vtt"));
    if (vttFiles.length === 0) return null;

    const vttPath = path.join(tmpDir, vttFiles[0]);
    const vtt = readFileSync(vttPath, "utf-8");

    // Parse VTT to timestamped transcript lines
    const lines = vtt.split("\n");
    const transcript: string[] = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i].trim();
      // Match VTT timestamp: "00:01:23.456 --> 00:01:26.789"
      const tsMatch = line.match(/^(\d+):(\d+):(\d+)\.\d+\s*-->/);
      if (tsMatch) {
        const secs = parseInt(tsMatch[1]) * 3600 + parseInt(tsMatch[2]) * 60 + parseInt(tsMatch[3]);
        const mins = Math.floor(secs / 60);
        const remSecs = secs % 60;
        // Next line(s) contain the text
        i++;
        while (i < lines.length && lines[i].trim() !== "") {
          transcript.push(`[${String(mins).padStart(2,"0")}:${String(remSecs).padStart(2,"0")}] ${lines[i].trim()}`);
          i++;
        }
      } else {
        i++;
      }
    }

    return { transcript: transcript.join("\n"), rateLimited: false };
  } catch (e: any) {
    // Check if it's a rate limit error (check both message and stdout)
    const stdout = e.stdout?.toString() || "";
    if (e.message?.includes("429") || e.message?.includes("Too Many Requests") ||
        stdout.includes("429") || stdout.includes("Too Many Requests")) {
      return { transcript: null, rateLimited: true };
    }
    return { transcript: null, rateLimited: false };
  } finally {
    // Cleanup
    try { execSync(`rm -rf "${tmpDir}"`); } catch {}
  }
}

// --- Frame Extraction: PSNR Filter + LLM Value Judgment ---
// Two-stage approach:
//   Stage 1 (fast): Extract frames at regular intervals, filter by PSNR similarity
//   Stage 2 (slow): LLM vision model evaluates whether each kept frame adds value
//
// No arbitrary cap on frame count. LLM decides what's worth keeping.
function extractUniqueFrames(videoId: string, transcript: string): string[] {
  const imgDir = path.join(IMG_BASE, videoId);
  mkdirSync(imgDir, { recursive: true });

  // Parse transcript to get total duration and context around each timestamp
  let totalDuration = 0;
  const segments = transcript.split("\n").map(line => {
    const match = line.match(/^\[(\d{2}):(\d{2})\]\s*(.*)/);
    if (match) {
      const timeSec = parseInt(match[1]) * 60 + parseInt(match[2]);
      totalDuration = Math.max(totalDuration, timeSec);
      return { timeSec, text: match[3].toLowerCase() };
    }
    return null;
  }).filter(Boolean) as { timeSec: number; text: string }[];

  if (totalDuration === 0) return [];

  // Calculate extraction interval based on video length
  let interval = Math.floor(totalDuration / 20);
  if (interval < 15) interval = 15;
  if (interval > 120) interval = 120;

  console.log(`  Video duration: ${totalDuration}s, extracting every ${interval}s`);

  // Download video
  let videoFile = "";
  try {
    videoFile = `/tmp/yt-${videoId}.mp4`;
    execFileSync("yt-dlp", [
      "-f", "bestvideo[height<=720]",
      "-o", videoFile,
      `https://www.youtube.com/watch?v=${videoId}`
    ], { timeout: 300000, env: { ...process.env, PATH: `${process.env.PATH}:/home/aaron/.local/bin` } });
  } catch (e) {
    console.error(`  Could not download video: ${e}`);
    return [];
  }

  // Stage 1: Extract frames at regular intervals + PSNR similarity filter
  const rawFrames: { file: string; timeStr: string; ts: number }[] = [];
  let ts = 0;
  while (ts <= totalDuration) {
    const file = path.join(imgDir, `raw_${String(ts).padStart(5, "0")}.jpg`);
    const hh = Math.floor(ts / 3600);
    const mm = Math.floor((ts % 3600) / 60);
    const ss = ts % 60;
    const timeStr = `${hh}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
    try {
      execSync(
        `ffmpeg -y -ss ${timeStr} -i "${videoFile}" -vframes 1 -q:v 5 "${file}" 2>/dev/null`,
        { timeout: 10000 }
      );
      rawFrames.push({ file, timeStr, ts });
    } catch (e) {
      console.error(`  Frame extract failed at ${timeStr}: ${e}`);
    }
    ts += interval;
  }
  console.log(`  Extracted ${rawFrames.length} raw frames`);

  // PSNR filter: keep frames that differ from the last kept frame
  const psnrKept: { file: string; timeStr: string; ts: number }[] = [];
  let lastKept = "";

  for (const frame of rawFrames) {
    if (lastKept === "") {
      psnrKept.push(frame);
      lastKept = frame.file;
      continue;
    }

    // Compare to last kept frame using PSNR
    let psnr: number | null = null;
    try {
      const result = execSync(
        `ffmpeg -i "${lastKept}" -i "${frame.file}" -lavfi "psnr" -f null - 2>&1 | grep "average"`,
        { timeout: 5000 }
      ).toString();
      const match = result.match(/average\s*:([^\s]+)/);
      if (match) {
        const val = match[1];
        psnr = val === "inf" ? Infinity : parseFloat(val);
      }
    } catch (e) {
      // If comparison fails, keep the frame
    }

    if (psnr !== null && psnr > 25) {
      // Similar to last kept frame (talking head / static) -> skip
      continue;
    }

    // Different content -> keep
    psnrKept.push(frame);
    lastKept = frame.file;
  }
  console.log(`  PSNR filter: ${psnrKept.length} unique frames from ${rawFrames.length} raw`);

  // Stage 2: LLM evaluates each frame's value
  const llmKept: { file: string; timeStr: string; ts: number; reason: string }[] = [];

  for (const frame of psnrKept) {
    // Get 30s of transcript context before and after the frame
    const contextLines = segments.filter(s =>
      s.timeSec >= frame.ts - 30 && s.timeSec <= frame.ts + 30
    ).map(s => s.text);
    const context = contextLines.join(" ").slice(0, 500);

    // Ask LLM if this frame adds value
    const reason = llmEvaluateFrame(frame.file, context);
    if (reason) {
      llmKept.push({ ...frame, reason });
    }
  }

  console.log(`  LLM filter: ${llmKept.length} valuable frames from ${psnrKept.length} unique`);

  // Rename kept frames to final names
  const finalFiles: string[] = [];
  for (let i = 0; i < llmKept.length; i++) {
    const finalName = path.join(imgDir, `frame_${String(i).padStart(3, "0")}.jpg`);
    try {
      execSync(`mv "${llmKept[i].file}" "${finalName}"`);
      finalFiles.push(finalName);
    } catch (e) {
      finalFiles.push(llmKept[i].file);
    }
  }

  // Clean up remaining raw frames
  try {
    execSync(`rm -f ${imgDir}/raw_*.jpg`);
  } catch {}

  // Cleanup video
  try {
    execSync(`rm -f "${videoFile}"`);
  } catch {}

  return finalFiles;
}

// --- LLM Frame Evaluation ---
// Uses OpenRouter + gpt-4o-mini to evaluate if a frame adds value to the transcript
function llmEvaluateFrame(imagePath: string, transcriptContext: string): string | null {
  try {
    // Read image as base64
    const imgData = readFileSync(imagePath);
    const base64 = imgData.toString("base64");

    const body = JSON.stringify({
      model: "openai/gpt-4o-mini",
      messages: [{
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: { url: `data:image/jpeg;base64,${base64}` }
          },
          {
            type: "text",
            text: `This frame is from a financial/technical video. The speaker is saying nearby: "${transcriptContext}"

Does this image add significant information or understanding beyond what the transcript conveys? For example:
- Charts with specific data points not mentioned in speech
- Diagrams explaining concepts
- Tables with numbers
- Code snippets
- Visual comparisons

If the image is just a talking head, generic background, title screen, or shows the same info already in the transcript, say NO.

Respond with exactly: YES: <one sentence why> or NO`
          }
        ]
      }],
      max_tokens: 100,
      temperature: 0.1
    });

    const response = execSync(
      `curl -s -m 30 -X POST "https://openrouter.ai/api/v1/chat/completions" \
        -H "Authorization: Bearer ${process.env.OPENROUTER_API_KEY}" \
        -H "Content-Type: application/json" \
        -d '${body}'`,
      { timeout: 35000 }
    ).toString();

    const data = JSON.parse(response);
    const content = data.choices?.[0]?.message?.content?.trim() || "";

    if (content.startsWith("YES:")) {
      return content.slice(4).trim();
    }
    return null;
  } catch (e) {
    console.error(`  LLM eval error: ${e}`);
    return null; // On error, keep the frame (fail open)
  }
}

// Embed image references into transcript at the appropriate timestamp positions
// Format: [img:<file>, desc:'<description>']
function embedImagesInTranscript(transcript: string, imagePaths: string[]): string {
  if (imagePaths.length === 0) return transcript;

  const lines = transcript.split("\n");
  const result: string[] = [];
  let imgIndex = 0;

  for (let i = 0; i < lines.length; i++) {
    result.push(lines[i]);

    // Check if next line's timestamp matches an image
    const nextMatch = lines[i + 1]?.match(/^\[(\d{2}):(\d{2})\]/);
    if (!nextMatch) continue;

    const nextSec = parseInt(nextMatch[1]) * 60 + parseInt(nextMatch[2]);
    if (imgIndex >= imagePaths.length) break;

    const imgFile = imagePaths[imgIndex];
    const imgBase = path.basename(imgFile);
    const imgSecMatch = imgBase.match(/^(\d+)/);
    const imgSec = imgSecMatch ? parseInt(imgSecMatch[1]) : 0;

    // If the next transcript line is within 10s of this image, insert the image ref
    if (Math.abs(nextSec - imgSec) <= 10) {
      result.push(`[img:${imgFile}]`);
      imgIndex++;
    }
  }

  // If any images weren't embedded, append them at the end
  while (imgIndex < imagePaths.length) {
    result.push(`[img:${imagePaths[imgIndex]}]`);
    imgIndex++;
  }

  return result.join("\n");
}

// --- Process Mode: Handle one video from queue ---
async function processOne(): Promise<void> {
  const db = ensureDB();

  // Get next queued video
  const row = db.prepare("SELECT video_id, channel_id, title FROM queue ORDER BY enqueued_at ASC LIMIT 1").get();
  if (!row) {
    console.log("Queue is empty.");
    db.close();
    return;
  }

  console.log(`\nProcessing: ${row.title} (${row.video_id})`);

  // Remove from queue
  db.run("DELETE FROM queue WHERE video_id = ?", [row.video_id]);

  let transcript = null;
  let rateLimited = false;
  try {
    const result = fetchTranscript(row.video_id);
    transcript = result.transcript;
    rateLimited = result.rateLimited;
  } catch (e: any) {
    console.error(`  Error fetching transcript: ${e.message}`);
  }

  // Add a delay between transcript fetches to avoid rate limiting
  console.log("  Waiting 30s before next fetch...");
  await new Promise(r => setTimeout(r, 30000));

  const videoDir = path.join(IMG_BASE, row.video_id);
  mkdirSync(videoDir, { recursive: true });

  let imagePaths: string[] = [];
  if (transcript) {
    try {
      imagePaths = extractUniqueFrames(row.video_id, transcript);
    } catch (e: any) {
      console.error(`  Error extracting frames: ${e.message}`);
    }
  }

  // Update video status
  if (transcript) {
    // Embed image references into transcript
    const embedded = embedImagesInTranscript(transcript, imagePaths);
    db.run(`UPDATE videos SET status = 'processed', transcript = ?, processed_at = datetime('now') WHERE video_id = ?`,
      [embedded, row.video_id]);

    // Store image references
    const imgStmt = db.prepare(`
      INSERT OR REPLACE INTO images (video_id, file_path, timestamp_sec)
      VALUES (?, ?, ?)
    `);
    for (const img of imagePaths) {
      const basename = path.basename(img);
      const tsMatch = basename.match(/^(\d+)/);
      const tsSec = tsMatch ? parseInt(tsMatch[1]) : 0;
      imgStmt.run(row.video_id, img, tsSec);
    }

    console.log(`  Transcript: ${embedded.length} chars`);
    console.log(`  Images: ${imagePaths.length}`);
  } else if (rateLimited) {
    // Re-queue for later retry when rate limit clears
    db.run(`INSERT OR IGNORE INTO queue (video_id, channel_id, title) VALUES (?, ?, ?)`,
      [row.video_id, row.channel_id, row.title]);
    db.run(`UPDATE videos SET status = 'rate_limited', error = 'YouTube 429 rate limit', processed_at = datetime('now') WHERE video_id = ?`,
      [row.video_id]);
    console.log("  Rate limited (429) - will retry later");
  } else {
    db.run(`UPDATE videos SET status = 'failed', error = 'transcript fetch failed', processed_at = datetime('now') WHERE video_id = ?`,
      [row.video_id]);
    console.log("  Transcript fetch failed");
  }

  db.close();
}

// --- Process All Mode ---
async function processAll(): Promise<void> {
  while (true) {
    const db = ensureDB();
    const count = db.prepare("SELECT COUNT(*) as c FROM queue").get().c;
    db.close();
    if (count === 0) break;
    await processOne();
  }
  console.log("\nAll queued videos processed.");
}

// --- Fetch Transcripts Mode: Process all rate_limited videos when rate limit clears ---
function fetchTranscripts(): void {
  const db = ensureDB();

  const rateLimited = db.prepare("SELECT video_id, channel_id, title FROM videos WHERE status = 'rate_limited' ORDER BY processed_at ASC").all();
  if (rateLimited.length === 0) {
    console.log("No rate-limited videos to process.");
    db.close();
    return;
  }

  console.log(`Processing ${rateLimited.length} rate-limited videos...`);

  for (const row of rateLimited) {
    console.log(`\nRetrying: ${row.title} (${row.video_id})`);

    let transcript = null;
    let rateLimitedAgain = false;
    try {
      const result = fetchTranscript(row.video_id);
      transcript = result.transcript;
      rateLimitedAgain = result.rateLimited;
    } catch (e: any) {
      console.error(`  Error fetching transcript: ${e.message}`);
    }

    const videoDir = path.join(IMG_BASE, row.video_id);
    mkdirSync(videoDir, { recursive: true });

    if (transcript) {
      let imagePaths: string[] = [];
      try {
        imagePaths = extractUniqueFrames(row.video_id, transcript);
      } catch (e: any) {
        console.error(`  Error extracting frames: ${e.message}`);
      }

      const embedded = embedImagesInTranscript(transcript, imagePaths);
      db.run(`UPDATE videos SET status = 'processed', transcript = ?, processed_at = datetime('now') WHERE video_id = ?`,
        [embedded, row.video_id]);

      const imgStmt = db.prepare(`
        INSERT OR REPLACE INTO images (video_id, file_path, timestamp_sec)
        VALUES (?, ?, ?)
      `);
      for (const img of imagePaths) {
        const basename = path.basename(img);
        const tsMatch = basename.match(/^(\d+)/);
        const tsSec = tsMatch ? parseInt(tsMatch[1]) : 0;
        imgStmt.run(row.video_id, img, tsSec);
      }

      console.log(`  Transcript: ${embedded.length} chars`);
      console.log(`  Images: ${imagePaths.length}`);
    } else if (rateLimitedAgain) {
      console.log("  Still rate limited (429) - will retry later");
      db.close();
      return; // Stop processing if still rate limited
    } else {
      db.run(`UPDATE videos SET status = 'failed', error = 'transcript fetch failed', processed_at = datetime('now') WHERE video_id = ?`,
        [row.video_id]);
      console.log("  Transcript fetch failed");
    }
  }

  console.log("\nDone processing rate-limited videos.");
  db.close();
}

// --- Status Mode ---
function status(): void {
  const db = ensureDB();

  const queued = db.prepare("SELECT COUNT(*) as c FROM queue").get().c;
  const processed = db.prepare("SELECT COUNT(*) as c FROM videos WHERE status = 'processed'").get().c;
  const failed = db.prepare("SELECT COUNT(*) as c FROM videos WHERE status = 'failed'").get().c;
  const rateLimited = db.prepare("SELECT COUNT(*) as c FROM videos WHERE status = 'rate_limited'").get().c;
  const images = db.prepare("SELECT COUNT(*) as c FROM images").get().c;

  console.log(`Queue: ${queued}`);
  console.log(`Processed: ${processed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Rate-limited: ${rateLimited}`);
  console.log(`Images stored: ${images}`);

  if (queued > 0) {
    console.log("\nNext in queue:");
    const next = db.prepare("SELECT title FROM queue ORDER BY enqueued_at ASC LIMIT 1").get();
    console.log(`  ${next?.title}`);
  }

  db.close();
}

// --- Main ---
const mode = process.argv[2];
switch (mode) {
  case "scan":
    scan();
    break;
  case "process":
    processOne().catch(e => console.error(e));
    break;
  case "process-all":
    processAll().catch(e => console.error(e));
    break;
  case "fetch-transcripts":
    fetchTranscripts();
    break;
  case "status":
    status();
    break;
  default:
    console.log("Usage: watcher.ts [scan|process|process-all|fetch-transcripts|status]");
    break;
}

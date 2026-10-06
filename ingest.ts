/**
 * YouTube ingestion service.
 *
 * Usage:
 *   npx tsx ingest.ts                    # ingest all channels
 *   npx tsx ingest.ts --channel CH_ID    # ingest specific channel
 *   npx tsx ingest.ts --dry-run          # show what would be ingested
 */
import { execFileSync } from 'node:child_process';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import { getDb, upsertChannel, upsertVideo, upsertTranscript, hasVideo, getTranscript, setLinks, setChapters, closeDb } from './db.ts';
import type { Chapter, Link } from './db.ts';
import { captureScreenshots } from './screenshots.ts';
import { transcribeVideo } from './transcribe.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHANNELS_FILE = path.join(__dirname, 'channels.json');

interface ChannelConfig {
  channel_id: string;
  handle: string;
  name?: string;
}

function loadChannels(): ChannelConfig[] {
  if (!fs.existsSync(CHANNELS_FILE)) {
    console.error(`No channels config at ${CHANNELS_FILE}`);
    return [];
  }
  return JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf8'));
}

function ytDlp(args: string[]): string {
  try {
    return execFileSync('yt-dlp', args, {
      encoding: 'utf8',
      timeout: 120000,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PATH: `/home/aaron/.local/bin:${process.env.PATH}` },
    });
  } catch (e: any) {
    throw new Error(`yt-dlp failed: ${e.stderr || e.message}`);
  }
}

/** Extract chapters from yt-dlp --dump-json metadata. */
export function extractChapters(json: string): Chapter[] {
  try {
    const meta = JSON.parse(json);
    if (!meta.chapters || !Array.isArray(meta.chapters)) return [];
    return meta.chapters
      .filter((c: any) => c.start_time !== undefined && c.title)
      .map((c: any) => ({ start_seconds: c.start_time, title: c.title }));
  } catch {
    return [];
  }
}

/** Fetch video metadata JSON via yt-dlp --dump-json. */
function fetchVideoJson(videoId: string): string | null {
  try {
    return ytDlp([
      '--no-update', '--no-warnings', '--skip-download', '--dump-json',
      `https://www.youtube.com/watch?v=${videoId}`,
    ]);
  } catch {
    return null;
  }
}

/** Resolve a channel handle to its channel ID using yt-dlp. */
function resolveChannelId(handle: string): string | null {
  try {
    const output = execFileSync('yt-dlp', [
      '--no-update', '--no-warnings', '--skip-download',
      '--print', '%(channel_id)s',
      `https://www.youtube.com/@${handle}/videos`,
    ], { encoding: 'utf8', timeout: 30000, env: { ...process.env, PATH: `/home/aaron/.local/bin:${process.env.PATH}` } }).trim();
    const lines = output.split('\n').filter(l => l.startsWith('UC'));
    return lines[0] || null;
  } catch {
    return null;
  }
}

/** List recent uploads for a channel using yt-dlp. */
function listChannelVideos(channelId: string, maxAgeDays: number = 30): Array<{ video_id: string; title: string; published_at: string }> {
  // Use the channel's videos URL
  const url = `https://www.youtube.com/channel/${channelId}/videos`;
  const output = ytDlp([
    '--no-update', '--no-warnings', '--skip-download',
    '--print', '%(id)s\t%(title)s\t%(upload_date)s',
    '--playlist-end', '20', // Limit to 20 most recent
    url,
  ]);

  const videos: Array<{ video_id: string; title: string; published_at: string }> = [];
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

  for (const line of output.trim().split('\n')) {
    if (!line) continue;
    const [id, ...rest] = line.split('\t');
    if (!id) continue;
    const fields = line.split('\t');
    if (fields.length < 3) continue;
    const [vid, title, dateStr] = [fields[0], fields[1], fields[2].trim()];
    // dateStr is like "20260720"
    const publishedAt = new Date(`${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`).toISOString();
    if (new Date(publishedAt).getTime() >= cutoff) {
      videos.push({ video_id: vid, title, published_at: publishedAt });
    }
  }

  return videos;
}

/** Fetch transcript using Python youtube-transcript-api. */
function fetchTranscriptPython(videoId: string): string | null {
  const script = `
import sys
from youtube_transcript_api import YouTubeTranscriptApi, TranscriptsDisabled, NoTranscriptFound
video_id = "${videoId}"
try:
    api = YouTubeTranscriptApi()
    transcript = api.fetch(video_id, languages=["en", "en-orig"])
    text = " ".join([snip.text for snip in transcript.snippets])
    print(text)
except TranscriptsDisabled:
    sys.exit(2)
except NoTranscriptFound:
    sys.exit(3)
except Exception as e:
    print(f"ERROR: {e}", file=sys.stderr)
    sys.exit(1)
`;

  try {
    return execFileSync('python3', ['-c', script], {
      encoding: 'utf8',
      timeout: 60000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (e: any) {
    // Exit code 2 = transcripts disabled, 3 = not found — not errors
    if (e.status === 2 || e.status === 3) return null;
    console.warn(`  [transcript] Python API failed for ${videoId}: ${e.stderr?.slice(0, 200)}`);
    return null;
  }
}

/** Fetch transcript using yt-dlp as fallback. */
function fetchTranscriptYtDlp(videoId: string): string | null {
  const tmpDir = fs.mkdtempSync('/tmp/ytcap-');
  try {
    execFileSync('yt-dlp', [
      '--no-update', '--no-warnings', '--skip-download',
      '--write-auto-subs', '--sub-langs', 'en',
      '--sub-format', 'vtt',
      '-o', `${tmpDir}/%(id)s.%(ext)s`,
      `https://www.youtube.com/watch?v=${videoId}`,
    ], { timeout: 60000 });

    const files = fs.readdirSync(tmpDir);
    const vttFile = files.find(f => f.endsWith('.en.vtt') || f.endsWith('.vtt'));
    if (!vttFile) return null;

    // Clean VTT: dedupe rolling captions, strip tags, format as [MM:SS] text
    const cleaned = execFileSync('python3', [
      path.join(__dirname, 'clean_vtt.py'),
      path.join(tmpDir, vttFile)
    ], { timeout: 10000 }).toString().trim();

    return cleaned || null;
  } catch (e: any) {
    console.warn(`  [transcript] yt-dlp fallback failed for ${videoId}: ${e.stderr?.slice(0, 200)}`);
    return null;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** Ingest a single video: fetch metadata + transcript, store in DB. */
async function ingestVideo(videoId: string, channelId: string, title: string, publishedAt: string, dryRun: boolean): Promise<void> {
  if (dryRun) {
    console.log(`  [dry-run] Would ingest ${videoId}: ${title}`);
    return;
  }

  // Always upsert the video metadata (idempotent)
  upsertVideo(videoId, channelId, title, publishedAt);

  // Fetch chapters from yt-dlp metadata (non-fatal if unavailable)
  let chapters: Chapter[] = [];
  const json = fetchVideoJson(videoId);
  if (json) {
    chapters = extractChapters(json);
    setChapters(videoId, chapters);
    if (chapters.length > 0) console.log(`    Chapters: ${chapters.length}`);
  }

  // Capture screenshots at chapter timestamps (non-fatal)
  if (chapters.length > 0) {
    try {
      captureScreenshots(videoId);
    } catch (e: any) {
      console.warn(`    Screenshot capture failed: ${e.message?.slice(0, 100)}`);
    }
  }

  // Skip transcript fetch if we already have it
  if (getTranscript(videoId)) {
    return;
  }

  console.log(`  Fetching transcript ${videoId}: ${title}`);

  // Fetch transcript: Python API → yt-dlp → STT (whisper via 9router)
  let transcript = fetchTranscriptPython(videoId);
  if (!transcript) {
    transcript = fetchTranscriptYtDlp(videoId);
  }
  if (!transcript && process.env.ENABLE_STT === 'true') {
    console.log(`    Trying STT transcription...`);
    transcript = await transcribeVideo(videoId);
  }

  if (transcript) {
    upsertTranscript(videoId, transcript);
    console.log(`    Transcript: ${transcript.length} chars`);
  } else {
    console.log(`    No transcript available (will retry next run)`);
  }

  // Extract and store links from description
  try {
    const description = fetchDescription(videoId);
    if (description) {
      const links = extractAndClassifyLinks(description);
      if (links.length > 0) {
        setLinks(videoId, links);
        console.log(`    Links: ${links.length}`);
      }
    }
  } catch (e: any) {
    console.warn(`    Link extraction failed: ${e.message?.slice(0, 100)}`);
  }

  // Rate limit: sleep between transcript fetches
  sleep(15000);
}

/** Extract URLs from text. */
export function extractUrls(text: string): string[] {
  return text.match(/https?:\/\/[\S]+/g) ?? [];
}

/** Classify a URL by type. */
export function classifyUrl(url: string): string {
  if (url.includes('github.com')) return 'github';
  if (url.includes('arxiv.org')) return 'arxiv';
  if (url.includes('/docs/') || url.includes('docs.')) return 'docs';
  return 'promo';
}

/** Extract, dedupe, and classify links from video description. */
export function extractAndClassifyLinks(description: string): Link[] {
  const urls = extractUrls(description);
  const seen = new Set<string>();
  const links: Link[] = [];
  for (const url of urls) {
    if (seen.has(url)) continue;
    seen.add(url);
    links.push({ url, type: classifyUrl(url) });
  }
  return links;
}

/** Fetch video description via yt-dlp. */
function fetchDescription(videoId: string): string | null {
  try {
    const output = execFileSync('yt-dlp', [
      '--no-update', '--no-warnings', '--skip-download',
      '--print', '%(description)s',
      `https://www.youtube.com/watch?v=${videoId}`,
    ], { encoding: 'utf8', timeout: 30000, env: { ...process.env, PATH: `/home/aaron/.local/bin:${process.env.PATH}` } });
    return output.trim();
  } catch {
    return null;
  }
}

function sleep(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* spin */ }
}

async function ingestChannel(channel: ChannelConfig, dryRun: boolean): Promise<number> {
  // Resolve handle to channel ID if needed
  let channelId = channel.channel_id;
  if (!channelId.startsWith('UC')) {
    console.log(`[channel] Resolving ${channel.handle} to channel ID...`);
    const resolved = resolveChannelId(channel.handle);
    if (!resolved) {
      console.warn(`  Could not resolve channel ID for ${channel.handle}`);
      return 0;
    }
    channelId = resolved;
    console.log(`  Resolved to ${channelId}`);
  }
  console.log(`[channel] ${channel.handle} (${channelId})`);
  upsertChannel(channelId, channel.handle, channel.name);

  let videos;
  try {
    videos = listChannelVideos(channelId);
  } catch (e: any) {
    console.warn(`  Failed to list videos: ${e.message.slice(0, 200)}`);
    return 0;
  }

  console.log(`  Found ${videos.length} recent videos`);
  let ingested = 0;
  for (const v of videos) {
    await ingestVideo(v.video_id, channelId, v.title, v.published_at, dryRun);
    ingested++;
  }
  return ingested;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const channelFilter = args.find(a => a === '--channel');
  const channelValue = channelFilter ? args[args.indexOf(channelFilter) + 1] : null;

  const channels = loadChannels();
  const filtered = channelValue
    ? channels.filter(c => c.channel_id === channelValue || c.handle === channelValue)
    : channels;

  console.log(`[youtube-ingest] Starting ingestion of ${filtered.length} channel(s)${dryRun ? ' (dry-run)' : ''}`);

  let totalVideos = 0;
  for (const ch of filtered) {
    try {
      totalVideos += await ingestChannel(ch, dryRun);
    } catch (e: any) {
      console.error(`  Error ingesting ${ch.handle}: ${e.message.slice(0, 200)}`);
    }
  }

  console.log(`[youtube-ingest] Done. Processed ${totalVideos} video(s).`);
  closeDb();
}

// Run main only when executed directly, not when imported
const isMain = process.argv[1] && (process.argv[1].endsWith('ingest.ts') || process.argv[1].endsWith('ingest.js'));
if (isMain) {
  main().catch(e => {
  console.error(`[youtube-ingest] Fatal: ${e.message}`);
  closeDb();
  process.exit(1);
});
}

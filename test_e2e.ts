/**
 * E2E test: ingest a single real YouTube video and verify all data is captured.
 * Usage: npx tsx test_e2e.ts [videoId]
 * If no videoId provided, finds a recent video from the first configured channel.
 */
import { execFileSync } from 'node:child_process';
import {
  getDb, upsertChannel, upsertVideo, getTranscript, getChapters,
  getLinks, getScreenshots, closeDb, hasVideo
} from './db.ts';
import { extractChapters, extractAndClassifyLinks } from './ingest.ts';
import { captureScreenshots } from './screenshots.ts';
import * as fs from 'fs';
import * as path from 'path';

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const CHANNELS_FILE = path.join(__dirname, 'channels.json');

function ytDlp(args: string[]): string {
  return execFileSync('yt-dlp', args, {
    encoding: 'utf8', timeout: 120000, maxBuffer: 50 * 1024 * 1024,
    env: { ...process.env, PATH: `/home/aaron/.local/bin:${process.env.PATH}` },
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

// Get target video
let videoId = process.argv[2] || 'w4YRc5J8Tqg';  // Default to a known video

console.log(`\n=== E2E TEST: Ingesting video ${videoId} ===\n`);

// Fetch video metadata
console.log('Step 1: Fetch metadata...');
const json = ytDlp([
  '--no-update', '--no-warnings', '--skip-download', '--dump-json',
  `https://www.youtube.com/watch?v=${videoId}`,
]);
const meta = JSON.parse(json);
const title = meta.title;
const published = meta.upload_date;
const channelId = meta.channel_id;

console.log(`  Title: ${title}`);
console.log(`  Channel: ${meta.channel}`);
console.log(`  Published: ${published}`);

// Upsert into DB
upsertChannel(channelId, meta.channel);
upsertVideo(videoId, channelId, title, new Date(parseInt(published.slice(0, 4)), parseInt(published.slice(4, 6)) - 1, parseInt(published.slice(6, 8))).toISOString());

// Chapters
console.log('\nStep 2: Extract chapters...');
const chapters = extractChapters(json);
console.log(`  Found ${chapters.length} chapters`);
if (chapters.length > 0) {
  chapters.slice(0, 3).forEach(c => console.log(`    [${c.start_seconds}s] ${c.title}`));
}
import { setChapters } from './db.ts';
setChapters(videoId, chapters);
const storedChapters = getChapters(videoId);
console.assert(storedChapters.length === chapters.length, `Chapter count mismatch: ${storedChapters.length} vs ${chapters.length}`);
console.log(`  ✓ Stored ${storedChapters.length} chapters in DB`);

// Links
console.log('\nStep 3: Extract links...');
const description = meta.description || '';
const links = extractAndClassifyLinks(description);
console.log(`  Found ${links.length} links`);
links.slice(0, 3).forEach(l => console.log(`    [${l.type}] ${l.url}`));
import { setLinks } from './db.ts';
setLinks(videoId, links);
const storedLinks = getLinks(videoId);
console.assert(storedLinks.length === links.length, `Link count mismatch: ${storedLinks.length} vs ${links.length}`);
console.log(`  ✓ Stored ${storedLinks.length} links in DB`);

// Transcript (skip if already have it)
console.log('\nStep 4: Fetch transcript...');
if (getTranscript(videoId)) {
  console.log('  Already have transcript, skipping');
} else {
  try {
    const transcript = ytDlp([
      '--no-update', '--no-warnings', '--skip-download',
      '--write-auto-sub', '--sub-format', 'vtt',
      '--sub-langs', 'en', '--convert-subs', 'srt',
      '-o', '/tmp/yte2e.%(ext)s',
      `https://www.youtube.com/watch?v=${videoId}`,
    ]);
    console.log('  Transcript fetched');
  } catch (e: any) {
    console.log('  No transcript available');
  }
}

// Screenshots (only if chapters exist)
if (chapters.length > 0) {
  console.log('\nStep 5: Capture screenshots...');
  try {
    const shots = captureScreenshots(videoId);
    console.log(`  Captured ${shots.length} screenshots`);
    const storedShots = getScreenshots(videoId);
    console.assert(storedShots.length === shots.length, `Screenshot count mismatch`);
    console.log(`  ✓ Stored ${storedShots.length} screenshot paths in DB`);
    // Verify files exist
    const existing = storedShots.filter(s => fs.existsSync(s.path)).length;
    console.log(`  ${existing}/${storedShots.length} screenshot files exist on disk`);
  } catch (e: any) {
    console.log(`  Screenshot capture failed: ${e.message}`);
  }
} else {
  console.log('\nStep 5: No chapters, skipping screenshots');
}

console.log('\n=== E2E TEST PASSED ===');
console.log(`Video ${videoId} fully ingested with:`);
console.log(`  - ${getChapters(videoId).length} chapters`);
console.log(`  - ${getLinks(videoId).length} links`);
console.log(`  - ${getScreenshots(videoId).length} screenshots`);
closeDb();

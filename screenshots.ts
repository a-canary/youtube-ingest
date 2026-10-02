/**
 * Capture one screenshot per chapter (max 6) using yt-dlp + ffmpeg.
 * Non-fatal: failures are logged and skipped, never thrown.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { getChapters, getScreenshots, setScreenshots } from './db.ts';
import type { Screenshot } from './db.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOTS_DIR = path.join(__dirname, 'data', 'screenshots');
const MAX_SCREENSHOTS = 6;

export function formatTimestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * Capture screenshots at chapter timestamps for a video.
 * Returns the array of screenshot records (empty if no chapters or on failure).
 */
export function captureScreenshots(videoId: string): Screenshot[] {
  try {
    const chapters = getChapters(videoId);
    if (chapters.length === 0) return [];

    // Already captured? Skip.
    if (getScreenshots(videoId).length > 0) return getScreenshots(videoId);

    // Cap at MAX_SCREENSHOTS chapters
    const selected = chapters.slice(0, MAX_SCREENSHOTS);

    const videoDir = path.join(SCREENSHOTS_DIR, videoId);
    fs.mkdirSync(videoDir, { recursive: true });

    const tmpDir = fs.mkdtempSync('/tmp/ytcap-');
    const screenshots: Screenshot[] = [];

    try {
      for (const ch of selected) {
        const ts = formatTimestamp(ch.start_seconds);
        const outPath = path.join(videoDir, `${ch.start_seconds}.jpg`);
        if (fs.existsSync(outPath)) {
          screenshots.push({ timestamp: ch.start_seconds, path: outPath });
          continue;
        }
        try {
          const segPath = downloadSegment(videoId, ch.start_seconds, tmpDir);
          if (segPath && extractFrame(segPath, outPath, ch.start_seconds)) {
            screenshots.push({ timestamp: ch.start_seconds, path: outPath });
          }
        } catch (e: any) {
          console.warn(`    Screenshot failed for chapter at ${ts}: ${e.message?.slice(0, 100)}`);
        }
      }

      if (screenshots.length > 0) {
        setScreenshots(videoId, screenshots);
        console.log(`    Screenshots: ${screenshots.length}`);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    return screenshots;
  } catch (e: any) {
    console.warn(`    captureScreenshots failed for ${videoId}: ${e.message?.slice(0, 100)}`);
    return [];
  }
}

/** Download a ~5s segment around the given timestamp. Returns path or null. */
function downloadSegment(videoId: string, timestamp: number, tmpDir: string): string | null {
  const start = Math.max(0, timestamp - 1);
  const end = timestamp + 4;
  const outTemplate = path.join(tmpDir, 'seg_%(section_number)s.%(ext)s');

  try {
    execFileSync('yt-dlp', [
      '--no-update', '--no-warnings',
      '--format', 'worst[ext=mp4]/worst[height<=480]/worst',
      '--download-sections', `*${formatTimestamp(start)}-${formatTimestamp(end)}`,
      '-o', outTemplate,
      `https://www.youtube.com/watch?v=${videoId}`,
    ], {
      timeout: 90000,
      env: { ...process.env, PATH: `/home/aaron/.local/bin:${process.env.PATH}` },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const files = fs.readdirSync(tmpDir);
    const seg = files.find(f => f.startsWith('seg_') && f.endsWith('.mp4'));
    return seg ? path.join(tmpDir, seg) : null;
  } catch {
    return null;
  }
}

/** Extract one frame at the chapter timestamp from a video segment. */
function extractFrame(input: string, output: string, timestamp: number): boolean {
  try {
    // Seek to the exact chapter time within the segment
    execFileSync('ffmpeg', [
      '-y', '-i', input,
      '-ss', String(Math.max(0, timestamp - 1)),
      '-frames:v', '1',
      '-q:v', '2',
      '-vf', 'scale=640:-2',
      output,
    ], { timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] });
    return fs.existsSync(output) && fs.statSync(output).size > 0;
  } catch {
    return false;
  }
}

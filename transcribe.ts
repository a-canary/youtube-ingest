import { execFileSync } from 'node:child_process';
import * as fs from 'fs';
import * as path from 'path';

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const AUDIO_DIR = path.join(__dirname, 'audio');

// 9router API config — adjust base URL / key when service is running
const STT_BASE = process.env.STT_BASE_URL || 'http://127.0.0.1:7890/v1';
const STT_KEY = process.env.STT_API_KEY || '';
const STT_MODEL = process.env.STT_MODEL || 'whisper-large-v3';

function ytDlp(args: string[]): string {
  return execFileSync('yt-dlp', args, {
    encoding: 'utf8', timeout: 120000, maxBuffer: 50 * 1024 * 1024,
    env: { ...process.env, PATH: `/home/aaron/.local/bin:${process.env.PATH}` },
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

/**
 * Extract audio from a YouTube video and return the local file path.
 */
export function extractAudio(videoId: string): string {
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
  const outPath = path.join(AUDIO_DIR, `${videoId}.mp3`);
  if (fs.existsSync(outPath)) return outPath;

  ytDlp([
    '--no-update', '--no-warnings',
    '-x', '--audio-format', 'mp3',
    '-o', outPath,
    `https://www.youtube.com/watch?v=${videoId}`,
  ]);

  if (!fs.existsSync(outPath)) {
    throw new Error(`Audio extraction failed: ${outPath} not found`);
  }
  return outPath;
}

/**
 * Transcribe audio using 9router STT API (OpenAI-compatible /audio/transcriptions).
 * Returns the transcript text.
 */
export async function transcribeAudio(audioPath: string, model: string = STT_MODEL): Promise<string> {
  const formData = new FormData();
  formData.append('model', model);
  formData.append('file', new File([fs.readFileSync(audioPath)], path.basename(audioPath)));

  const res = await fetch(`${STT_BASE}/audio/transcriptions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${STT_KEY}` },
    body: formData,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`STT API error (${res.status}): ${err}`);
  }

  const json = await res.json();
  return json.text || '';
}

/**
 * Full pipeline: extract audio from video, transcribe it.
 * Returns the transcript text, or null if transcription is unavailable.
 */
export async function transcribeVideo(videoId: string): Promise<string | null> {
  try {
    const audioPath = extractAudio(videoId);
    const text = await transcribeAudio(audioPath);
    return text;
  } catch (e: any) {
    console.error(`Transcription failed for ${videoId}: ${e.message}`);
    return null;
  }
}

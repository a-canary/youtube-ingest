import { extractChapters } from './ingest.ts';

// Video with chapters
const withChapters = JSON.stringify({
  chapters: [
    { start_time: 0, end_time: 30, title: 'Intro' },
    { start_time: 30, end_time: 120, title: 'Main Content' },
    { start_time: 120, end_time: 200, title: 'Outro' },
  ],
});

// Video with no chapters
const noChapters = JSON.stringify({});

// Malformed JSON
const bad = 'not json';

const c1 = extractChapters(withChapters);
if (c1.length !== 3) throw new Error(`expected 3 chapters, got ${c1.length}`);
if (c1[0].start_seconds !== 0) throw new Error('chapter 0 start wrong');
if (c1[0].title !== 'Intro') throw new Error('chapter 0 title wrong');
if (c1[2].start_seconds !== 120) throw new Error('chapter 2 start wrong');

const c2 = extractChapters(noChapters);
if (c2.length !== 0) throw new Error(`expected 0 chapters, got ${c2.length}`);

const c3 = extractChapters(bad);
if (c3.length !== 0) throw new Error(`expected 0 chapters for bad json, got ${c3.length}`);

console.log('ok: extractChapters tests passed');

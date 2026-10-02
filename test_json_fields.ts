import {
  getDb, upsertChannel, upsertVideo,
  getChapters, setChapters,
  getLinks, setLinks,
  getScreenshots, setScreenshots,
  closeDb
} from './db.ts';

const vid = 'test-vid-1';
const ch = 'test-channel';

upsertChannel(ch, '@test');
upsertVideo(vid, ch, 'Test Video', new Date().toISOString());

// Chapters
const chapters = [{ start_seconds: 0, title: 'Intro' }, { start_seconds: 120, title: 'Main' }];
setChapters(vid, chapters);
const gotChapters = getChapters(vid);
console.assert(JSON.stringify(gotChapters) === JSON.stringify(chapters), 'chapters mismatch');

// Links
const links = [{ url: 'https://example.com', type: 'reference', title: 'Example' }];
setLinks(vid, links);
const gotLinks = getLinks(vid);
console.assert(JSON.stringify(gotLinks) === JSON.stringify(links), 'links mismatch');

// Screenshots
const shots = [{ timestamp: 30, path: '/tmp/shot1.jpg' }];
setScreenshots(vid, shots);
const gotShots = getScreenshots(vid);
console.assert(JSON.stringify(gotShots) === JSON.stringify(shots), 'screenshots mismatch');

console.log('All JSON field tests passed');
closeDb();

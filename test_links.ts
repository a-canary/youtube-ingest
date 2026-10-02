import { extractAndClassifyLinks } from './ingest.ts';

const desc = `Check out my repo: https://github.com/aaron/test-repo
Paper: https://arxiv.org/abs/2401.12345
Docs: https://docs.example.com/guide
Also https://github.com/aaron/test-repo again (dup)
Buy stuff: https://shop.example.com/deal
No url here just text`;

const links = extractAndClassifyLinks(desc);

console.log('Links found:', links.length);
for (const l of links) {
  console.log(`  ${l.type}: ${l.url}`);
}

// Verify extraction
const urls = links.map(l => l.url);
console.assert(urls.includes('https://github.com/aaron/test-repo'), 'missing github url');
console.assert(urls.includes('https://arxiv.org/abs/2401.12345'), 'missing arxiv url');
console.assert(urls.includes('https://docs.example.com/guide'), 'missing docs url');
console.assert(urls.includes('https://shop.example.com/deal'), 'missing promo url');

// Verify dedup
console.assert(urls.filter(u => u === 'https://github.com/aaron/test-repo').length === 1, 'github url duplicated');

// Verify classification
const types = Object.fromEntries(links.map(l => [l.url, l.type]));
console.assert(types['https://github.com/aaron/test-repo'] === 'github', 'github misclassified');
console.assert(types['https://arxiv.org/abs/2401.12345'] === 'arxiv', 'arxiv misclassified');
console.assert(types['https://docs.example.com/guide'] === 'docs', 'docs misclassified');
console.assert(types['https://shop.example.com/deal'] === 'promo', 'promo misclassified');

// Verify no-link case
const empty = extractAndClassifyLinks('Just some text, no links here');
console.assert(empty.length === 0, 'should be empty');

console.log('All tests passed');

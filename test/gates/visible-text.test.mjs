import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { visibleText, wordDiff } from '../../skills/parity-gates/scripts/lib/visible-text.mjs';

const SITE = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixture', 'site');
const page = (rel) => readFileSync(join(SITE, rel), 'utf8');

// Worked out by hand from the <main> of test/fixture/site/contact/index.html (served at /contact/):
// the aria-hidden honeypot paragraph is dropped and form controls carry no text.
const CONTACT_TEXT =
  'Contact Fill in the form and we will get back to you within one business day. Name Email Message Send';

// Worked out by hand from the <main> of test/fixture/site/index.html: the carousel <nav>,
// the noscript image and the display:none promo banner are dropped; &nbsp; becomes a space,
// &shy; disappears; text nodes are joined with single spaces.
const HOME_TEXT =
  'Roofs and siding built to last ' +
  'Free estimates, honest prices and a crew that cleans up after itself. Call us at 555-555-0100 today. ' +
  'Get a free estimate What we do ' +
  'From storm repairs to full replacements, we handle weatherproofing for every kind of home. ' +
  'Roofing Siding Cedar shake repair Fiber cement siding Storm damage call-out ' +
  'Meet the people behind every job on our about page . Warranty registration';

test('visibleText of the fixture contact page is its main content only', () => {
  const text = visibleText(page('contact/index.html'));
  assert.equal(text, CONTACT_TEXT);
  assert.ok(!text.includes('Website'), 'aria-hidden honeypot is dropped');
  assert.ok(!text.includes('Home'), 'nav is dropped');
  assert.ok(!text.includes('brochure'), 'footer is dropped');
  assert.ok(!text.includes('Skip to content'), 'content outside <main> is dropped');
});

test('visibleText ignores display:none, noscript, nav, NBSP and soft hyphens', () => {
  const text = visibleText(page('index.html'));
  assert.equal(text, HOME_TEXT);
  assert.ok(!text.includes('Winter special'), 'display:none block is dropped');
  assert.ok(!text.includes(' ') && !text.includes('­'));
});

test('visibleText with main:false keeps the whole body but still drops scripts', () => {
  const text = visibleText(page('contact/index.html'), { main: false });
  assert.ok(text.startsWith('Skip to content Home About Services'));
  assert.ok(text.includes('Download our brochure (PDF)'));
  assert.ok(!text.includes('gtag'), 'script text is dropped');
});

test('visibleText falls back to [role=main], then #content, then body', () => {
  assert.equal(visibleText('<body><nav>x</nav><div role="main">A</div><p>B</p></body>'), 'A');
  assert.equal(visibleText('<body><div id="content">C</div><p>D</p></body>'), 'C');
  assert.equal(visibleText('<body><header>H</header><p>E</p><footer>F</footer></body>'), 'E');
});

test('visibleText normalises quotes and whitespace and drops hidden elements', () => {
  const html =
    '<main><p>“It’s”   done</p><p hidden>no</p><p style="visibility: hidden">no</p>' +
    '<aside>no</aside><svg><text>no</text></svg><template>no</template><style>p{}</style>\n\t ok</main>';
  assert.equal(visibleText(html), '"It\'s" done ok');
});

test('wordDiff reports equal, delete and insert runs', () => {
  assert.deepEqual(wordDiff('a b c d', 'a x c d e'), [
    { op: 'equal', text: 'a' },
    { op: 'delete', text: 'b' },
    { op: 'insert', text: 'x' },
    { op: 'equal', text: 'c d' },
    { op: 'insert', text: 'e' },
  ]);
  assert.deepEqual(wordDiff('same words', 'same words'), [{ op: 'equal', text: 'same words' }]);
  assert.deepEqual(wordDiff('', ''), []);
});

test('wordDiff falls back to one delete/insert pair above 5,000 differing words', () => {
  const many = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(' ');
  const a = `start ${many('a', 5001)} end`;
  const b = `start ${many('b', 10)} end`;
  assert.deepEqual(wordDiff(a, b), [
    { op: 'equal', text: 'start' },
    { op: 'delete', text: many('a', 5001) },
    { op: 'insert', text: many('b', 10) },
    { op: 'equal', text: 'end' },
  ]);
});

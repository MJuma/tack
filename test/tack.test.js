import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { iconTone } from '../src/lib/icons.js';
import {
    cleanInside,
    exportLinks,
    hostOf,
    insideName,
    makeLink,
    normalizeUrl,
    pageMatches,
    parseImport,
    shortcutsToLinks,
    shortTitle,
} from '../src/lib/links.js';
import { rankIcons, pickTitle } from '../src/lib/page.js';
import { EMPTY_HTML, escapeHtml, hue, renderGrid } from '../src/lib/render.js';
import { itemsFromLinks, linksFromItems, settingsFromItems } from '../src/lib/store.js';

describe('normalizeUrl', () => {
    it('adds https to bare hosts and http to local ones', () => {
        assert.equal(normalizeUrl(' github.com '), 'https://github.com/');
        assert.equal(normalizeUrl('news.ycombinator.com/best'), 'https://news.ycombinator.com/best');
        assert.equal(normalizeUrl('localhost:5173/app'), 'http://localhost:5173/app');
        assert.equal(normalizeUrl('127.0.0.1:8080'), 'http://127.0.0.1:8080/');
        assert.equal(normalizeUrl('myapp.test'), 'http://myapp.test/');
    });

    it('keeps explicit http(s) URLs', () => {
        assert.equal(normalizeUrl('http://intranet.example/x?y=1#z'), 'http://intranet.example/x?y=1#z');
        assert.equal(normalizeUrl('HTTPS://Example.com'), 'https://example.com/');
    });

    it('rejects other protocols and junk', () => {
        for (const input of ['', '   ', null, 'javascript:alert(1)', 'mailto:me@example.com', 'file:///etc/passwd', 'ftp://x.org', 'http://']) {
            assert.equal(normalizeUrl(input), null, String(input));
        }
    });
});

describe('hostOf', () => {
    it('drops www.', () => {
        assert.equal(hostOf('https://www.youtube.com/feed'), 'youtube.com');
        assert.equal(hostOf('not a url'), 'not a url');
    });
});

/** Links with predictable ids, for comparing. */
const link = (id, title, url, extra = {}) => makeLink({ id, title, url, ...extra });
describe('links inside', () => {
    it('names them after the last part of their address', () => {
        assert.equal(insideName('https://dev.azure.com/contoso/Mobile%20App'), 'Mobile App');
        assert.equal(insideName('https://dev.azure.com/contoso/Website/'), 'Website');
        assert.equal(insideName('https://www.office.com/'), 'office.com');
    });

    it('cleans up: http(s) only, no repeats, capped at 4 labels or 6 icons', () => {
        const entries = ['a.com/1', { url: 'https://a.com/1' }, { url: 'javascript:x' }, ...['2', '3', '4', '5', '6', '7'].map(n => `a.com/${n}`)];
        assert.deepEqual(cleanInside(entries, 'labels').map(item => item.title), ['1', '2', '3', '4']);
        assert.equal(cleanInside(entries, 'icons').length, 6);
        assert.deepEqual(cleanInside('nope', 'labels'), []);
    });
});

describe('pageMatches', () => {
    it('matches any page on the site for a front-page link, ignoring www. and http/https', () => {
        assert.ok(pageMatches('https://tracker.example.com/', 'https://tracker.example.com/app/v3/issues?x=1#y'));
        assert.ok(pageMatches('https://portal.example.com/', 'https://portal.example.com/#home'));
        assert.ok(pageMatches('https://github.com/', 'http://www.github.com/mozilla'));
        assert.ok(!pageMatches('https://portal.example.com/', 'https://login.example.net/common/oauth2'));
        assert.ok(!pageMatches('https://localhost:3000/', 'https://localhost:4000/'));
    });

    it('matches pages at or under a deeper link, and nothing beside it', () => {
        const link = 'https://dev.azure.com/contoso/Website';
        assert.ok(pageMatches(link, 'https://dev.azure.com/contoso/Website'));
        assert.ok(pageMatches(`${link}/`, 'https://dev.azure.com/contoso/Website/_git/repo'));
        assert.ok(!pageMatches(link, 'https://dev.azure.com/contoso/WebsiteOld'));
        assert.ok(!pageMatches(link, 'https://dev.azure.com/contoso/Mobile%20App'));
        assert.ok(!pageMatches(link, 'about:newtab'));
        assert.ok(!pageMatches('not a url', 'https://dev.azure.com/'));
    });
});

describe('parseImport / exportLinks', () => {
    it('round-trips display and links inside', () => {
        const links = [
            link('a', 'Azure DevOps', 'https://dev.azure.com/', { inside: [{ title: 'Web', url: 'https://dev.azure.com/contoso/Website' }] }),
            link('b', 'Microsoft 365', 'https://www.office.com/', { show: 'icons', inside: [{ title: 'Word', url: 'https://www.office.com/launch/word' }] }),
            link('c', 'HN', 'https://news.ycombinator.com/'),
        ];
        const exported = exportLinks(links);
        assert.match(exported, /"tack": 2/);
        const imported = parseImport(exported);
        assert.deepEqual(
            imported.map(({ title, url, show, inside }) => ({ title, url, show, inside })),
            links.map(({ title, url, show, inside }) => ({ title, url, show, inside })),
        );
        assert.equal(new Set(imported.map(item => item.id)).size, 3);
    });

    it('accepts older formats and bare arrays: normalizes, dedupes, skips bad entries, ignores keys', () => {
        const imported = parseImport(JSON.stringify(['github.com', { url: 'https://github.com' }, { url: 'javascript:x' }, 42, { title: ' Docs ', url: 'docs.rs', key: 'Q' }]));
        assert.deepEqual(
            imported.map(({ title, url, show, inside }) => ({ title, url, show, inside })),
            [
                { title: 'github.com', url: 'https://github.com/', show: 'labels', inside: [] },
                { title: 'Docs', url: 'https://docs.rs/', show: 'labels', inside: [] },
            ],
        );
    });

    it('throws on invalid JSON and ignores unknown shapes', () => {
        assert.throws(() => parseImport('{nope'));
        assert.deepEqual(parseImport('{"foo": 1}'), []);
    });
});

describe('shortTitle', () => {
    it('picks the part of a page title that names the site', () => {
        assert.equal(shortTitle('GitHub: Let’s build from here · GitHub', 'https://github.com/'), 'GitHub');
        assert.equal(shortTitle('Reddit - Dive into anything', 'https://www.reddit.com/'), 'Reddit');
        assert.equal(shortTitle('Wikipedia, the free encyclopedia', 'https://en.wikipedia.org/'), 'Wikipedia');
        assert.equal(shortTitle('Stack Overflow - Where Developers Learn, Share, & Build Careers', 'https://stackoverflow.com/'), 'Stack Overflow');
    });

    it('keeps short titles (like custom labels) and falls back to the host', () => {
        assert.equal(shortTitle('Work mail', 'https://outlook.office.com/'), 'Work mail');
        assert.equal(shortTitle('Amazon.com. Spend less. Smile more.', 'https://www.amazon.com/'), 'amazon.com');
        assert.equal(shortTitle('', 'https://news.ycombinator.com/'), 'news.ycombinator.com');
    });
});

describe('shortcutsToLinks', () => {
    it('skips search shortcuts, bad URLs and links already pinned', () => {
        const added = shortcutsToLinks(
            [
                { type: 'url', url: 'https://github.com/', title: 'GitHub' },
                { type: 'search', url: 'https://www.google.com/', title: '@google' },
                { type: 'url', url: 'https://news.ycombinator.com', title: 'Hacker News' },
                { type: 'url', url: 'https://news.ycombinator.com/', title: 'dupe' },
                { type: 'url', url: 'about:preferences', title: 'x' },
            ],
            [{ url: 'https://github.com/' }],
        );
        assert.deepEqual(
            added.map(({ title, url }) => ({ title, url })),
            [{ title: 'Hacker News', url: 'https://news.ycombinator.com/' }],
        );
    });
});

describe('renderGrid', () => {
    const ICON = { src: 'data:image/png;base64,AAAA', tone: '' };

    it('renders an empty state, or just the add box while editing', () => {
        assert.equal(renderGrid([]), EMPTY_HTML);
        assert.match(renderGrid([], new Map(), { editing: true }), /^<button class="t new" type="button" data-add>/);
    });

    it('renders a box with its icon or letter tile, name and address', () => {
        const html = renderGrid(
            [link('a', 'GitHub', 'https://github.com/'), link('b', '', 'https://www.example.com/')],
            new Map([['https://github.com/', ICON]]),
        );
        assert.ok(html.startsWith(
            '<div class="t" data-id="a"><a class="m" href="https://github.com/" title="GitHub"><img class="i" src="data:image/png;base64,AAAA" alt="" width="44" height="44" decoding="sync"><span class="n">GitHub</span></a><span class="u">github.com</span></div>',
        ));
        assert.match(html, new RegExp(`<span class="i l" style="--h:${hue('example.com')}">E</span><span class="n">example.com</span></a><span class="u">example.com</span>`));
    });

    it('renders links inside as numbered labels, two per row from three on', () => {
        const box = link('a', 'DevOps', 'https://dev.azure.com/', {
            inside: [
                { title: 'Web', url: 'https://dev.azure.com/contoso/Website' },
                { title: 'Mobile App', url: 'https://dev.azure.com/contoso/Mobile%20App' },
            ],
        });
        const html = renderGrid([box], new Map([[box.url, ICON], [box.inside[0].url, ICON]]));
        assert.ok(!html.includes('class="u"'));
        // Sharing the box's icon, a label shows no icon of its own.
        assert.match(html, /<div class="subs list"><a class="s" href="https:\/\/dev.azure.com\/contoso\/Website" title="dev.azure.com\/contoso\/Website" data-n="1"><span>Web<\/span><\/a>/);
        const three = renderGrid([{ ...box, inside: [...box.inside, { title: 'X', url: 'https://x.org/' }] }]);
        assert.match(three, /<div class="subs list two">/);
    });

    it('renders links inside as icons: their own, or a letter when it would repeat the box', () => {
        const box = link('a', 'Microsoft 365', 'https://www.office.com/', {
            show: 'icons',
            inside: [
                { title: 'Word', url: 'https://word.example/' },
                { title: 'Home', url: 'https://www.office.com/home' },
            ],
        });
        const word = { src: 'data:image/png;base64,WORD', tone: 'dark' };
        const html = renderGrid([box], new Map([[box.url, ICON], ['https://word.example/', word], ['https://www.office.com/home', ICON]]));
        assert.match(html, /<div class="subs row"><a class="s" href="https:\/\/word.example\/" title="Word" data-n="1"><img class=" dark-icon" src="data:image\/png;base64,WORD"/);
        assert.match(html, new RegExp(`data-n="2"><span class="l" style="--h:${hue('Home')}">H</span></a>`));
    });

    it('caps links inside and drops non-http ones', () => {
        const inside = ['1', '2', '3', '4', '5', '6', '7'].map(n => ({ title: n, url: `https://a.com/${n}` }));
        assert.equal(renderGrid([link('a', 'A', 'https://a.com/', { inside })]).match(/data-n=/g)?.length, 4);
        assert.equal(renderGrid([link('a', 'A', 'https://a.com/', { inside, show: 'icons' })]).match(/data-n=/g)?.length, 6);
        assert.ok(!renderGrid([link('a', 'A', 'https://a.com/', { inside: [{ title: 'x', url: 'javascript:1' }] })]).includes('javascript'));
    });

    it('adds controls while editing', () => {
        const box = link('a', 'A', 'https://a.com/', { inside: [{ title: 'one', url: 'https://a.com/1' }] });
        const html = renderGrid([box, link('b', 'B', 'https://b.com/')], new Map(), { editing: true });
        assert.match(html, /<div class="t" data-id="a" draggable="true"><button class="x" type="button" data-remove/);
        assert.match(html, /<i class="sx" data-remove-sub="0"/);
        assert.match(html, /<a class="s" href="https:\/\/a.com\/1" title="a.com\/1" data-n="1" draggable="true">/);
        assert.match(html, /<button class="s add" type="button" data-add-sub/);
        assert.match(html, /<span class="u">b.com<\/span><button class="add-in" type="button" data-add-sub>/);
        assert.ok(html.endsWith('<button class="t new" type="button" data-add><b>+</b>Add a box</button>'));
        assert.ok(!renderGrid([box]).includes('data-remove'));
    });

    it('hides addresses when asked, editing or not', () => {
        const links = [link('a', 'A', 'https://a.com/'), link('b', 'B', 'https://b.com/', { inside: [{ title: 'one', url: 'https://b.com/1' }] })];
        assert.equal(renderGrid(links).match(/class="u"/g)?.length, 1);
        assert.ok(!renderGrid(links, new Map(), { showHosts: false }).includes('class="u"'));
        const editing = renderGrid(links, new Map(), { showHosts: false, editing: true });
        assert.ok(!editing.includes('class="u"'));
        assert.match(editing, /<span class="n">A<\/span><\/a><button class="add-in"/);
    });

    it('escapes everything it interpolates', () => {
        const html = renderGrid([
            link('"x', '<img src=x onerror=alert(1)>', 'https://e.com/?a="b"&c=<d>', { inside: [{ title: '<b>', url: 'https://e.com/"' }] }),
        ]);
        assert.ok(!html.includes('<img src=x'));
        assert.ok(!html.includes('<span><b></span>'));
        assert.ok(html.includes('href="https://e.com/?a=&quot;b&quot;&amp;c=&lt;d&gt;"'));
        assert.ok(html.includes('data-id="&quot;x"'));
    });

    it('drops non-http links and non-image icons', () => {
        assert.equal(renderGrid([link('a', 'x', 'javascript:alert(1)')]), EMPTY_HTML);
        const html = renderGrid([link('a', 'x', 'https://x.org/')], new Map([['https://x.org/', { src: 'javascript:1', tone: '' }]]));
        assert.ok(!html.includes('<img'));
    });

    it('marks icons that need inverting in one color scheme', () => {
        const box = link('a', 'x', 'https://x.org/');
        const html = tone => renderGrid([box], new Map([[box.url, { ...ICON, tone }]]));
        assert.match(html('dark'), /<img class="i dark-icon"/);
        assert.match(html('light'), /<img class="i light-icon"/);
        assert.match(html(''), /<img class="i"/);
    });

    it('escapeHtml covers quotes', () => {
        assert.equal(escapeHtml(`'"&<>`), '&#39;&quot;&amp;&lt;&gt;');
    });
});

describe('storage format', () => {
    it('round-trips links through sync items, leaving defaults out', () => {
        const links = [
            link('a', 'A', 'https://a.com/', { show: 'icons', inside: [{ title: 'one', url: 'https://a.com/1' }] }),
            link('b', 'B', 'https://b.com/'),
        ];
        const items = itemsFromLinks(links);
        assert.deepEqual(items['l.a'], { t: 'A', u: 'https://a.com/', s: 'i', c: [['one', 'https://a.com/1']] });
        assert.deepEqual(items['l.b'], { t: 'B', u: 'https://b.com/' });
        assert.deepEqual(linksFromItems(items), links);
    });

    it('reads items from older versions (no links inside, or Tack 0.3.0 keys) and ignores junk', () => {
        const links = linksFromItems({
            order: ['a', 'b'],
            'l.a': { t: 'A', u: 'https://a.com/' },
            'l.b': { t: 'B', u: 'https://b.com/', k: 'Q', s: 'x', c: [['ok', 'https://b.com/1'], 'junk', [1], ['no url']] },
        });
        assert.deepEqual(links, [
            link('a', 'A', 'https://a.com/'),
            link('b', 'B', 'https://b.com/', { inside: [{ title: 'ok', url: 'https://b.com/1' }] }),
        ]);
    });

    it('keeps settings out of the links, and shows addresses unless turned off', () => {
        const items = { order: ['a'], 'l.a': { t: 'A', u: 'https://a.com/' }, settings: { showHosts: false } };
        assert.deepEqual(linksFromItems(items).map(item => item.id), ['a']);
        assert.deepEqual(settingsFromItems(items), { showHosts: false });
        assert.deepEqual(settingsFromItems({}), { showHosts: true });
        assert.deepEqual(settingsFromItems({ settings: 'junk' }), { showHosts: true });
    });

    it('appends links missing from order and skips order ids without links', () => {
        const items = {
            order: ['b', 'gone', 'a', 'b'],
            'l.a': { t: 'A', u: 'https://a.com/' },
            'l.b': { t: 'B', u: 'https://b.com/' },
            'l.c': { t: 'C', u: 'https://c.com/' },
        };
        assert.deepEqual(
            linksFromItems(items).map(item => item.id),
            ['b', 'a', 'c'],
        );
    });
});

describe('pickTitle', () => {
    it('prefers the site name, then app name, then a trimmed title', () => {
        assert.equal(pickTitle({ siteName: 'GitHub', appName: 'x', title: 'GitHub: Let’s build' }), 'GitHub');
        assert.equal(pickTitle({ siteName: ' ', appName: 'Outlook', title: 'Mail' }), 'Outlook');
        assert.equal(pickTitle({ siteName: '', appName: '', title: '\n  Hacker   News\n' }), 'Hacker News');
        assert.equal(pickTitle({ siteName: '', appName: '', title: 'x'.repeat(80) }).length, 60);
    });
});

describe('rankIcons', () => {
    it('orders SVG, then ~64px rasters, then apple-touch-icon, then tiny icons', () => {
        const ranked = rankIcons(
            [
                { rel: 'icon', href: '/16.png', sizes: '16x16', type: 'image/png' },
                { rel: 'apple-touch-icon', href: '/apple.png', sizes: '180x180', type: '' },
                { rel: 'icon', href: '/192.png', sizes: '192x192', type: 'image/png' },
                { rel: 'shortcut icon', href: '/favicon.ico', sizes: '', type: '' },
                { rel: 'icon', href: 'icon.svg', sizes: 'any', type: 'image/svg+xml' },
                { rel: 'icon', href: '/64.png', sizes: '64x64', type: 'image/png' },
                { rel: 'mask-icon', href: '/mask.svg', sizes: '', type: '' },
                { rel: 'stylesheet', href: '/x.css', sizes: '', type: '' },
            ],
            'https://example.com/app/',
        );
        assert.deepEqual(ranked, [
            'https://example.com/app/icon.svg',
            'https://example.com/64.png',
            'https://example.com/192.png',
            'https://example.com/favicon.ico',
            'https://example.com/apple.png',
            'https://example.com/16.png',
        ]);
    });
});

/**
 * A 64px RGBA buffer where a `shape` fraction of pixels are opaque `rgb` and the rest transparent.
 * @param {number[]} rgb
 * @param {number} shape
 */
function pixels(rgb, shape) {
    const data = new Uint8ClampedArray(64 * 64 * 4);
    for (let index = 0; index < 64 * 64 * shape; index++) {
        data.set([...rgb, 255], index * 4);
    }
    return data;
}

describe('iconTone', () => {
    it('flags mostly-transparent black or white icons', () => {
        assert.equal(iconTone(pixels([24, 23, 23], 0.6)), 'dark');
        assert.equal(iconTone(pixels([250, 250, 250], 0.6)), 'light');
    });

    it('leaves colorful, opaque and empty icons alone', () => {
        assert.equal(iconTone(pixels([255, 0, 0], 0.6)), '');
        assert.equal(iconTone(pixels([0, 0, 0], 1)), '');
        assert.equal(iconTone(pixels([0, 0, 0], 0)), '');
    });
});

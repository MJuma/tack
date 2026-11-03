// Measures what you feel when pressing Cmd+T, in your real Firefox build with a throwaway profile:
//
//   - Firefox's own new tab (preloaded in the background, so it's the bar to beat)
//   - an empty extension new tab page (the floor for any extension: Firefox disables preloading
//     whenever an extension overrides the new tab page)
//   - Tack, seeded with real links and the favicons it fetched for them
//
// For each tab it records "shown" (Cmd+T until Firefox's tab switcher has painted the new tab,
// its TabSwitchDone event) and "painted" (Cmd+T until the page's first contentful paint).
// It also saves screenshots to .measure/.
//
//   node scripts/measure.mjs [runs=30] [--headed]
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { itemsFromLinks } from '../src/lib/store.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, '.measure');
const FIREFOX = process.env.FIREFOX ?? '/Applications/Firefox.app/Contents/MacOS/firefox';
const RUNS = Number(process.argv.slice(2).find(arg => /^\d+$/.test(arg)) ?? 30);
const HEADED = process.argv.includes('--headed');

const SEED = [
    ['GitHub', 'https://github.com/'],
    ['Hacker News', 'https://news.ycombinator.com/'],
    ['Gmail', 'https://mail.google.com/'],
    ['Calendar', 'https://calendar.google.com/'],
    ['YouTube', 'https://www.youtube.com/'],
    ['Wikipedia', 'https://en.wikipedia.org/'],
    ['MDN', 'https://developer.mozilla.org/'],
    ['Stack Overflow', 'https://stackoverflow.com/'],
    ['Reddit', 'https://www.reddit.com/'],
    ['LinkedIn', 'https://www.linkedin.com/'],
    ['Azure DevOps', 'https://dev.azure.com/'],
    ['Azure Portal', 'https://portal.azure.com/'],
    ['Outlook', 'https://outlook.office.com/'],
    ['Teams', 'https://teams.microsoft.com/'],
    ['Figma', 'https://www.figma.com/'],
    ['Notion', 'https://www.notion.so/'],
    ['npm', 'https://www.npmjs.com/'],
    ['GitHub Docs', 'https://docs.github.com/'],
    ['Maps', 'https://maps.google.com/'],
    ['Amazon', 'https://www.amazon.com/'],
    ['Spotify', 'https://open.spotify.com/'],
    ['Vercel', 'https://vercel.com/'],
    ['Searchfox', 'https://searchfox.org/'],
    ['Dev server', 'http://localhost:5173/'],
].map(([title, url], index) => ({ id: `seed${index}`, title, url }));

/** Minimal Marionette client: "<byte length>:<json>" frames over TCP. */
class Marionette {
    #socket;
    #buffer = Buffer.alloc(0);
    #pending = new Map();
    #nextId = 1;
    /** @type {(value: unknown) => void} */
    #onHandshake = () => {};

    /** @param {net.Socket} socket */
    constructor(socket) {
        this.#socket = socket;
        this.ready = new Promise(resolve => {
            this.#onHandshake = resolve;
        });
        socket.on('data', chunk => this.#receive(chunk));
    }

    /** @param {number} port */
    static async connect(port) {
        const deadline = Date.now() + 30_000;
        for (;;) {
            try {
                const socket = await new Promise((resolve, reject) => {
                    const candidate = net.connect(port, '127.0.0.1');
                    candidate.once('connect', () => resolve(candidate));
                    candidate.once('error', reject);
                });
                const client = new Marionette(socket);
                await client.ready;
                return client;
            } catch (error) {
                if (Date.now() > deadline) {
                    throw error;
                }
                await sleep(200);
            }
        }
    }

    /** @param {Buffer} chunk */
    #receive(chunk) {
        this.#buffer = Buffer.concat([this.#buffer, chunk]);
        for (;;) {
            const colon = this.#buffer.indexOf(':');
            if (colon === -1) {
                return;
            }
            const length = Number(this.#buffer.subarray(0, colon).toString());
            const end = colon + 1 + length;
            if (this.#buffer.length < end) {
                return;
            }
            const message = JSON.parse(this.#buffer.subarray(colon + 1, end).toString());
            this.#buffer = this.#buffer.subarray(end);
            if (!Array.isArray(message)) {
                this.#onHandshake(message);
                continue;
            }
            const [, id, error, result] = message;
            const pending = this.#pending.get(id);
            this.#pending.delete(id);
            if (error) {
                pending?.reject(new Error(`${error.error}: ${error.message}`));
            } else {
                pending?.resolve(result);
            }
        }
    }

    /**
     * @param {string} name
     * @param {object} [parameters]
     * @returns {Promise<any>}
     */
    send(name, parameters = {}) {
        const id = this.#nextId++;
        const body = Buffer.from(JSON.stringify([0, id, name, parameters]));
        this.#socket.write(`${body.length}:`);
        this.#socket.write(body);
        return new Promise((resolve, reject) => {
            this.#pending.set(id, { resolve, reject });
        });
    }

    /**
     * Runs an async script; it reports back by calling its last argument.
     * @param {'chrome' | 'content'} context
     * @param {string} script
     * @param {unknown[]} [args]
     */
    async run(context, script, args = []) {
        await this.send('Marionette:SetContext', { value: context });
        return unwrap(await this.send('WebDriver:ExecuteAsyncScript', { script, args }));
    }

    async tabs() {
        await this.send('Marionette:SetContext', { value: 'content' });
        return /** @type {string[]} */ (unwrap(await this.send('WebDriver:GetWindowHandles')));
    }

    close() {
        this.#socket.destroy();
    }
}

/** Marionette wraps most results as { value }; a null value must stay null. */
const unwrap = (/** @type {any} */ result) => (result && typeof result === 'object' && 'value' in result ? result.value : result);

const OPEN_TAB = `
    const done = arguments[arguments.length - 1];
    const now = () => window.performance.timeOrigin + window.performance.now();
    const t0 = now();
    const timer = window.setTimeout(() => done({ t0, shown: null }), 5000);
    window.gBrowser.addEventListener('TabSwitchDone', () => {
        window.clearTimeout(timer);
        done({ t0, shown: now() });
    }, { once: true });
    window.BrowserCommands.openTab();
`;

const READ_PAINT = `
    const done = arguments[arguments.length - 1];
    const read = () => {
        const fcp = performance.getEntriesByType('paint').find(entry => entry.name === 'first-contentful-paint');
        if (!fcp) return false;
        done({
            origin: performance.timeOrigin,
            fcp: fcp.startTime,
            url: location.href,
            tiles: document.querySelectorAll('#g .t[data-id]').length,
            icons: document.querySelectorAll('#g .m img').length,
        });
        return true;
    };
    if (!read()) {
        const poll = setInterval(() => read() && clearInterval(poll), 5);
        setTimeout(() => { clearInterval(poll); done(null); }, 1000);
    }
`;

const CLOSE_TAB = `
    const done = arguments[arguments.length - 1];
    window.gBrowser.removeTab(window.gBrowser.selectedTab);
    done(true);
`;

/** @param {Marionette} marionette */
async function openTab(marionette) {
    const { t0, shown } = await marionette.run('chrome', OPEN_TAB);
    const tabs = await marionette.tabs();
    await marionette.send('WebDriver:SwitchToWindow', { handle: tabs.at(-1) });
    const paint = await marionette.run('content', READ_PAINT);
    return {
        shown: shown === null ? null : shown - t0,
        painted: paint === null ? null : paint.origin + paint.fcp - t0,
        page: paint?.fcp ?? null,
        url: paint?.url,
        tiles: paint?.tiles,
        icons: paint?.icons,
    };
}

/** @param {Marionette} marionette */
async function closeTab(marionette) {
    await marionette.run('chrome', CLOSE_TAB);
    const [first] = await marionette.tabs();
    await marionette.send('WebDriver:SwitchToWindow', { handle: first });
}

/** @param {string} name */
async function launch(name) {
    const profile = await mkdtemp(path.join(os.tmpdir(), `tack-measure-${name}-`));
    const port = 2900 + Math.floor(Math.random() * 2000);
    const prefs = {
        'marionette.port': port,
        'app.update.disabledForTesting': true,
        'browser.aboutwelcome.enabled': false,
        'browser.shell.checkDefaultBrowser': false,
        'browser.startup.homepage_override.mstone': 'ignore',
        'browser.startup.page': 0,
        'browser.newtabpage.activity-stream.feeds.section.topstories': false,
        'browser.newtabpage.activity-stream.showSponsored': false,
        'browser.newtabpage.activity-stream.showSponsoredTopSites': false,
        'datareporting.policy.dataSubmissionEnabled': false,
        'toolkit.telemetry.reportingpolicy.firstRun': false,
        'layout.css.prefers-color-scheme.content-override': 1,
    };
    await writeFile(
        path.join(profile, 'user.js'),
        Object.entries(prefs)
            .map(([key, value]) => `user_pref(${JSON.stringify(key)}, ${JSON.stringify(value)});`)
            .join('\n'),
    );
    const child = spawn(
        FIREFOX,
        ['--marionette', '--no-remote', '--profile', profile, ...(HEADED ? [] : ['--headless', '--window-size=1440,900'])],
        // Chrome-context scripts (opening tabs, TabSwitchDone) need system access.
        { stdio: 'ignore', env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' } },
    );
    const marionette = await Marionette.connect(port);
    await marionette.send('WebDriver:NewSession', {});
    await marionette.send('WebDriver:SetTimeouts', { script: 120_000 });
    const quit = async () => {
        await marionette.send('Marionette:Quit', { flags: ['eForceQuit'] }).catch(() => {});
        marionette.close();
        child.kill();
        await sleep(500);
        await rm(profile, { recursive: true, force: true });
    };
    return { marionette, quit };
}

async function blankExtension() {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'tack-blank-ext-'));
    await writeFile(
        path.join(dir, 'manifest.json'),
        JSON.stringify({
            manifest_version: 3,
            name: 'Blank new tab',
            version: '1.0',
            chrome_url_overrides: { newtab: 'blank.html' },
            browser_specific_settings: { gecko: { id: 'blank@tack.test' } },
        }),
    );
    await writeFile(path.join(dir, 'blank.html'), '<!doctype html><meta charset="utf-8"><title>New Tab</title><p>.</p>');
    return dir;
}

/** Seeds Tack's storage.sync through the extension's own API and waits for icons to arrive. */
async function seedTack(marionette) {
    await openTab(marionette);
    const seeded = await marionette.run(
        'content',
        `
        const done = arguments[arguments.length - 1];
        // Marionette's content sandbox may or may not hand us an Xray-wrapped window.
        const page = window.wrappedJSObject ?? window;
        page.browser.storage.sync.set(page.JSON.parse(arguments[0])).then(() => done(true), error => done(String(error)));
        `,
        [JSON.stringify(itemsFromLinks(SEED))],
    );
    if (seeded !== true) {
        throw new Error(`Seeding failed: ${seeded}`);
    }
    // The background page re-renders the cache and fetches favicons; wait until they stop changing.
    let last = '';
    let stableSince = Date.now();
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline && Date.now() - stableSince < 5000) {
        await sleep(500);
        const html = await marionette.run('content', `arguments[arguments.length - 1](localStorage.getItem('tack:html') ?? '')`);
        if (html !== last) {
            last = html;
            stableSince = Date.now();
        }
    }
    await closeTab(marionette);
    return { cacheBytes: Buffer.byteLength(last), icons: (last.match(/<img /g) ?? []).length };
}

/** @param {Marionette} marionette @param {string} file */
async function screenshot(marionette, file) {
    await marionette.send('Marionette:SetContext', { value: 'content' });
    const result = unwrap(await marionette.send('WebDriver:TakeScreenshot', { full: false }));
    await writeFile(path.join(OUT, file), Buffer.from(result, 'base64'));
}

/** @param {Marionette} marionette */
async function screenshots(marionette) {
    const setScheme = value =>
        marionette.run(
            'chrome',
            `Services.prefs.setIntPref('layout.css.prefers-color-scheme.content-override', ${value}); arguments[arguments.length - 1](true);`,
        );
    for (const [scheme, value] of [['light', 1], ['dark', 0]]) {
        await setScheme(value);
        await openTab(marionette);
        await sleep(300);
        await screenshot(marionette, `tack-${scheme}.png`);
        await marionette.run('content', `document.getElementById('e').click(); setTimeout(arguments[arguments.length - 1], 500);`);
        await screenshot(marionette, `tack-${scheme}-edit.png`);
        await marionette.run('content', `document.querySelector('[data-add]').click(); setTimeout(arguments[arguments.length - 1], 300);`);
        await screenshot(marionette, `tack-${scheme}-dialog.png`);
        await closeTab(marionette);
    }
    await setScheme(1);
}

/** @param {number[]} values @param {number} p */
function percentile(values, p) {
    const sorted = values.toSorted((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

/** @param {{ name: string, extension?: string, tack?: boolean }} setup */
async function measure(setup) {
    const { marionette, quit } = await launch(setup.name.replaceAll(/\W+/g, '-'));
    try {
        if (setup.extension) {
            await marionette.send('Addon:Install', { path: setup.extension, temporary: true });
        }
        const seed = setup.tack ? await seedTack(marionette) : null;
        // Warm-up tabs pay one-off costs (the "an extension changed your new tab" notice, caches).
        for (let index = 0; index < 5; index++) {
            await openTab(marionette);
            await closeTab(marionette);
            await sleep(1000);
        }
        const samples = [];
        for (let index = 0; index < RUNS; index++) {
            samples.push(await openTab(marionette));
            await closeTab(marionette);
            // Give Firefox time to preload its next new tab, as it would between real Cmd+Ts.
            await sleep(1000);
        }
        if (setup.tack) {
            await screenshots(marionette);
        }
        return { ...setup, seed, samples };
    } finally {
        await quit();
    }
}

await mkdir(OUT, { recursive: true });
const blank = await blankExtension();
const setups = [
    { name: 'Firefox new tab (preloaded)' },
    { name: 'Empty extension page', extension: blank },
    { name: 'Tack', extension: path.join(ROOT, 'src'), tack: true },
];
const results = [];
for (const setup of setups) {
    process.stdout.write(`Measuring ${setup.name}…\n`);
    results.push(await measure(setup));
}
await rm(blank, { recursive: true, force: true });
await writeFile(path.join(OUT, 'results.json'), `${JSON.stringify(results, null, 4)}\n`);

const format = (/** @type {number} */ ms) => `${ms.toFixed(1)} ms`.padStart(9);
process.stdout.write(`\nFirefox ${HEADED ? 'headed' : 'headless'}, ${RUNS} tabs each (median / p90)\n\n`);
process.stdout.write(`${'Setup'.padEnd(30)}${'Tab shown'.padEnd(24)}${'Content painted'.padEnd(24)}Page nav → paint\n`);
for (const { name, samples, seed } of results) {
    const column = (/** @type {(number | null)[]} */ values) => {
        const present = /** @type {number[]} */ (values.filter(value => value !== null));
        if (present.length === 0 || percentile(present, 50) < 0) {
            // Firefox's own page rendered in the background before Cmd+T.
            return 'before Cmd+T'.padEnd(24);
        }
        return `${format(percentile(present, 50))} / ${format(percentile(present, 90))}`.padEnd(24);
    };
    const label = seed ? `${name} (${SEED.length} links, ${seed.icons} icons)` : name;
    process.stdout.write(
        `${label.padEnd(30)}${column(samples.map(s => s.shown))}${column(samples.map(s => s.painted))}${column(samples.map(s => s.page)).trim()}\n`,
    );
    if (seed) {
        process.stdout.write(`${''.padEnd(30)}cache: ${(seed.cacheBytes / 1024).toFixed(1)} KB of pre-rendered HTML\n`);
    }
}
process.stdout.write(`\nRaw samples and screenshots: ${path.relative(process.cwd(), OUT)}/\n`);

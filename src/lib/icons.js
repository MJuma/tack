// Favicons: fetched from each site once, shrunk to 64px PNGs and kept in storage.local on each
// machine (Firefox Sync's quota is reserved for the links). A failed fetch leaves a letter tile,
// records why, and is retried after a day. Sites that set their icon from a script or need you to
// sign in can't be fetched like that, so Tack also takes the icon Firefox shows when you visit
// them (see useTabIcon).
//
// An entry is "i:<url>" -> { d: data: URL or null, t: tone, at: when, e: why there's no icon,
// x: 1 if it came from a page on another site (usually a sign-in page), v: 'tab' if it came from
// a tab you visited }.
import { fetchPage } from './page.js';

const PREFIX = 'i:';
const SIZE = 64;
const RETRY_AFTER_MS = 24 * 60 * 60 * 1000;
const ALL_SITES = { origins: ['<all_urls>'] };

/** @typedef {'' | 'dark' | 'light'} Tone */
/** @typedef {{ src: string, tone: Tone }} Icon */

/**
 * @param {string[]} urls every box's URL and the URLs of the links inside (see allUrls)
 * @returns {Promise<Map<string, Icon>>} keyed by URL
 */
export async function loadIcons(urls) {
    const stored = urls.length > 0 ? await browser.storage.local.get(urls.map(url => PREFIX + url)) : {};
    const icons = new Map();
    for (const url of urls) {
        const entry = stored[PREFIX + url];
        if (entry?.d) {
            icons.set(url, { src: entry.d, tone: entry.t ?? '' });
        }
    }
    return icons;
}

export const canFetchIcons = () => browser.permissions.contains(ALL_SITES);

// Must be called directly from a user action (a click handler).
export const requestIconAccess = () => browser.permissions.request(ALL_SITES);

/**
 * Fetches icons this machine doesn't have yet (or every icon, with force) and drops icons for
 * removed links.
 * @param {string[]} urls
 * @param {{ force?: boolean }} [options]
 * @returns {Promise<boolean>} whether any icon changed
 */
export async function fetchMissingIcons(urls, { force = false } = {}) {
    const stored = await browser.storage.local.get(null);
    const wanted = new Set(urls.map(url => PREFIX + url));
    const unused = Object.keys(stored).filter(key => key.startsWith(PREFIX) && !wanted.has(key));
    if (unused.length > 0) {
        await browser.storage.local.remove(unused);
    }
    if (!(await canFetchIcons())) {
        return false;
    }
    const now = Date.now();
    const missing = [...new Set(urls)].filter(url => {
        const entry = stored[PREFIX + url];
        return force || !entry || (!entry.d && now - entry.at > RETRY_AFTER_MS);
    });
    if (missing.length === 0) {
        return false;
    }
    const fetched = await Promise.all(
        missing.map(async url => {
            const key = PREFIX + url;
            const old = stored[key];
            const result = await fetchIcon(url).catch(error => ({ problem: reason(error) }));
            let entry;
            if (!('icon' in result)) {
                // A forced refresh that fails keeps the icon we already had, such as one from a tab.
                entry = { ...old, d: old?.d ?? null, at: now, e: result.problem };
            } else if (result.elsewhere && old?.v === 'tab' && old.d) {
                // A sign-in page's icon never replaces the one you saw on the site itself.
                entry = { ...old, at: now };
            } else {
                entry = { d: result.icon.src, t: result.icon.tone, at: now, ...(result.elsewhere ? { x: 1 } : {}) };
            }
            return /** @type {const} */ ([key, entry]);
        }),
    );
    await browser.storage.local.set(Object.fromEntries(fetched));
    return fetched.some(([key, entry]) => entry.d !== (stored[key]?.d ?? null));
}

/**
 * Why Tack has no icon for each URL that lacks one, as recorded by fetchMissingIcons.
 * @param {string[]} urls
 * @returns {Promise<Map<string, string>>}
 */
export async function iconProblems(urls) {
    const stored = urls.length > 0 ? await browser.storage.local.get(urls.map(url => PREFIX + url)) : {};
    return new Map(urls.filter(url => !stored[PREFIX + url]?.d && stored[PREFIX + url]?.e).map(url => [url, stored[PREFIX + url].e]));
}

/**
 * Uses the favicon Firefox shows in a tab for pinned links on that site (see pageMatches) that
 * Tack has no icon for, only a sign-in page's icon for, or an earlier tab's icon for.
 * @param {string[]} urls
 * @param {string} favIconUrl
 * @returns {Promise<boolean>} whether any icon changed
 */
export async function useTabIcon(urls, favIconUrl) {
    if (urls.length === 0 || !/^(?:https?|data):/i.test(favIconUrl)) {
        return false;
    }
    const keys = urls.map(url => PREFIX + url);
    const stored = await browser.storage.local.get(keys);
    const wanted = keys.filter(key => !stored[key]?.d || stored[key].x || stored[key].v === 'tab');
    if (wanted.length === 0) {
        return false;
    }
    let icon;
    try {
        icon = await rasterize(favIconUrl);
    } catch {
        // Not an icon Tack can read; the next visit may show a different one.
        return false;
    }
    const changed = wanted.filter(key => stored[key]?.d !== icon.src);
    if (changed.length === 0) {
        return false;
    }
    const now = Date.now();
    await browser.storage.local.set(Object.fromEntries(changed.map(key => [key, { d: icon.src, t: icon.tone, at: now, v: 'tab' }])));
    return true;
}

/** @param {unknown} error */
function reason(error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
        return 'timed out after 8 seconds';
    }
    if (error instanceof TypeError) {
        return 'network error (offline, blocked, or a site Firefox keeps extensions away from)';
    }
    return error instanceof Error ? error.message : String(error);
}

/** @param {string} url */
const shortUrl = url => {
    const { host, pathname } = new URL(url);
    return `${host}${pathname}`.replace(/\/$/, '');
};

/**
 * Tries the icons the page lists, best first, then the site's /favicon.ico.
 * @param {string} pageUrl
 * @returns {Promise<{ icon: Icon, elsewhere: boolean } | { problem: string }>}
 */
async function fetchIcon(pageUrl) {
    /** @type {string[]} */
    const problems = [];
    let page = { icons: /** @type {string[]} */ ([]), url: pageUrl };
    try {
        page = await fetchPage(pageUrl);
        if (page.icons.length === 0) {
            problems.push('the page lists no icon');
        }
    } catch (error) {
        problems.push(`page: ${reason(error)}`);
    }
    // A page that redirected to another site (usually to sign in) shows that site's icon.
    const elsewhere = new URL(page.url).origin !== new URL(pageUrl).origin;
    if (elsewhere) {
        problems.unshift(`redirected to ${new URL(page.url).host}`);
    }
    /** @type {Map<string, boolean>} */
    const candidates = new Map(page.icons.map(source => [source, elsewhere]));
    candidates.set(new URL('/favicon.ico', pageUrl).href, false);
    for (const [source, fromElsewhere] of candidates) {
        try {
            return { icon: await rasterize(source), elsewhere: fromElsewhere };
        } catch (error) {
            problems.push(`${shortUrl(source)}: ${reason(error)}`);
        }
    }
    return { problem: problems.join('; ') };
}

/**
 * Decodes any image Firefox can (PNG, ICO, SVG, ...) and redraws it as a 64px PNG data: URL.
 * @param {string} source
 * @returns {Promise<Icon>}
 */
async function rasterize(source) {
    const response = await fetch(source, { credentials: 'include', signal: AbortSignal.timeout(8000) });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }
    if ((response.headers.get('content-type') ?? '').includes('html')) {
        throw new Error('a web page, not an image');
    }
    let blob = await response.blob();
    if (blob.size === 0 || blob.size > 1_000_000) {
        throw new Error(`unexpected size (${blob.size} bytes)`);
    }
    if (blob.type.includes('svg') || /\.svg(?:[?#]|$)/i.test(source)) {
        blob = sizedSvg(await blob.text());
    }
    const objectUrl = URL.createObjectURL(blob);
    try {
        const image = new Image();
        image.src = objectUrl;
        await image.decode().catch(() => {
            throw new Error('not an image Firefox can read');
        });
        const { naturalWidth: width, naturalHeight: height } = image;
        if (!width || !height) {
            throw new Error('the image has no size');
        }
        const scale = Math.min(SIZE / width, SIZE / height);
        const canvas = document.createElement('canvas');
        canvas.width = SIZE;
        canvas.height = SIZE;
        const context = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
        context.imageSmoothingQuality = 'high';
        context.drawImage(image, (SIZE - width * scale) / 2, (SIZE - height * scale) / 2, width * scale, height * scale);
        return { src: canvas.toDataURL('image/png'), tone: iconTone(context.getImageData(0, 0, SIZE, SIZE).data) };
    } finally {
        URL.revokeObjectURL(objectUrl);
    }
}

/**
 * Flags icons that would vanish on a tile of their own color: mostly-transparent shapes that are
 * nearly black (GitHub's logo on a dark tile) or nearly white. The page gives those a contrasting
 * tile in that color scheme. Opaque icons bring their own background, so they never need it.
 * @param {Uint8ClampedArray} rgba
 * @returns {Tone}
 */
export function iconTone(rgba) {
    let alpha = 0;
    let luminance = 0;
    for (let index = 0; index < rgba.length; index += 4) {
        const weight = rgba[index + 3] / 255;
        alpha += weight;
        luminance += (weight * (0.2126 * rgba[index] + 0.7152 * rgba[index + 1] + 0.0722 * rgba[index + 2])) / 255;
    }
    const coverage = alpha / (rgba.length / 4);
    if (alpha === 0 || coverage > 0.85) {
        return '';
    }
    const mean = luminance / alpha;
    if (mean < 0.2) {
        return 'dark';
    }
    return mean > 0.85 ? 'light' : '';
}

/**
 * SVGs often lack width/height, which leaves them with no intrinsic size to draw at.
 * @param {string} text
 */
function sizedSvg(text) {
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    const svg = doc.documentElement;
    if (svg.localName !== 'svg') {
        throw new Error('not a readable SVG');
    }
    const width = Number.parseFloat(svg.getAttribute('width') ?? '');
    const height = Number.parseFloat(svg.getAttribute('height') ?? '');
    if (!svg.hasAttribute('viewBox') && width > 0 && height > 0) {
        svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    }
    svg.setAttribute('width', String(SIZE));
    svg.setAttribute('height', String(SIZE));
    return new Blob([new XMLSerializer().serializeToString(doc)], { type: 'image/svg+xml' });
}

// Pure helpers for link data. No browser APIs, so the tests import this file directly in Node.

/**
 * A box on the new tab page: its own link and up to 6 links inside it.
 * @typedef {{ title: string, url: string }} Inside
 * @typedef {'labels' | 'icons'} Show
 * @typedef {{ id: string, title: string, url: string, show: Show, inside: Inside[] }} Link
 */

export const MAX_ICONS = 6;
export const MAX_LABELS = 4;

/**
 * How many links fit inside a box: a row of 6 icons, or 4 labels in two rows.
 * @param {Show} show
 */
export const capOf = show => (show === 'icons' ? MAX_ICONS : MAX_LABELS);

/**
 * @param {Partial<Link> & { title: string, url: string }} fields
 * @returns {Link}
 */
export const makeLink = ({ id = newId(), title, url, show = 'labels', inside = [] }) => ({ id, title, url, show, inside });

/**
 * Every URL a set of links needs an icon for: each box's own and the links inside it.
 * @param {Link[]} links
 */
export const allUrls = links => [...new Set(links.flatMap(link => [link.url, ...(link.inside ?? []).map(item => item.url)]))];

/** @param {URL} url */
const siteOf = url => `${url.hostname.replace(/^www\./, '')}:${url.port}`;

/**
 * Whether a page you have open belongs to a pinned link: the same site (ignoring www. and
 * http/https), and either the link is the site's front page or the page is at or under the link's
 * path. A tab on any page of a web app belongs to a link to its front page; one on another
 * DevOps project doesn't belong to dev.azure.com/contoso/Website.
 * @param {string} linkUrl
 * @param {string} pageUrl
 */
export function pageMatches(linkUrl, pageUrl) {
    let link;
    let page;
    try {
        link = new URL(linkUrl);
        page = new URL(pageUrl);
    } catch {
        return false;
    }
    if (!/^https?:$/.test(page.protocol) || siteOf(link) !== siteOf(page)) {
        return false;
    }
    const path = link.pathname.replace(/\/$/, '');
    return path === '' || page.pathname === path || page.pathname.startsWith(`${path}/`);
}

/**
 * A name for a link inside a box, from its address: the last part of the path
 * ("dev.azure.com/contoso/Mobile%20App" is "Mobile App"), or the host.
 * @param {string} url
 */
export function insideName(url) {
    try {
        const parts = new URL(url).pathname.split('/').filter(Boolean);
        return parts.length > 0 ? decodeURIComponent(parts.at(-1)) : hostOf(url);
    } catch {
        return hostOf(url);
    }
}

/**
 * Cleans up links inside a box: http(s) only, no repeats, no more than fit.
 * @param {unknown} entries
 * @param {Show} show
 * @returns {Inside[]}
 */
export function cleanInside(entries, show) {
    const seen = new Set();
    const inside = [];
    for (const entry of Array.isArray(entries) ? entries : []) {
        const url = normalizeUrl(typeof entry === 'string' ? entry : entry?.url);
        if (url === null || seen.has(url)) {
            continue;
        }
        seen.add(url);
        const title = typeof entry?.title === 'string' ? entry.title.trim() : '';
        inside.push({ title: title || insideName(url), url });
    }
    return inside.slice(0, capOf(show));
}

// Hosts that are usually served over plain http while you develop.
const LOCAL_HOST =
    /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]|[^/:?#]+\.(?:local|localhost|test|internal))(?::\d+)?(?:[/?#]|$)/i;

/**
 * Turns what someone typed ("github.com", "localhost:3000/x", a full URL) into an http(s) URL.
 * Anything else (javascript:, mailto:, garbage) returns null.
 * @param {unknown} input
 * @returns {string | null}
 */
export function normalizeUrl(input) {
    let text = String(input ?? '').trim();
    if (!text) {
        return null;
    }
    if (!/^[a-z][a-z\d+.-]*:\/\//i.test(text)) {
        // "scheme:stuff" without "//" is another protocol (mailto:, javascript:), but "host:port" is fine.
        if (/^[a-z][a-z\d+.-]*:(?!\d)/i.test(text)) {
            return null;
        }
        text = (LOCAL_HOST.test(text) ? 'http://' : 'https://') + text;
    }
    let url;
    try {
        url = new URL(text);
    } catch {
        return null;
    }
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
}

/**
 * @param {string} url
 * @returns {string}
 */
export function hostOf(url) {
    try {
        return new URL(url).hostname.replace(/^www\./, '');
    } catch {
        return url;
    }
}

export function newId() {
    return crypto.randomUUID().replaceAll('-', '').slice(0, 10);
}

/**
 * Accepts Tack's export format ({ links: [...] }, each with an optional show and links inside)
 * or a bare array of { url, title } / URL strings. Throws on invalid JSON; skips entries that
 * aren't http(s) links. Keys from Tack 0.3.0 exports are ignored.
 * @param {string} text
 * @returns {Link[]}
 */
export function parseImport(text) {
    const data = JSON.parse(text);
    const entries = Array.isArray(data) ? data : Array.isArray(data?.links) ? data.links : [];
    const seen = new Set();
    const links = [];
    for (const entry of entries) {
        const url = normalizeUrl(typeof entry === 'string' ? entry : entry?.url);
        if (url === null || seen.has(url)) {
            continue;
        }
        seen.add(url);
        const title = typeof entry?.title === 'string' ? entry.title.trim() : '';
        /** @type {Show} */
        const show = entry?.show === 'icons' ? 'icons' : 'labels';
        links.push(makeLink({ title: title || hostOf(url), url, show, inside: cleanInside(entry?.links, show) }));
    }
    return links;
}

/** @param {string} text */
const squash = text => text.toLowerCase().replace(/[^a-z\d]/g, '');

/**
 * A short tile name from a page title: the part that names the site ("GitHub" from
 * "GitHub: Let's build from here · GitHub"), the title itself if short, else the host.
 * @param {unknown} title
 * @param {string} url
 */
export function shortTitle(title, url) {
    const host = hostOf(url);
    const clean = String(title ?? '').replace(/\s+/g, ' ').trim();
    if (!clean) {
        return host;
    }
    const hostKey = squash(host);
    const named = clean.split(/\s+[-|·—–]\s+|[:,]\s+/).find(part => {
        const key = squash(part);
        return key.length >= 2 && hostKey.includes(key);
    });
    return named?.trim() || (clean.length <= 24 ? clean : host);
}

/**
 * Turns browser.topSites results into new links, skipping search shortcuts, non-http(s) URLs and
 * anything already pinned.
 * @param {{ type?: string, url: string, title?: string }[]} sites
 * @param {{ url: string }[]} existing
 * @returns {Link[]}
 */
export function shortcutsToLinks(sites, existing) {
    const seen = new Set(existing.map(link => link.url));
    const links = [];
    for (const site of sites) {
        const url = site.type === 'search' ? null : normalizeUrl(site.url);
        if (url === null || seen.has(url)) {
            continue;
        }
        seen.add(url);
        links.push(makeLink({ title: shortTitle(site.title, url), url }));
    }
    return links;
}

/**
 * @param {Link[]} links
 * @returns {string}
 */
export function exportLinks(links) {
    const entries = links.map(({ title, url, show, inside }) => ({
        title,
        url,
        ...(show === 'icons' ? { show } : {}),
        ...(inside.length > 0 ? { links: inside.map(item => ({ title: item.title, url: item.url })) } : {}),
    }));
    return `${JSON.stringify({ tack: 2, links: entries }, null, 4)}\n`;
}

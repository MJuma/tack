// Reads a page once to find a short name and its favicon candidates. Only the editor and the
// background page call this, never the new tab hot path. The extension's host permission means CORS
// doesn't apply.

/**
 * Throws, with a short reason, when the page can't be read.
 * @param {string} url
 * @returns {Promise<{ title: string, icons: string[], url: string }>} url: where it ended up after redirects
 */
export async function fetchPage(url) {
    const response = await fetch(url, { credentials: 'include', signal: AbortSignal.timeout(8000) });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }
    const type = response.headers.get('content-type') ?? '';
    if (!type.includes('html')) {
        throw new Error(`not a web page (${type || 'no content type'})`);
    }
    // DOMParser documents are inert: no scripts run and nothing loads.
    const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
    const base = new URL(doc.querySelector('base[href]')?.getAttribute('href') ?? '', response.url).href;
    const meta = (/** @type {string} */ name) =>
        doc.querySelector(`meta[property="${name}"], meta[name="${name}"]`)?.getAttribute('content') ?? '';
    const candidates = [...doc.querySelectorAll('link[rel][href]')].map(element => ({
        rel: element.getAttribute('rel') ?? '',
        href: element.getAttribute('href') ?? '',
        sizes: element.getAttribute('sizes') ?? '',
        type: element.getAttribute('type') ?? '',
    }));
    return {
        title: pickTitle({ siteName: meta('og:site_name'), appName: meta('application-name'), title: doc.title }),
        icons: rankIcons(candidates, base),
        url: response.url,
    };
}

/** @param {string} text */
const clean = text => text.replace(/\s+/g, ' ').trim();

/**
 * Prefers a site's own short name ("GitHub") over its often long <title>.
 * @param {{ siteName: string, appName: string, title: string }} names
 */
export function pickTitle({ siteName, appName, title }) {
    const name = clean(siteName) || clean(appName) || clean(title);
    return name.length > 60 ? `${name.slice(0, 59)}…` : name;
}

/**
 * Orders <link rel=icon> candidates best-first for a 64px tile: SVG, then raster icons near 64px,
 * then apple-touch-icon. The caller falls back to /favicon.ico.
 * @param {{ rel: string, href: string, sizes: string, type: string }[]} candidates
 * @param {string} base
 * @returns {string[]}
 */
export function rankIcons(candidates, base) {
    /** @type {{ href: string, score: number }[]} */
    const ranked = [];
    for (const { rel, href, sizes, type } of candidates) {
        const rels = rel.toLowerCase().split(/\s+/);
        let score;
        if (rels.includes('icon')) {
            if (type.includes('svg') || /\.svg(?:[?#]|$)/i.test(href)) {
                score = 300;
            } else {
                const size = Math.max(0, ...sizes.split(/\s+/).map(value => Number.parseInt(value, 10) || 0));
                if (size === 0) {
                    score = 200;
                } else if (size >= 64) {
                    score = 260 - Math.min(size, 512) / 10;
                } else {
                    score = 100 + size * 2.5;
                }
            }
        } else if (rels.includes('apple-touch-icon') || rels.includes('apple-touch-icon-precomposed')) {
            score = 160;
        } else {
            continue;
        }
        try {
            ranked.push({ href: new URL(href, base).href, score });
        } catch {
            // Unparseable href: skip it.
        }
    }
    ranked.sort((a, b) => b.score - a.score);
    return [...new Set(ranked.map(icon => icon.href))];
}

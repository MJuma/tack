// The pre-rendered grid HTML that newtab.js reads synchronously from localStorage.
import { fetchMissingIcons, loadIcons, useTabIcon } from './icons.js';
import { allUrls, pageMatches } from './links.js';
import { renderGrid } from './render.js';
import { loadLinks, loadSettings } from './store.js';

// newtab.js hardcodes the same key.
export const CACHE_KEY = 'tack:html';

/** @param {string} html */
export function writeCache(html) {
    // Skipping identical writes avoids waking every open new tab with a no-op storage event.
    if (localStorage.getItem(CACHE_KEY) !== html) {
        localStorage.setItem(CACHE_KEY, html);
    }
}

/** Re-renders the cache from storage. */
export async function rebuild() {
    const links = await loadLinks();
    const html = renderGrid(links, await loadIcons(allUrls(links)), await loadSettings());
    writeCache(html);
    return { links, html };
}

let queue = Promise.resolve();

/**
 * Rebuilds the cache, then fetches any missing favicons and rebuilds again if that found some.
 * Calls are serialized so overlapping triggers don't fetch the same icons twice.
 * @param {{ force?: boolean }} [options]
 */
export function refresh(options = {}) {
    const run = queue.then(async () => {
        const { links } = await rebuild();
        if (await fetchMissingIcons(allUrls(links), options)) {
            await rebuild();
        }
    });
    // Keep the queue going after a failure; reportError still logs it to the extension console.
    queue = run.catch(reportError);
    return run;
}

/**
 * A tab is showing its favicon: pinned links on that site without an icon of their own can use it.
 * @param {string} pageUrl
 * @param {string} favIconUrl
 */
export function learnFromTab(pageUrl, favIconUrl) {
    const run = queue.then(async () => {
        const urls = allUrls(await loadLinks()).filter(url => pageMatches(url, pageUrl));
        if (await useTabIcon(urls, favIconUrl)) {
            await rebuild();
        }
    });
    queue = run.catch(reportError);
    return run;
}

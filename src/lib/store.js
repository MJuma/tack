// Links live in storage.sync, so Firefox Sync carries them between machines. Each link is its own
// item plus one "order" list of ids: sync merges per key, so edits made on two machines rarely
// clobber each other. An item is "l.<id>" -> { t: title, u: url, s: 'i' to show the links inside
// as icons, c: [[title, url], …] links inside }, leaving out s and c when unset (Tack 0.3.0 also
// stored k, a key, which is now ignored and dropped the next time links are saved). A
// "settings" item holds page options. The sync quota (100 KB, 512 items) is why favicons stay in
// storage.local instead (see icons.js).
import { MAX_ICONS } from './links.js';

const LINK = 'l.';

/** @typedef {import('./links.js').Link} Link */

/** @returns {Promise<Link[]>} */
export async function loadLinks() {
    return linksFromItems(await browser.storage.sync.get(null));
}

/**
 * @param {Link[]} links
 */
export async function saveLinks(links) {
    const current = await browser.storage.sync.get(null);
    const next = itemsFromLinks(links);
    const removed = Object.keys(current).filter(key => key.startsWith(LINK) && !(key in next));
    const changed = Object.fromEntries(
        Object.entries(next).filter(([key, value]) => JSON.stringify(current[key]) !== JSON.stringify(value)),
    );
    // Remove first: a reader in between sees an order pointing at a missing link (skipped), rather
    // than a deleted link that's no longer in the order (which would be appended back for a moment).
    if (removed.length > 0) {
        await browser.storage.sync.remove(removed);
    }
    if (Object.keys(changed).length > 0) {
        await browser.storage.sync.set(changed);
    }
}

/**
 * @param {Record<string, any>} items
 * @returns {Link[]}
 */
export function linksFromItems(items) {
    const ids = new Set((Array.isArray(items.order) ? items.order : []).filter(id => items[LINK + id]));
    // Another machine may have added a link while this one saved a new order; keep it, at the end.
    for (const key of Object.keys(items)) {
        if (key.startsWith(LINK)) {
            ids.add(key.slice(LINK.length));
        }
    }
    return [...ids]
        .map(id => {
            const item = items[LINK + id];
            const inside = (Array.isArray(item.c) ? item.c : [])
                .filter(pair => Array.isArray(pair) && typeof pair[1] === 'string' && pair[1])
                .slice(0, MAX_ICONS)
                .map(([title, url]) => ({ title: String(title ?? ''), url }));
            return /** @type {Link} */ ({
                id,
                title: String(item.t ?? ''),
                url: String(item.u ?? ''),
                show: item.s === 'i' ? 'icons' : 'labels',
                inside,
            });
        })
        .filter(link => link.url);
}

/**
 * @param {Link[]} links
 * @returns {Record<string, any>}
 */
export function itemsFromLinks(links) {
    /** @type {Record<string, any>} */
    const items = { order: links.map(link => link.id) };
    for (const link of links) {
        const inside = link.inside ?? [];
        items[LINK + link.id] = {
            t: link.title,
            u: link.url,
            ...(link.show === 'icons' ? { s: 'i' } : {}),
            ...(inside.length > 0 ? { c: inside.map(item => [item.title, item.url]) } : {}),
        };
    }
    return items;
}

/**
 * Page options, synced with the links.
 * @typedef {{ showHosts: boolean }} Settings
 */

const SETTINGS = 'settings';

/**
 * @param {Record<string, any>} items
 * @returns {Settings}
 */
export const settingsFromItems = items => ({ showHosts: items[SETTINGS]?.showHosts !== false });

/** @returns {Promise<Settings>} */
export async function loadSettings() {
    return settingsFromItems(await browser.storage.sync.get(SETTINGS));
}

/** @param {Settings} settings */
export async function saveSettings(settings) {
    await browser.storage.sync.set({ [SETTINGS]: settings });
}

// Turns links into the grid's HTML. Pure (no browser APIs): the background page, the editor and
// the tests all call it, and its output is what newtab.js pastes in on every new tab.
import { capOf, hostOf } from './links.js';

/** @typedef {import('./links.js').Link} Link */
/** @typedef {import('./links.js').Inside} Inside */
/** @typedef {{ src: string, tone: string }} Icon */

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** @param {unknown} value */
export const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ESCAPES[char]);

export const EMPTY_HTML = '<button class="empty" type="button" data-edit>No links yet. Add some</button>';

const ADD_BOX = '<button class="t new" type="button" data-add><b>+</b>Add a box</button>';

/**
 * A stable hue per host or name, so letter tiles keep their color.
 * @param {string} text
 */
export function hue(text) {
    let hash = 0;
    for (const char of text) {
        hash = (Math.imul(hash, 31) + char.codePointAt(0)) >>> 0;
    }
    return hash % 360;
}

const isHttp = (/** @type {string} */ url) => /^https?:\/\//i.test(url);

// See iconTone() in icons.js: newtab.html inverts these in the color scheme they'd vanish in.
/** @type {Record<string, string>} */
const TONE_CLASS = { dark: ' dark-icon', light: ' light-icon' };

/**
 * @param {Icon | undefined} icon
 * @param {number} size
 * @param {string} [className]
 */
function image(icon, size, className = '') {
    const tone = TONE_CLASS[icon?.tone ?? ''] ?? '';
    return `<img class="${className}${tone}" src="${escapeHtml(icon?.src)}" alt="" width="${size}" height="${size}" decoding="sync">`;
}

/**
 * @param {string} name
 * @param {string} colorFrom
 * @param {string} [className]
 */
const letter = (name, colorFrom, className = 'l') =>
    `<span class="${className}" style="--h:${hue(colorFrom)}">${escapeHtml([...name][0]?.toUpperCase() ?? '?')}</span>`;

const usable = (/** @type {Icon | undefined} */ icon) => (icon?.src.startsWith('data:image/') ? icon : undefined);

/**
 * @param {Link[]} links
 * @param {Map<string, Icon>} [icons] keyed by URL, for boxes and the links inside them
 * @param {{ editing?: boolean, showHosts?: boolean }} [options] editing adds the editor's
 *     controls; showHosts shows each box's address under its name
 * @returns {string}
 */
export function renderGrid(links, icons = new Map(), { editing = false, showHosts = true } = {}) {
    const boxes = links.map(link => renderBox(link, icons, editing, showHosts)).join('');
    if (editing) {
        return boxes + ADD_BOX;
    }
    return boxes || EMPTY_HTML;
}

/**
 * A box: its link's icon and name, then the links inside it or (if shown) its address.
 * @param {Link} link
 * @param {Map<string, Icon>} icons
 * @param {boolean} editing
 * @param {boolean} showHosts
 */
function renderBox(link, icons, editing, showHosts) {
    // Storage only ever holds normalized http(s) URLs; this guards against anything else.
    if (!isHttp(link.url)) {
        return '';
    }
    const host = hostOf(link.url);
    const name = link.title.trim() || host;
    const icon = usable(icons.get(link.url));
    const badge = icon ? image(icon, 44, 'i') : letter(name, host, 'i l');
    const inside = (link.inside ?? []).filter(item => isHttp(item.url));
    const below = inside.length > 0 || editing ? renderInside(link, inside, icon, icons, editing) : '';
    const address = inside.length > 0 || !showHosts ? '' : `<span class="u">${escapeHtml(host)}</span>`;
    const drag = editing ? ' draggable="false"' : '';
    const remove = editing ? `<button class="x" type="button" data-remove title="Remove ${escapeHtml(name)}" aria-label="Remove ${escapeHtml(name)}">×</button>` : '';
    return `<div class="t" data-id="${escapeHtml(link.id)}"${editing ? ' draggable="true"' : ''}>${remove}<a class="m" href="${escapeHtml(link.url)}" title="${escapeHtml(name)}"${drag}>${badge}<span class="n">${escapeHtml(name)}</span></a>${address}${below}</div>`;
}

/**
 * The links inside a box, as labels or as a row of icons. A link shown as an icon uses its own
 * favicon, or its first letter when that would just repeat the box's (like a site's sub-pages).
 * @param {Link} link
 * @param {Inside[]} inside
 * @param {Icon | undefined} boxIcon
 * @param {Map<string, Icon>} icons
 * @param {boolean} editing
 */
function renderInside(link, inside, boxIcon, icons, editing) {
    const asIcons = link.show === 'icons';
    // While editing, links inside can be dragged to reorder them within their box.
    const drag = editing ? ' draggable="true"' : '';
    const items = inside.slice(0, capOf(link.show)).map((item, index) => {
        const name = item.title.trim() || hostOf(item.url);
        const own = usable(icons.get(item.url));
        const ownIcon = own && own.src !== boxIcon?.src ? own : undefined;
        const remove = editing ? `<i class="sx" data-remove-sub="${index}" title="Remove ${escapeHtml(name)}">×</i>` : '';
        if (asIcons) {
            const glyph = ownIcon ? image(ownIcon, 18) : letter(name, name);
            return `<a class="s" href="${escapeHtml(item.url)}" title="${escapeHtml(name)}" data-n="${index + 1}"${drag}>${glyph}${remove}</a>`;
        }
        const glyph = ownIcon ? image(ownIcon, 14) : '';
        const where = item.url.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '');
        return `<a class="s" href="${escapeHtml(item.url)}" title="${escapeHtml(where)}" data-n="${index + 1}"${drag}>${glyph}<span>${escapeHtml(name)}</span>${remove}</a>`;
    });
    if (editing) {
        if (inside.length === 0) {
            return '<button class="add-in" type="button" data-add-sub>+ Link inside</button>';
        }
        if (inside.length < capOf(link.show)) {
            items.push('<button class="s add" type="button" data-add-sub title="Add a link inside">+</button>');
        }
    }
    const layout = asIcons ? 'row' : inside.length >= 3 ? 'list two' : 'list';
    return `<div class="subs ${layout}">${items.join('')}</div>`;
}

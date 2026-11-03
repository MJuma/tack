// Edit mode. newtab.js imports this only when you click ✎, so none of it costs anything when a tab
// opens. Each change saves straight to storage.sync and rewrites the cache, so other open tabs
// update right away and other machines follow through Firefox Sync.
import { CACHE_KEY, writeCache } from './lib/cache.js';
import { canFetchIcons, iconProblems, loadIcons, requestIconAccess } from './lib/icons.js';
import {
    MAX_LABELS,
    allUrls,
    capOf,
    cleanInside,
    exportLinks,
    hostOf,
    insideName,
    makeLink,
    normalizeUrl,
    parseImport,
    shortcutsToLinks,
} from './lib/links.js';
import { fetchPage } from './lib/page.js';
import { escapeHtml, hue, renderGrid } from './lib/render.js';
import { loadLinks, loadSettings, saveLinks, saveSettings } from './lib/store.js';

/** @typedef {import('./lib/links.js').Link} Link */
/** @typedef {import('./lib/links.js').Show} Show */
/** @typedef {{ title: string, url: string }} Row */

/** @type {HTMLElement} */
let grid;
/** @type {Link[]} */
let links = [];
/** @type {Map<string, { src: string, tone: string }>} */
let icons = new Map();
/** @type {Map<string, string>} why there's no icon, by URL */
let problems = new Map();
/** @type {import('./lib/store.js').Settings} */
let settings = { showHosts: true };
/** @type {AbortController | null} */
let listeners = null;
/** @type {HTMLElement} */
let toolbar;
/** @type {HTMLDialogElement} */
let dialog;
/** @type {HTMLElement | null} */
let dragged = null;
/** @type {HTMLElement | null} a link inside being dragged within its box */
let draggedChip = null;
/** @type {(() => void) | null} */
let undoAction = null;

/** @param {HTMLElement} gridElement */
export async function start(gridElement) {
    if (listeners) {
        return;
    }
    listeners = new AbortController();
    const { signal } = listeners;
    grid = gridElement;
    await loadStylesheet();
    await reload();
    document.body.classList.add('editing');

    grid.addEventListener('click', onClick, { signal });
    grid.addEventListener('auxclick', event => event.preventDefault(), { signal });
    grid.addEventListener('keydown', onKeyDown, { signal });
    grid.addEventListener('dragstart', onDragStart, { signal });
    grid.addEventListener('dragover', onDragOver, { signal });
    grid.addEventListener('drop', event => event.preventDefault(), { signal });
    grid.addEventListener('dragend', onDragEnd, { signal });
    // The background page fetched new icons, or another tab edited the links.
    addEventListener(
        'storage',
        async event => {
            if (event.key === CACHE_KEY && dragged === null && draggedChip === null) {
                await reload();
                /** @type {HTMLInputElement} */ (toolbar.querySelector('[data-hosts]')).checked = settings.showHosts;
                redraw();
            }
        },
        { signal },
    );
    addEventListener(
        'keydown',
        event => {
            if (event.key === 'Escape' && !dialog.open) {
                stop();
            }
        },
        { signal },
    );

    toolbar = buildToolbar();
    dialog = buildDialog();
    document.body.append(toolbar, dialog);
    redraw();
}

function stop() {
    listeners?.abort();
    listeners = null;
    toolbar.remove();
    dialog.remove();
    document.body.classList.remove('editing');
    grid.innerHTML = localStorage.getItem(CACHE_KEY) ?? renderGrid(links, icons, settings);
}

async function reload() {
    links = await loadLinks();
    settings = await loadSettings();
    icons = await loadIcons(allUrls(links));
    problems = await iconProblems(allUrls(links));
}

function redraw() {
    grid.innerHTML = renderGrid(links, icons, { ...settings, editing: true });
}

async function save() {
    try {
        await saveLinks(links);
        icons = await loadIcons(allUrls(links));
        writeCache(renderGrid(links, icons, settings));
    } catch (error) {
        alert(`Couldn't save: ${error instanceof Error ? error.message : error}`);
        await reload();
    }
    redraw();
}

/**
 * @param {string} id
 * @param {Link} next
 */
function replace(id, next) {
    links = links.map(link => (link.id === id ? next : link));
}

/** @param {EventTarget | null} target */
const linkFor = target => {
    const id = /** @type {HTMLElement | null} */ (/** @type {Element} */ (target).closest?.('.t[data-id]'))?.dataset.id;
    return links.find(link => link.id === id);
};

/** @param {MouseEvent} event */
function onClick(event) {
    const target = /** @type {Element} */ (event.target);
    if (target.closest('[data-add]')) {
        event.preventDefault();
        openDialog(null);
        return;
    }
    const link = linkFor(target);
    if (!link) {
        return;
    }
    event.preventDefault();
    const removeSub = /** @type {HTMLElement | null} */ (target.closest('[data-remove-sub]'));
    if (target.closest('[data-remove]')) {
        removeBox(link);
    } else if (removeSub) {
        removeInside(link, Number(removeSub.dataset.removeSub));
    } else {
        openDialog(link, { addInside: Boolean(target.closest('[data-add-sub]')) });
    }
}

/** @param {KeyboardEvent} event */
function onKeyDown(event) {
    const link = /** @type {Element} */ (event.target).closest('.m') ? linkFor(event.target) : undefined;
    if (!link) {
        return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        removeBox(link);
    } else if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        event.preventDefault();
        void move(link.id, event.key === 'ArrowLeft' ? -1 : 1);
    }
}

/** @param {Link} link */
function removeBox(link) {
    const index = links.findIndex(other => other.id === link.id);
    if (index === -1) {
        return;
    }
    links = links.toSpliced(index, 1);
    showUndo(`Removed ${link.title}`, () => {
        links = links.toSpliced(Math.min(index, links.length), 0, link);
    });
    void save();
}

/**
 * @param {Link} link
 * @param {number} index
 */
function removeInside(link, index) {
    const item = link.inside[index];
    if (!item) {
        return;
    }
    replace(link.id, { ...link, inside: link.inside.toSpliced(index, 1) });
    showUndo(`Removed ${item.title} from ${link.title}`, () => {
        const current = links.find(other => other.id === link.id);
        if (current) {
            const inside = current.inside.toSpliced(Math.min(index, current.inside.length), 0, item);
            replace(link.id, { ...current, inside: inside.slice(0, capOf(current.show)) });
        }
    });
    void save();
}

/**
 * @param {string} id
 * @param {number} delta
 */
async function move(id, delta) {
    const from = links.findIndex(link => link.id === id);
    const to = from + delta;
    if (from === -1 || to < 0 || to >= links.length) {
        return;
    }
    links = links.toSpliced(from, 1).toSpliced(to, 0, links[from]);
    await save();
    /** @type {HTMLElement | null} */ (grid.querySelector(`.t[data-id="${CSS.escape(id)}"] .m`))?.focus();
}

/** @param {DragEvent} event */
function onDragStart(event) {
    const target = /** @type {Element} */ (event.target);
    const chip = /** @type {HTMLElement | null} */ (target.closest?.('.s[data-n]'));
    if (chip && event.dataTransfer) {
        draggedChip = chip;
        chip.classList.add('dragging');
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', /** @type {HTMLAnchorElement} */ (chip).href);
        return;
    }
    const tile = /** @type {HTMLElement | null} */ (target.closest?.('.t[data-id]'));
    if (!tile || !event.dataTransfer) {
        return;
    }
    dragged = tile;
    tile.classList.add('dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', linkFor(tile)?.url ?? '');
}

/** @param {DragEvent} event */
function onDragOver(event) {
    if (draggedChip !== null) {
        // A link inside only moves among the links in its own box.
        const box = draggedChip.parentElement;
        const target = /** @type {Element} */ (event.target);
        if (target.closest('.subs') !== box) {
            return;
        }
        event.preventDefault();
        const over = target.closest('.s[data-n]');
        if (over && over !== draggedChip && box) {
            const chips = [...box.querySelectorAll('.s[data-n]')];
            if (chips.indexOf(draggedChip) < chips.indexOf(over)) {
                over.after(draggedChip);
            } else {
                over.before(draggedChip);
            }
        }
        return;
    }
    if (dragged === null) {
        return;
    }
    event.preventDefault();
    const over = /** @type {Element} */ (event.target).closest('.t[data-id]');
    if (!over || over === dragged) {
        return;
    }
    // Moving past a box swaps with it, whichever half the pointer is on, so boxes don't flicker.
    const tiles = [...grid.querySelectorAll('.t[data-id]')];
    if (tiles.indexOf(dragged) < tiles.indexOf(over)) {
        over.after(dragged);
    } else {
        over.before(dragged);
    }
}

async function onDragEnd() {
    if (draggedChip !== null) {
        const chip = draggedChip;
        draggedChip = null;
        chip.classList.remove('dragging');
        const link = linkFor(chip);
        const order = [...(chip.parentElement?.querySelectorAll('.s[data-n]') ?? [])].map(item => Number(/** @type {HTMLElement} */ (item).dataset.n) - 1);
        if (link && order.length === link.inside.length && order.some((from, to) => from !== to)) {
            replace(link.id, { ...link, inside: order.map(from => link.inside[from]) });
            await save();
        } else {
            redraw();
        }
        return;
    }
    if (dragged === null) {
        return;
    }
    dragged.classList.remove('dragging');
    dragged = null;
    const byId = new Map(links.map(link => [link.id, link]));
    const reordered = [...grid.querySelectorAll('.t[data-id]')]
        .map(tile => byId.get(/** @type {HTMLElement} */ (tile).dataset.id ?? ''))
        .filter(link => link !== undefined);
    if (reordered.some((link, index) => link !== links[index])) {
        links = reordered;
        await save();
    }
}

function buildToolbar() {
    const bar = document.createElement('div');
    bar.className = 'tack-bar';
    bar.innerHTML = `
        <span class="tip">Drag or ⌥←/→ to reorder · click a box to edit it · Esc when done</span>
        <span class="undo" hidden><span></span><button type="button" data-undo>Undo</button></span>
        <button type="button" data-access hidden title="Tack needs site access to download favicons">Allow icons</button>
        <span class="tack-menu">
            <button type="button" data-import aria-haspopup="menu" aria-expanded="false">Import ▾</button>
            <span role="menu" hidden>
                <button type="button" role="menuitem" data-import-shortcuts>Firefox shortcuts</button>
                <button type="button" role="menuitem" data-import-file>JSON file…</button>
            </span>
        </span>
        <label class="toggle" title="Show each box's address under its name"><input type="checkbox" data-hosts> Addresses</label>
        <button type="button" data-export>Export</button>
        <button type="button" data-refresh>Refresh icons</button>
        <button type="button" data-done class="primary">Done</button>`;
    /** @type {(selector: string) => HTMLButtonElement} */
    const button = selector => /** @type {HTMLButtonElement} */ (bar.querySelector(selector));

    button('[data-undo]').addEventListener('click', () => {
        undoAction?.();
        showUndo(null);
        void save();
    });
    button('[data-done]').addEventListener('click', stop);
    const importButton = button('[data-import]');
    const menu = /** @type {HTMLElement} */ (bar.querySelector('[role=menu]'));
    const showMenu = (/** @type {boolean} */ open) => {
        menu.hidden = !open;
        importButton.setAttribute('aria-expanded', String(open));
    };
    importButton.addEventListener('click', () => showMenu(menu.hidden));
    addEventListener(
        'click',
        event => {
            if (!(/** @type {Element} */ (event.target).closest('.tack-menu'))) {
                showMenu(false);
            }
        },
        { signal: listeners?.signal },
    );
    button('[data-import-shortcuts]').addEventListener('click', () => {
        showMenu(false);
        importShortcuts().catch(error => alert(`Couldn't import Firefox shortcuts: ${error instanceof Error ? error.message : error}`));
    });
    button('[data-import-file]').addEventListener('click', () => {
        showMenu(false);
        importLinks();
    });
    button('[data-export]').addEventListener('click', downloadLinks);

    const hosts = /** @type {HTMLInputElement} */ (bar.querySelector('[data-hosts]'));
    hosts.checked = settings.showHosts;
    hosts.addEventListener('change', async () => {
        settings = { ...settings, showHosts: hosts.checked };
        redraw();
        writeCache(renderGrid(links, icons, settings));
        await saveSettings(settings);
    });

    const access = button('[data-access]');
    void canFetchIcons().then(granted => {
        access.hidden = granted;
    });
    access.addEventListener('click', async () => {
        // The permission prompt only opens if requested synchronously from the click.
        const granted = await requestIconAccess();
        access.hidden = granted;
    });

    const refresh = button('[data-refresh]');
    refresh.addEventListener('click', async () => {
        refresh.disabled = true;
        refresh.textContent = 'Refreshing…';
        try {
            await browser.runtime.sendMessage({ type: 'refresh', force: true });
        } finally {
            refresh.disabled = false;
            refresh.textContent = 'Refresh icons';
        }
        await reload();
        redraw();
    });
    return bar;
}

/**
 * @param {string | null} text
 * @param {(() => void) | null} [action]
 */
function showUndo(text, action = null) {
    undoAction = action;
    const undo = /** @type {HTMLElement} */ (toolbar.querySelector('.undo'));
    undo.hidden = !text;
    /** @type {HTMLElement} */ (undo.firstElementChild).textContent = text ?? '';
}

// ── The box dialog ───────────────────────────────────────────────────────────

/** @type {string | null} the box being edited, or null when adding one */
let currentId = null;
/** @type {Show} */
let pendingShow = 'labels';
/** @type {Row[]} */
let pendingInside = [];

/** @param {string} name */
const field = name => /** @type {HTMLInputElement} */ (/** @type {HTMLFormElement} */ (dialog.querySelector('form')).elements.namedItem(name));

/**
 * @param {string} name
 * @param {string} colorFrom
 */
const letterTile = (name, colorFrom) => `<span class="l" style="--h:${hue(colorFrom)}">${escapeHtml([...name.trim()][0]?.toUpperCase() ?? '?')}</span>`;

/** @param {string} url */
const iconFor = url => {
    const icon = icons.get(url);
    return icon?.src.startsWith('data:image/') ? icon : undefined;
};

function buildDialog() {
    const element = document.createElement('dialog');
    element.className = 'tack-dialog';
    // Save comes first in the DOM so Enter submits it; CSS puts Cancel before it visually.
    element.innerHTML = `
        <form method="dialog">
            <h2></h2>
            <div class="fields">
                <label>Address<input name="url" required autocomplete="off" spellcheck="false" placeholder="example.com"></label>
                <label>Name<input name="title" autocomplete="off" spellcheck="false"></label>
            </div>
            <p class="icon-note" hidden></p>
            <section>
                <h3>Links inside <small class="count"></small><span class="seg" role="group" aria-label="Show links inside as"><button type="button" data-show="labels">Labels</button><button type="button" data-show="icons">Icons</button></span></h3>
                <p class="cap" data-reorder-hint>Drag ⠿ or press ⌥↑/⌥↓ in a field to reorder.</p>
                <ol class="subl"></ol>
                <button type="button" data-add-row>+ Add a link inside</button>
                <p class="cap">Icons fit 6 links in a box, labels fit 4. A link without its own icon shows its first letter.</p>
            </section>
            <menu>
                <button type="button" class="danger" data-delete>Remove box</button>
                <span></span>
                <button value="save" class="primary">Save</button>
                <button value="cancel" formnovalidate>Cancel</button>
            </menu>
        </form>`;
    const form = /** @type {HTMLFormElement} */ (element.querySelector('form'));
    const urlInput = /** @type {HTMLInputElement} */ (form.elements.namedItem('url'));
    const titleInput = /** @type {HTMLInputElement} */ (form.elements.namedItem('title'));
    const list = /** @type {HTMLElement} */ (element.querySelector('.subl'));

    urlInput.addEventListener('input', () => urlInput.setCustomValidity(''));
    // Suggest the site's own name once the address is filled in, unless you've typed one.
    urlInput.addEventListener('change', async () => {
        const url = normalizeUrl(urlInput.value);
        titleInput.placeholder = url ? hostOf(url) : '';
        if (!url || titleInput.value) {
            return;
        }
        const { title } = await fetchPage(url).catch(() => ({ title: '' }));
        if (title && !titleInput.value && normalizeUrl(urlInput.value) === url) {
            titleInput.value = title;
        }
    });

    /** @type {HTMLElement} */ (element.querySelector('.seg')).addEventListener('click', event => {
        const button = /** @type {HTMLButtonElement | null} */ (/** @type {Element} */ (event.target).closest('[data-show]'));
        if (button && !button.disabled) {
            pendingShow = button.dataset.show === 'icons' ? 'icons' : 'labels';
            drawInside();
        }
    });
    list.addEventListener('input', event => {
        const input = /** @type {HTMLInputElement} */ (event.target);
        const index = Number(input.dataset.row);
        if (input.dataset.f === 'title' || input.dataset.f === 'url') {
            pendingInside[index][input.dataset.f] = input.value;
            const number = input.closest('li')?.querySelector('.num');
            if (number) {
                number.innerHTML = marker(pendingInside[index], index);
            }
            drawCount();
        }
    });
    // A link inside is named after the last part of its address, unless you've typed a name.
    list.addEventListener('change', event => {
        const input = /** @type {HTMLInputElement} */ (event.target);
        const row = pendingInside[Number(input.dataset.row)];
        const url = input.dataset.f === 'url' && row ? normalizeUrl(row.url) : null;
        if (url && !row.title.trim()) {
            row.title = insideName(url);
            drawInside();
        }
    });
    list.addEventListener('click', event => {
        const remove = /** @type {HTMLElement | null} */ (/** @type {Element} */ (event.target).closest('[data-del]'));
        if (remove) {
            pendingInside = pendingInside.toSpliced(Number(remove.dataset.del), 1);
            drawInside();
        }
    });

    // Reordering: drag a row by its handle, or ⌥↑/⌥↓ while in one of its fields.
    /** @type {HTMLElement | null} */
    let draggedRow = null;
    list.addEventListener('dragstart', event => {
        // Only the handle starts a row drag (not, say, dragging selected text out of a field).
        const handle = /** @type {Element} */ (event.target).closest?.('.grip');
        const row = /** @type {HTMLElement | null} */ (handle?.closest('li') ?? null);
        if (!row || !event.dataTransfer) {
            return;
        }
        draggedRow = row;
        row.classList.add('dragging');
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', '');
        event.dataTransfer.setDragImage(row, 12, 16);
    });
    list.addEventListener('dragover', event => {
        if (draggedRow === null) {
            return;
        }
        event.preventDefault();
        const over = /** @type {Element} */ (event.target).closest('li');
        if (!over || over === draggedRow) {
            return;
        }
        const rows = [...list.children];
        if (rows.indexOf(draggedRow) < rows.indexOf(over)) {
            over.after(draggedRow);
        } else {
            over.before(draggedRow);
        }
    });
    list.addEventListener('drop', event => event.preventDefault());
    list.addEventListener('dragend', () => {
        if (draggedRow === null) {
            return;
        }
        draggedRow = null;
        const order = [...list.children].map(row => Number(/** @type {HTMLElement} */ (row).dataset.row));
        pendingInside = order.map(from => pendingInside[from]);
        drawInside();
    });
    list.addEventListener('keydown', event => {
        const input = /** @type {HTMLInputElement} */ (event.target);
        if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') || !input.dataset.f) {
            return;
        }
        event.preventDefault();
        const from = Number(input.dataset.row);
        const to = from + (event.key === 'ArrowUp' ? -1 : 1);
        if (to < 0 || to >= pendingInside.length) {
            return;
        }
        pendingInside = pendingInside.toSpliced(from, 1).toSpliced(to, 0, pendingInside[from]);
        drawInside();
        /** @type {HTMLInputElement | null} */ (list.querySelector(`[data-row="${to}"][data-f="${input.dataset.f}"]`))?.focus();
    });
    /** @type {HTMLButtonElement} */ (element.querySelector('[data-add-row]')).addEventListener('click', () => {
        pendingInside.push({ title: '', url: '' });
        drawInside();
        /** @type {HTMLElement | null} */ (list.querySelector('li:last-child [data-f="url"]'))?.focus();
    });

    form.addEventListener('submit', async event => {
        if (event.submitter?.getAttribute('value') !== 'save') {
            return;
        }
        event.preventDefault();
        const url = normalizeUrl(urlInput.value);
        if (!url) {
            urlInput.setCustomValidity('Enter a web address, like example.com');
            urlInput.reportValidity();
            return;
        }
        const title = titleInput.value.trim() || hostOf(url);
        const inside = cleanInside(pendingInside.filter(row => row.url.trim()), pendingShow);
        const existing = links.find(link => link.id === currentId);
        const next = existing
            ? { ...existing, title, url, show: pendingShow, inside }
            : makeLink({ title, url, show: pendingShow, inside });
        if (existing) {
            replace(existing.id, next);
        } else {
            links = [...links, next];
        }
        element.close();
        await save();
    });

    /** @type {HTMLButtonElement} */ (form.querySelector('[data-delete]')).addEventListener('click', () => {
        element.close();
        const link = links.find(other => other.id === currentId);
        if (link) {
            removeBox(link);
        }
    });
    return element;
}

/**
 * @param {Link | null} link
 * @param {{ addInside?: boolean }} [options]
 */
function openDialog(link, { addInside = false } = {}) {
    currentId = link?.id ?? null;
    pendingShow = link?.show ?? 'labels';
    pendingInside = (link?.inside ?? []).map(item => ({ title: item.title, url: item.url }));
    if (addInside && pendingInside.length < capOf(pendingShow)) {
        pendingInside.push({ title: '', url: '' });
    }
    /** @type {HTMLElement} */ (dialog.querySelector('h2')).textContent = link ? `Edit ${link.title}` : 'Add a box';
    field('url').value = link?.url ?? '';
    field('url').setCustomValidity('');
    field('title').value = link?.title ?? '';
    field('title').placeholder = link ? hostOf(link.url) : 'Filled in from the page';
    /** @type {HTMLButtonElement} */ (dialog.querySelector('[data-delete]')).hidden = !link;
    drawIconNote();
    drawInside();
    dialog.showModal();
    void refreshProblems();
    const focus = addInside ? dialog.querySelector('.subl li:last-child [data-f="url"]') : field('url');
    /** @type {HTMLInputElement | null} */ (focus)?.select();
}

/**
 * What a row shows at its start: its number, or as icons, its own icon or first letter.
 * @param {Row} row
 * @param {number} index
 */
function marker(row, index) {
    if (pendingShow !== 'icons') {
        return String(index + 1);
    }
    const url = normalizeUrl(row.url);
    const icon = url ? iconFor(url) : undefined;
    const boxUrl = links.find(link => link.id === currentId)?.url;
    if (icon && icon.src !== (boxUrl ? iconFor(boxUrl)?.src : undefined)) {
        return `<img src="${escapeHtml(icon.src)}" alt="">`;
    }
    return row.title.trim() ? letterTile(row.title, row.title) : String(index + 1);
}

// Why the box's own link has no icon, if Tack knows.
function drawIconNote() {
    const note = /** @type {HTMLElement} */ (dialog.querySelector('.icon-note'));
    const url = links.find(link => link.id === currentId)?.url;
    const problem = url ? problems.get(url) : undefined;
    note.hidden = !problem;
    note.textContent = problem
        ? `No icon yet: ${problem}. Open the site in a tab once and Tack will use the icon Firefox shows.`
        : '';
}

// Reasons are read fresh when the dialog opens: a failed icon fetch changes nothing on the page,
// so nothing else reloads them.
async function refreshProblems() {
    problems = await iconProblems(allUrls(links));
    if (!dialog.open) {
        return;
    }
    drawIconNote();
    for (const row of dialog.querySelectorAll('.subl li')) {
        const index = Number(/** @type {HTMLElement} */ (row).dataset.row);
        const url = normalizeUrl(pendingInside[index]?.url);
        const problem = url ? problems.get(url) : undefined;
        row.querySelector('.num')?.toggleAttribute('title', Boolean(problem));
        if (problem) {
            row.querySelector('.num')?.setAttribute('title', `No icon yet: ${problem}`);
        }
    }
}

/**
 * A tooltip on a row's marker saying why its link has no icon, if Tack knows.
 * @param {Row} row
 */
function rowProblem(row) {
    const url = normalizeUrl(row.url);
    const problem = url ? problems.get(url) : undefined;
    return problem ? ` title="No icon yet: ${escapeHtml(problem)}"` : '';
}

function drawCount() {
    const filled = pendingInside.filter(row => row.url.trim()).length;
    /** @type {HTMLElement} */ (dialog.querySelector('.count')).textContent = `${filled} of ${capOf(pendingShow)}`;
    // Labels only fit 4, so a box with more has to stay icons.
    const labels = /** @type {HTMLButtonElement} */ (dialog.querySelector('[data-show="labels"]'));
    labels.disabled = pendingShow === 'icons' && filled > MAX_LABELS;
    labels.title = labels.disabled ? `Labels fit ${MAX_LABELS} links` : '';
}

function drawInside() {
    /** @type {HTMLElement} */ (dialog.querySelector('.subl')).innerHTML = pendingInside
        .map(
            (row, index) =>
                `<li data-row="${index}"><span class="grip" draggable="true" title="Drag to reorder" aria-hidden="true">⠿</span><span class="num"${rowProblem(row)}>${marker(row, index)}</span><input data-row="${index}" data-f="title" value="${escapeHtml(row.title)}" placeholder="Name" spellcheck="false" autocomplete="off"><input data-row="${index}" data-f="url" value="${escapeHtml(row.url)}" placeholder="Address" spellcheck="false" autocomplete="off"><button type="button" data-del="${index}" title="Remove" aria-label="Remove">×</button></li>`,
        )
        .join('');
    for (const button of dialog.querySelectorAll('[data-show]')) {
        button.setAttribute('aria-pressed', String(/** @type {HTMLElement} */ (button).dataset.show === pendingShow));
    }
    /** @type {HTMLElement} */ (dialog.querySelector('[data-reorder-hint]')).hidden = pendingInside.length < 2;
    const full = pendingInside.length >= capOf(pendingShow);
    const add = /** @type {HTMLButtonElement} */ (dialog.querySelector('[data-add-row]'));
    add.disabled = full;
    add.textContent = full ? 'Box is full' : '+ Add a link inside';
    drawCount();
}

// ── Import and export ────────────────────────────────────────────────────────

// Adds the shortcuts Firefox's own new tab page showed (pinned and frequent sites).
async function importShortcuts() {
    // Requested on click, so installing Tack never asks for history access.
    if (!(await browser.permissions.request({ permissions: ['topSites'] }))) {
        return;
    }
    // newtab: exactly what Firefox's page showed. It's empty if that page hasn't been built this
    // session, so fall back to pinned plus most-visited sites, one per domain.
    let sites = await browser.topSites.get({ newtab: true });
    if (sites.length === 0) {
        sites = await browser.topSites.get({ includePinned: true, onePerDomain: true, limit: 16 });
    }
    const added = shortcutsToLinks(sites, links);
    if (added.length === 0) {
        alert(sites.length === 0 ? 'Firefox has no shortcuts to import yet.' : 'Your Firefox shortcuts are already in Tack.');
        return;
    }
    if (!confirm(`Add ${added.length} Firefox shortcuts?\n\n${added.map(link => link.title).join(', ')}`)) {
        return;
    }
    links = [...links, ...added];
    await save();
}

function importLinks() {
    const input = Object.assign(document.createElement('input'), { type: 'file', accept: '.json,application/json' });
    input.addEventListener('change', async () => {
        const file = input.files?.[0];
        if (!file) {
            return;
        }
        let imported;
        try {
            imported = parseImport(await file.text());
        } catch (error) {
            alert(`${file.name} isn't valid JSON: ${error instanceof Error ? error.message : error}`);
            return;
        }
        if (imported.length === 0) {
            alert(`No http(s) links found in ${file.name}.`);
            return;
        }
        if (links.length > 0 && !confirm(`Replace your ${links.length} links with the ${imported.length} in ${file.name}?`)) {
            return;
        }
        links = imported;
        await save();
    });
    input.click();
}

function downloadLinks() {
    const url = URL.createObjectURL(new Blob([exportLinks(links)], { type: 'application/json' }));
    Object.assign(document.createElement('a'), { href: url, download: 'tack-links.json' }).click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function loadStylesheet() {
    if (document.getElementById('tack-edit-css')) {
        return Promise.resolve();
    }
    const link = Object.assign(document.createElement('link'), { id: 'tack-edit-css', rel: 'stylesheet', href: 'edit.css' });
    const loaded = new Promise(resolve => {
        link.addEventListener('load', resolve, { once: true });
        link.addEventListener('error', resolve, { once: true });
    });
    document.head.append(link);
    return loaded;
}

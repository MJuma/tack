// The only script on the new tab hot path. It paints the grid from HTML the background page
// pre-rendered into localStorage (a synchronous read), so opening a tab parses no JSON, awaits
// nothing and builds no DOM by hand. Everything else loads on demand.
'use strict';
{
    // Keep in sync with CACHE_KEY in lib/cache.js (importing it here would cost a module load).
    const CACHE_KEY = 'tack:html';
    const grid = document.getElementById('g');
    const body = document.body;
    const editing = () => body.classList.contains('editing');

    const cached = localStorage.getItem(CACHE_KEY);
    if (cached === null) {
        // First run, or the cache was cleared: build it from extension storage.
        import('./lib/cache.js')
            .then(cache => cache.rebuild())
            .then(({ html }) => {
                grid.innerHTML = html;
            })
            .catch(reportError);
    } else {
        grid.innerHTML = cached;
    }

    // Another tab or the background page updated the cache (an edit, a synced change, new icons).
    addEventListener('storage', event => {
        if (event.key === CACHE_KEY && event.newValue !== null && !editing()) {
            grid.innerHTML = event.newValue;
        }
    });

    const edit = () => {
        import('./edit.js')
            .then(editor => editor.start(grid))
            .catch(reportError);
    };
    document.getElementById('e').addEventListener('click', edit);
    grid.addEventListener('click', event => {
        if (!editing() && event.target.closest('[data-edit]')) {
            edit();
        }
    });
}

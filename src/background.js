// Event page: it sleeps until something changes the links (an edit here, or Firefox Sync bringing
// one from another machine), then re-renders the new tab cache and fetches any new favicons. It
// also wakes when a tab shows a favicon, to fill in icons Tack couldn't fetch itself.
import { learnFromTab, refresh } from './lib/cache.js';

browser.runtime.onInstalled.addListener(() => refresh());
browser.runtime.onStartup.addListener(() => refresh());
browser.permissions.onAdded.addListener(() => refresh());

browser.storage.onChanged.addListener((_changes, area) => {
    if (area === 'sync') {
        void refresh();
    }
});

// The filter wakes this page only when a favicon changes, not on every tab update. Tabs only report
// favicons for sites Tack may access ("Allow icons"); private windows are left alone.
browser.tabs.onUpdated.addListener(
    (_tabId, changes, tab) => {
        if (changes.favIconUrl && tab.url && !tab.incognito) {
            void learnFromTab(tab.url, changes.favIconUrl);
        }
    },
    { properties: ['favIconUrl'] },
);

browser.runtime.onMessage.addListener(message => {
    if (message?.type === 'refresh') {
        return refresh({ force: Boolean(message.force) });
    }
    return undefined;
});

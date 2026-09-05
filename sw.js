/**
 * Service-Worker (Phase 5).
 *
 * Zwei Sorten Inhalt, zwei Strategien:
 *
 *  - **Eigene Dateien** (HTML, `src/`, Styles) kommen **aus dem Netz zuerst**,
 *    mit dem Cache als Rückfallebene. Vorher galt auch hier Cache zuerst, und
 *    das war ein Fehler: die App fror auf dem Stand der Erstinstallation ein.
 *    Am Gerät lief tagelang eine alte Fassung, während der Server längst eine
 *    neue auslieferte. Sie sind zusammen keine 60 KB, das Nachfragen kostet
 *    also kaum etwas.
 *  - **Vendorte Bibliotheken und Icons** bleiben Cache zuerst. MapLibre allein
 *    wiegt 578 KB und ändert sich nur, wenn die Version wechselt — die käme
 *    unter neuem Namen.
 *  - **Kartenkacheln** (swisstopo-Terrain, Luftbild, WMTS/WMS-Overlays) werden
 *    im Betrieb gesammelt, gedeckelt auf `MAX_TILES`. Wer eine Strecke einmal
 *    gefahren ist, sieht sie im Funkloch wieder.
 *
 * **Nicht zwischengespeichert wird api3** — dort kommen die Regeltexte und die
 * Hindernisse her. Eine veraltete Rechtsauskunft wäre schlimmer als gar keine.
 *
 * Beim Versionswechsel werden alle alten Caches entfernt: `CACHE_VERSION`
 * hochzählen ersetzt jede Invalidierungslogik.
 */
const CACHE_VERSION = 'v3';
const SHELL_CACHE = `cockpit-shell-${CACHE_VERSION}`;
const TILE_CACHE = `cockpit-tiles-${CACHE_VERSION}`;

/** Deckel des Kachelspeichers. Rund 20–40 MB bei üblichen Kachelgrössen. */
const MAX_TILES = 700;

/**
 * Hosts, deren Antworten als Kacheln gelten.
 *
 * api3 fehlt hier bewusst — dort kommen Regeltexte und Hindernisse her, eine
 * veraltete Rechtsauskunft wäre schlimmer als gar keine. Aus demselben Grund
 * fehlt `tilecache.rainviewer.com`: ein Radarbild aus dem Speicher zeigte
 * Regen, der längst weitergezogen ist.
 */
const TILE_HOSTS = ['wmts.geo.admin.ch', 'wms.geo.admin.ch', '3d.geo.admin.ch'];

const SHELL = [
    './',
    './index.html',
    './manifest.webmanifest',
    './styles/app.css',
    './src/main.js',
    './src/config.js',
    './src/map.js',
    './src/terrain.js',
    './src/terrain-worker.js',
    './src/prefetch.js',
    './src/radar.js',
    './src/geolocation.js',
    './src/compass.js',
    './src/follow.js',
    './src/overlays.js',
    './src/obstacles.js',
    './src/info.js',
    './src/me.js',
    './vendor/maplibre-gl/maplibre-gl.mjs',
    './vendor/maplibre-gl/maplibre-gl-shared.mjs',
    './vendor/maplibre-gl/maplibre-gl-worker.mjs',
    './vendor/maplibre-gl/maplibre-gl.css',
    './vendor/maplibre-gl-3dtiles-terrain/index.js',
    './vendor/quantized-mesh-decoder/index.js',
    './icons/icon-180.png',
    './icons/icon-192.png',
    './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
        const cache = await caches.open(SHELL_CACHE);
        await cache.addAll(SHELL);
        await self.skipWaiting();
    })());
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const names = await caches.keys();
        await Promise.all(names
            .filter((name) => name !== SHELL_CACHE && name !== TILE_CACHE)
            .map((name) => caches.delete(name)));
        await self.clients.claim();
    })());
});

/**
 * Kacheln seit dem letzten Beschneiden. `cache.keys()` baut die vollständige
 * Schlüsselliste auf — bei vollem Speicher bis zu `MAX_TILES` Request-Objekte.
 * Das nach *jeder* einzelnen Kachel zu tun, war der teuerste Teil des
 * Kachel-Cachings: im Cockpit-Blick kommen dreistellig viele Kacheln pro
 * Ansicht, und jede zog eine volle Enumeration nach sich.
 */
let putsSinceTrim = 0;

/**
 * So viele Kacheln dürfen zwischen zwei Durchgängen auflaufen. Der Speicher
 * wächst dadurch kurzzeitig bis `MAX_TILES + TRIM_EVERY` — gemessen an rund
 * 20–40 MB Gesamtgrösse ist das belanglos, die gesparten Enumerationen sind es
 * nicht. Wird der Worker zwischendurch beendet, beginnt die Zählung von vorn;
 * der Deckel greift dann eben eine Kachelreihe später.
 */
const TRIM_EVERY = 50;

/** Ältestes zuerst: `cache.keys()` liefert in Einfügereihenfolge. */
async function trimTiles() {
    const cache = await caches.open(TILE_CACHE);
    const keys = await cache.keys();
    if (keys.length <= MAX_TILES) return;
    await Promise.all(keys.slice(0, keys.length - MAX_TILES).map((key) => cache.delete(key)));
}

async function tileFirst(request) {
    const cache = await caches.open(TILE_CACHE);
    const hit = await cache.match(request);
    if (hit) return hit;
    const response = await fetch(request);
    if (response.ok) {
        await cache.put(request, response.clone());
        if (++putsSinceTrim >= TRIM_EVERY) {
            putsSinceTrim = 0;
            trimTiles();
        }
    }
    return response;
}

/** Unveränderliches: Bibliotheken und Icons. */
function isImmutable(url) {
    return url.pathname.includes('/vendor/') || url.pathname.includes('/icons/');
}

async function cacheFirst(request) {
    const cached = await caches.match(request);
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok) (await caches.open(SHELL_CACHE)).put(request, response.clone());
    return response;
}

/**
 * Netz zuerst, Cache als Rückfallebene — und der Cache wird bei jedem
 * erfolgreichen Abruf aufgefrischt, damit der Offline-Vorrat aktuell bleibt.
 * `cache: 'no-cache'` erzwingt die Rückfrage beim Server; unverändert kostet
 * das ein 304 und keine Nutzlast.
 */
async function networkFirst(request) {
    try {
        const response = await fetch(request, {cache: 'no-cache'});
        if (response.ok) (await caches.open(SHELL_CACHE)).put(request, response.clone());
        return response;
    } catch (error) {
        const cached = await caches.match(request);
        if (cached) return cached;
        // Navigationsanfragen ohne Netz auf die Hülle zurückfallen lassen,
        // sonst zeigt Safari die Dinosaurier-Seite statt der Karte.
        if (request.mode === 'navigate') {
            const fallback = await caches.match('./index.html');
            if (fallback) return fallback;
        }
        throw error;
    }
}

self.addEventListener('fetch', (event) => {
    const {request} = event;
    if (request.method !== 'GET') return;
    const url = new URL(request.url);

    if (TILE_HOSTS.includes(url.hostname)) {
        event.respondWith(tileFirst(request));
        return;
    }
    if (url.origin === self.location.origin) {
        event.respondWith(isImmutable(url) ? cacheFirst(request) : networkFirst(request));
    }
});

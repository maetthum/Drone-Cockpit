/**
 * Terrain-Resampling, neben dem Hauptthread.
 *
 * Das Plugin resampelt jede angeforderte Mercator-Kachel aus dem Quantized-Mesh
 * auf ein Terrarium-Raster: 256 × 256 baryzentrische Suchen im TIN, je Kachel.
 * Am Startblick nachgemessen waren das rund 2,3 s reine Rechenzeit — und weil
 * sie im Hauptthread lag, zeichnete der Browser währenddessen überhaupt nichts.
 * Auch längst geladene Luftbildkacheln blieben unsichtbar, solange gerechnet
 * wurde. Genau das war der zweite grosse Posten der Startzeit.
 *
 * Hier läuft dieselbe Rechnung im Worker. Das Plugin bleibt dabei unverändert
 * (`vendor/` wird nicht angefasst): statt des echten `maplibregl` bekommt es
 * eine Attrappe, die den Protokoll-Handler bloss einsammelt, statt ihn bei
 * MapLibre anzumelden. Diesen Handler ruft der Worker dann selbst auf.
 */
import decode from '../vendor/quantized-mesh-decoder/index.js';
import {
    loadQuantizedMeshDataset,
    registerQuantizedMeshTerrain
} from '../vendor/maplibre-gl-3dtiles-terrain/index.js';
import {SHADOW} from './config.js';

/** Der vom Plugin „angemeldete" Kachel-Handler. */
let handler = null;

/** Laufende Kachelanfragen, damit MapLibres Abbruch hier ankommt. */
const pending = new Map();

/**
 * Attrappe an der Stelle von `maplibregl`. Das Plugin ruft darauf nur
 * `addProtocol`/`removeProtocol` auf — mehr braucht es nicht.
 */
const collector = {
    addProtocol(_protocol, protocolHandler) { handler = protocolHandler; },
    removeProtocol() { handler = null; }
};

/** Für den Schatten-Datensatz (siehe unten) — eigene Attrappe, eigener Handler. */
let shadowHandler = null;
const shadowCollector = {
    addProtocol(_protocol, protocolHandler) { shadowHandler = protocolHandler; },
    removeProtocol() { shadowHandler = null; }
};

/**
 * Cache des resampelten Schatten-Kachelbildes je `z/x/y`. Der Plugin-eigene
 * `meshCache` (siehe `registerQuantizedMeshTerrain`) hält nur den rohen
 * dekodierten Mesh — das teure baryzentrische Resampling auf das
 * 256×256-Terrarium-Raster läuft bei jedem Aufruf des Protokoll-Handlers neu.
 * Ohne diesen Cache resamplet also jede Schattenberechnung (auch ein reiner
 * Zeitwechsel ohne Kartenbewegung) alle 25 Kacheln komplett neu.
 * Gedeckelt, damit eine lange Fahrt den Worker nicht unbegrenzt Bitmaps
 * ansammeln lässt — älteste Einträge fliegen zuerst raus.
 */
const SHADOW_TILE_CACHE_LIMIT = 100;
const shadowTileCache = new Map();

async function getShadowTile(shadowTileHandler, gridZoom, x, y) {
    const key = `${gridZoom}/${x}/${y}`;
    if (shadowTileCache.has(key)) {
        const bitmap = shadowTileCache.get(key);
        // An den Schluss verschieben (Map behält Einfügereihenfolge) — zuletzt
        // genutzte Kacheln sollen zuletzt verworfen werden.
        shadowTileCache.delete(key);
        shadowTileCache.set(key, bitmap);
        return bitmap;
    }
    const {data} = await shadowTileHandler({url: `quantized-mesh://${gridZoom}/${x}/${y}`}, new AbortController());
    shadowTileCache.set(key, data);
    if (shadowTileCache.size > SHADOW_TILE_CACHE_LIMIT) {
        shadowTileCache.delete(shadowTileCache.keys().next().value);
    }
    return data;
}

/** `layer.json`-URL und Optionen aus `init()`, für den späten Schatten-Ladevorgang. */
let initParams = null;
let shadowHandlerPromise = null;

async function init({layerJsonUrl, options}) {
    initParams = {layerJsonUrl, options};
    const dataset = await loadQuantizedMeshDataset(layerJsonUrl, options);
    // Der Rückgabewert enthält die fertige Source-Spezifikation; die braucht
    // der Hauptthread, um die Terrain-Quelle anzulegen.
    return registerQuantizedMeshTerrain(collector, {dataset, decode}).sourceSpec;
}

/**
 * Lädt einen zweiten Datensatz, nur für den Geländeschatten — erst bei der
 * ersten Anfrage, nicht beim Start (wer den Schatten nie einschaltet, soll
 * auch kein zweites `layer.json` laden).
 *
 * Ein eigener Datensatz ist nötig, nicht bloss eine feinere Kachelanfrage an
 * den bestehenden: swisstopo liefert kein `available`-Array, das Plugin
 * synthetisiert die Verfügbarkeit nur bis zum übergebenen `maxZoom`. Mit dem
 * Live-Terrain-Deckel (`TERRAIN.maxZoom`, 14) würde jede Anfrage über Zoom 14
 * hinaus nur denselben gröberen Kachelsatz feiner resampeln — ohne echte
 * zusätzliche Geländedetails vom Server zu holen (siehe SHADOW in config.js).
 *
 * Immer mit `SHADOW.maxGridZoom` geladen, nicht mit dem gerade angefragten
 * `gridZoom` (der folgt seit dem 13.9.2026 dem Kamera-Zoom, siehe shadow.js):
 * die synthetisierte Verfügbarkeit reicht sonst nur bis zum *ersten* Aufruf —
 * wer zuerst herauszoomt, fände beim Zurückzoomen keine feineren Kacheln mehr.
 */
async function ensureShadowHandler() {
    if (shadowHandler) return shadowHandler;
    if (!shadowHandlerPromise) {
        shadowHandlerPromise = (async () => {
            const {layerJsonUrl, options} = initParams;
            const shadowDataset = await loadQuantizedMeshDataset(layerJsonUrl, {...options, maxZoom: SHADOW.maxGridZoom});
            registerQuantizedMeshTerrain(shadowCollector, {dataset: shadowDataset, decode});
            return shadowHandler;
        })();
        // Bei Fehlschlag nicht dauerhaft ein totes Versprechen cachen (gleiches
        // Muster wie `meshCache` im Terrain-Plugin) — sonst würde jeder
        // spätere Versuch für den Rest der Sitzung an genau diesem einen
        // Fehler scheitern, statt den echten Ladeversuch zu wiederholen.
        shadowHandlerPromise.catch(() => { shadowHandlerPromise = null; });
    }
    return shadowHandlerPromise;
}

/** Terrarium-Kodierung: height = R·256 + G + B/256 − 32768 (wie im Terrain-Plugin). */
function terrariumPack(height) {
    const value = Math.round((height + 32768) * 256);
    return [Math.floor(value / 65536) % 256, Math.floor(value / 256) % 256, value % 256];
}

function tile2lng(x, z) {
    return (x / 2 ** z) * 360 - 180;
}
function tile2lat(y, z) {
    return (180 / Math.PI) * Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z)));
}

/**
 * Lädt das Höhenraster für den Geländeschatten: Kachelraster um den
 * Kartenmittelpunkt zusammensetzen und als Terrarium-Textur zurückgeben.
 * Die eigentliche Verschattungsrechnung läuft seit dem 13.9.2026 nicht mehr
 * hier, sondern in einem eigenen WebGL-Kontext pro Bildpunkt (siehe
 * `shadow.js`) — sonst kam die CPU-Neuberechnung bei Kartenbewegung nicht mit
 * dem Kamera-Takt mit. Siehe SHADOW in config.js für die Parameter und den
 * Zielkonflikt Auflösung/Reichweite.
 */
async function buildShadowGrid({id, center, gridZoom, gridRadiusTiles, outputRadiusTiles}) {
    const TILE_SIZE = 256;
    try {
        const shadowTileHandler = await ensureShadowHandler();

        const n = 2 ** gridZoom;
        const latRad = (center.lat * Math.PI) / 180;
        const xCenter = Math.floor(((center.lng + 180) / 360) * n);
        const yCenter = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);

        const gridSize = 2 * gridRadiusTiles + 1;
        const x0 = xCenter - gridRadiusTiles;
        const y0 = yCenter - gridRadiusTiles;

        const canvas = new OffscreenCanvas(gridSize * TILE_SIZE, gridSize * TILE_SIZE);
        const ctx = canvas.getContext('2d');
        // Flache Ersatzebene (1500 m, wie der Terrain-Fallback) vorfüllen: eine
        // nicht verfügbare Kachel soll eine plausible Fläche hinterlassen,
        // keinen rechnerischen Abgrund (0/0/0 dekodiert als −32768 m).
        const [fr, fg, fb] = terrariumPack(1500);
        ctx.fillStyle = `rgb(${fr},${fg},${fb})`;
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        await Promise.all(Array.from({length: gridSize * gridSize}, async (_, i) => {
            const dx = i % gridSize;
            const dy = Math.floor(i / gridSize);
            try {
                const data = await getShadowTile(shadowTileHandler, gridZoom, x0 + dx, y0 + dy);
                ctx.drawImage(data, dx * TILE_SIZE, dy * TILE_SIZE);
            } catch {
                // Kachel nicht verfügbar — die vorgefüllte flache Ebene bleibt stehen.
            }
        }));

        const metersPerPixel = (156543.03392804097 * Math.cos(latRad)) / 2 ** gridZoom;

        // Ganzes Raster (inkl. Rand) als Textur — der Shader braucht den Rand
        // für die Verdeckungsprüfung Richtung Sonne über den sichtbaren
        // Ausschnitt hinaus.
        const bitmap = canvas.transferToImageBitmap();
        // Geografische Ecken des sichtbaren (inneren) Ausschnitts, für die
        // `image`-Source in shadow.js — dieselbe Kachel-Rückrechnung wie beim
        // Laden, nur auf den inneren Rand statt auf das ganze Raster angewendet.
        const innerBounds = {
            west: tile2lng(x0 + gridRadiusTiles - outputRadiusTiles, gridZoom),
            east: tile2lng(x0 + gridRadiusTiles + outputRadiusTiles + 1, gridZoom),
            north: tile2lat(y0 + gridRadiusTiles - outputRadiusTiles, gridZoom),
            south: tile2lat(y0 + gridRadiusTiles + outputRadiusTiles + 1, gridZoom)
        };
        self.postMessage({type: 'shadow', id, bitmap, innerBounds, metersPerPixel}, [bitmap]);
    } catch (error) {
        self.postMessage({type: 'shadow', id, error: String(error?.message ?? error)});
    }
}

async function buildTile(id, url) {
    // Das Plugin liest `abortController.signal` und bricht die Pixelschleife
    // zwischen zwei Zeilen ab — eine aus dem Blick geratene Kachel soll nicht
    // zu Ende gerechnet werden, während neue warten.
    const controller = new AbortController();
    pending.set(id, controller);
    try {
        const {data} = await handler({url}, controller);
        // ImageBitmap wird übergeben, nicht kopiert.
        self.postMessage({type: 'tile', id, data}, [data]);
    } catch (error) {
        self.postMessage({type: 'tile', id, error: String(error?.message ?? error)});
    } finally {
        pending.delete(id);
    }
}

self.onmessage = async ({data: message}) => {
    if (message.type === 'init') {
        try {
            self.postMessage({type: 'ready', sourceSpec: await init(message)});
        } catch (error) {
            self.postMessage({type: 'ready', error: String(error?.message ?? error)});
        }
        return;
    }
    if (message.type === 'tile') {
        buildTile(message.id, message.url);
        return;
    }
    if (message.type === 'shadow') {
        buildShadowGrid(message);
        return;
    }
    if (message.type === 'abort') {
        pending.get(message.id)?.abort();
        pending.delete(message.id);
    }
};

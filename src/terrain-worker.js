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
 */
async function ensureShadowHandler(gridZoom) {
    if (shadowHandler) return shadowHandler;
    if (!shadowHandlerPromise) {
        shadowHandlerPromise = (async () => {
            const {layerJsonUrl, options} = initParams;
            const shadowDataset = await loadQuantizedMeshDataset(layerJsonUrl, {...options, maxZoom: gridZoom});
            registerQuantizedMeshTerrain(shadowCollector, {dataset: shadowDataset, decode});
            return shadowHandler;
        })();
    }
    return shadowHandlerPromise;
}

/** Terrarium-Kodierung: height = R·256 + G + B/256 − 32768 (wie im Terrain-Plugin). */
function terrariumPack(height) {
    const value = Math.round((height + 32768) * 256);
    return [Math.floor(value / 65536) % 256, Math.floor(value / 256) % 256, value % 256];
}
function terrariumUnpack(r, g, b) {
    return r * 256 + g + b / 256 - 32768;
}

function tile2lng(x, z) {
    return (x / 2 ** z) * 360 - 180;
}
function tile2lat(y, z) {
    return (180 / Math.PI) * Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z)));
}

/**
 * Baut die Schattenfläche: Kachelraster um den Kartenmittelpunkt laden,
 * Höhen dekodieren, je sichtbarem Pixel den Sonnenstrahl Richtung Azimut
 * abschreiten. Siehe SHADOW in config.js für die Parameter und den
 * Zielkonflikt Auflösung/Reichweite.
 */
async function buildShadowGrid({
    id, center, sunAzimuthDeg, sunAltitudeDeg,
    gridZoom, gridRadiusTiles, outputRadiusTiles, rayStepPixels, opacityByte
}) {
    const TILE_SIZE = 256;
    try {
        const shadowTileHandler = await ensureShadowHandler(gridZoom);

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
                const {data} = await shadowTileHandler(
                    {url: `quantized-mesh://${gridZoom}/${x0 + dx}/${y0 + dy}`}, new AbortController());
                ctx.drawImage(data, dx * TILE_SIZE, dy * TILE_SIZE);
            } catch {
                // Kachel nicht verfügbar — die vorgefüllte flache Ebene bleibt stehen.
            }
        }));

        const {data: pixels, width, height} = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const heights = new Float32Array(width * height);
        for (let p = 0; p < width * height; p++) {
            heights[p] = terrariumUnpack(pixels[p * 4], pixels[p * 4 + 1], pixels[p * 4 + 2]);
        }

        // Bilinear, damit der abgeschrittene Strahl nicht an Rasterstufen hängen bleibt.
        function sampleHeight(px, py) {
            const x0i = Math.floor(px);
            const y0i = Math.floor(py);
            if (x0i < 0 || y0i < 0 || x0i >= width - 1 || y0i >= height - 1) return null;
            const fx = px - x0i;
            const fy = py - y0i;
            const h00 = heights[y0i * width + x0i];
            const h10 = heights[y0i * width + x0i + 1];
            const h01 = heights[(y0i + 1) * width + x0i];
            const h11 = heights[(y0i + 1) * width + x0i + 1];
            return h00 * (1 - fx) * (1 - fy) + h10 * fx * (1 - fy) + h01 * (1 - fx) * fy + h11 * fx * fy;
        }

        const metersPerPixel = (156543.03392804097 * Math.cos(latRad)) / 2 ** gridZoom;
        const marginPixels = (gridRadiusTiles - outputRadiusTiles) * TILE_SIZE;
        const outputSize = (2 * outputRadiusTiles + 1) * TILE_SIZE;
        const out = new Uint8ClampedArray(outputSize * outputSize * 4);

        const azimuthRad = (sunAzimuthDeg * Math.PI) / 180;
        const dirX = Math.sin(azimuthRad);
        const dirY = -Math.cos(azimuthRad);
        const altitudeRad = (sunAltitudeDeg * Math.PI) / 180;
        // Sonne unter dem Horizont: Nacht, kein Abschreiten nötig.
        const night = sunAltitudeDeg <= 0;
        const maxSteps = Math.floor(marginPixels / rayStepPixels);

        for (let oy = 0; oy < outputSize; oy++) {
            for (let ox = 0; ox < outputSize; ox++) {
                const px = marginPixels + ox;
                const py = marginPixels + oy;
                let shadowed = night;
                if (!night) {
                    const originHeight = sampleHeight(px, py);
                    if (originHeight !== null) {
                        for (let step = 1; step <= maxSteps; step++) {
                            const dist = step * rayStepPixels;
                            const h = sampleHeight(px + dirX * dist, py + dirY * dist);
                            if (h === null) break;
                            // Sichtwinkel vom Ursprung zum abgetasteten Punkt, gegen
                            // die Sonnenhöhe: darüber blockiert das Gelände dort die
                            // Sonne von hier aus.
                            if (Math.atan2(h - originHeight, dist * metersPerPixel) > altitudeRad) {
                                shadowed = true;
                                break;
                            }
                        }
                    }
                }
                const o = (oy * outputSize + ox) * 4;
                out[o + 3] = shadowed ? opacityByte : 0;
            }
        }

        const bitmap = await createImageBitmap(new ImageData(out, outputSize, outputSize));
        // Geografische Ecken des sichtbaren (inneren) Ausschnitts, für MapLibres
        // Bild-Source — dieselbe Kachel-Rückrechnung wie beim Laden, nur auf den
        // inneren Rand statt auf das ganze Raster angewendet.
        const bounds = {
            west: tile2lng(x0 + gridRadiusTiles - outputRadiusTiles, gridZoom),
            east: tile2lng(x0 + gridRadiusTiles + outputRadiusTiles + 1, gridZoom),
            north: tile2lat(y0 + gridRadiusTiles - outputRadiusTiles, gridZoom),
            south: tile2lat(y0 + gridRadiusTiles + outputRadiusTiles + 1, gridZoom)
        };
        self.postMessage({type: 'shadow', id, bitmap, bounds}, [bitmap]);
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

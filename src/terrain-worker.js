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

async function init({layerJsonUrl, options}) {
    const dataset = await loadQuantizedMeshDataset(layerJsonUrl, options);
    // Der Rückgabewert enthält die fertige Source-Spezifikation; die braucht
    // der Hauptthread, um die Terrain-Quelle anzulegen.
    return registerQuantizedMeshTerrain(collector, {dataset, decode}).sourceSpec;
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
    if (message.type === 'abort') {
        pending.get(message.id)?.abort();
        pending.delete(message.id);
    }
};

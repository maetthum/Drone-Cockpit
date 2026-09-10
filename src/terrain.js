/**
 * Terrain-Anbindung: swisstopo liefert Quantized-Mesh (Cesium-Schema), MapLibre
 * kann nur `raster-dem`. Das Plugin resampelt die TIN-Kacheln clientseitig auf
 * ein Terrarium-Raster und stellt sie über `addProtocol` bereit — dadurch
 * funktionieren `setTerrain` und das Draping unverändert — Letzteres trägt die
 * Raster-Overlays und die Höhenvolumen der Zonen.
 *
 * Gerechnet wird seit dem 4.9.2026 in `terrain-worker.js`, nicht mehr hier: das
 * Resampling kostete beim Startblick rund 2,3 s Hauptthread und hielt damit
 * jedes Zeichnen an. Dieses Modul ist nur noch die Brücke — es reicht
 * Kachelanfragen samt Abbruch an den Worker weiter und gibt die fertigen
 * Bitmaps an MapLibre zurück.
 */
import {TERRAIN} from './config.js';

const PROTOCOL = 'quantized-mesh';

/**
 * Startet den Terrain-Worker und registriert das Protokoll.
 * @param {object} maplibregl geladenes maplibre-gl-Modul
 * @returns {Promise<{sourceSpec: object, unregister: () => void}>}
 */
export async function setUpTerrain(maplibregl) {
    const worker = new Worker(new URL('./terrain-worker.js', import.meta.url), {type: 'module'});
    /** Offene Kachelanfragen, nach laufender Nummer. */
    const pending = new Map();
    let nextId = 0;

    const sourceSpec = await new Promise((resolve, reject) => {
        worker.addEventListener('message', ({data: message}) => {
            if (message.type === 'ready') {
                if (message.error) reject(new Error(message.error));
                else resolve(message.sourceSpec);
                return;
            }
            const entry = pending.get(message.id);
            // Kein Eintrag mehr: die Kachel wurde abgebrochen, während der
            // Worker sie noch fertig gerechnet hat. Ergebnis verfällt.
            if (!entry) return;
            pending.delete(message.id);
            if (message.error) entry.reject(new Error(message.error));
            else entry.resolve({data: message.data});
        });
        // Ein Worker, der gar nicht erst startet (fehlende Datei, kein
        // Modul-Support), darf nicht als Zeitüberschreitung enden: der
        // Aufrufer zeigt sonst nie sein Fehlerbanner.
        worker.addEventListener('error', (event) => {
            reject(new Error(event.message || 'Terrain-Worker konnte nicht starten'));
        });
        worker.postMessage({
            type: 'init',
            layerJsonUrl: TERRAIN.layerJsonUrl,
            options: {
                attribution: TERRAIN.attribution,
                boundsOverride: TERRAIN.boundsOverride,
                maxZoom: TERRAIN.maxZoom
            }
        });
    });

    maplibregl.addProtocol(PROTOCOL, ({url}, abortController) => new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, {resolve, reject});
        // MapLibre bricht Kacheln ab, die aus dem Blick geraten sind. Ohne das
        // Weiterreichen rechnete der Worker sie zu Ende, während die neuen
        // warten — bei laufender Kamera ist das der Normalfall, nicht die
        // Ausnahme. Das Promise muss dabei abgelehnt werden: bliebe es offen,
        // hielte MapLibre den Kachelplatz für immer belegt.
        abortController?.signal?.addEventListener('abort', () => {
            if (!pending.delete(id)) return;
            worker.postMessage({type: 'abort', id});
            reject(new DOMException('Tile request aborted', 'AbortError'));
        });
        worker.postMessage({type: 'tile', id, url});
    }));

    return {
        sourceSpec,
        unregister: () => {
            maplibregl.removeProtocol(PROTOCOL);
            worker.terminate();
        }
    };
}

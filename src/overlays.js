/**
 * Sperr- und Hinweisflächen als WMTS-Raster über dem Terrain (Phase 4a).
 *
 * Die Layer-IDs sind nicht verifiziert (siehe config.js). Deshalb zählt dieses
 * Modul Kachelfehler pro Layer mit: das Panel kann einen Layer, der nichts
 * liefert, als solchen ausweisen, statt den Nutzer im Unklaren zu lassen.
 */
import {COVERAGE_BOUNDS, OVERLAYS, WMS, WMTS} from './config.js';

/** Auch main.js braucht ihn, um Overlay-Fehler vom Fehlerbanner auszunehmen. */
export const SOURCE_PREFIX = 'overlay-';

/**
 * Kachel über der Schweiz (z8/x133/y90, ~46,8° N / 8,2° E), mit der jede
 * Layer-ID beim Start einmal angefragt wird. Exportiert, damit der Smoke-Test
 * die Prüfanfrage von den Kartenkacheln unterscheiden kann, ohne die Werte zu
 * kopieren.
 */
export const PROBE_TILE = {z: 8, x: 133, y: 90};

function sourceId(overlay) {
    return `${SOURCE_PREFIX}${overlay.id}`;
}

/** WMTS oder WMS — nicht jeder geo.admin-Layer hat einen Kachelsatz. */
function serviceOf(overlay) {
    return overlay.service === 'wms' ? WMS : WMTS;
}

function tileUrl(overlay) {
    return serviceOf(overlay).urlTemplate.replace('{layer}', overlay.layer);
}

/**
 * Bounding-Box einer Kachel in EPSG:3857. Nur die Verfügbarkeitsprüfung braucht
 * sie: MapLibre füllt `{bbox-epsg-3857}` im Betrieb selbst, ein blosser `fetch`
 * nicht.
 */
export function tileBbox({z, x, y}) {
    const half = 20037508.342789244;
    const size = (2 * half) / 2 ** z;
    const minX = -half + x * size;
    const maxY = half - y * size;
    return `${minX},${maxY - size},${minX + size},${maxY}`;
}

/**
 * Legt alle Overlay-Sources und -Layer an.
 *
 * @param {import('maplibre-gl').Map} map
 * @returns {{setVisible: (id: string, visible: boolean) => void, isVisible: (id: string) => boolean}}
 */
export function createOverlays(map) {
    /**
     * Layer, deren Sichtbarkeit der Nutzer selbst gesetzt hat. `applyDefaults()`
     * fasst sie nicht mehr an — wer während des Ladens einen Schalter umlegt,
     * soll ihn nicht zurückspringen sehen.
     */
    const vomNutzerGesetzt = new Set();

    OVERLAYS.forEach((overlay) => {
        map.addSource(sourceId(overlay), {
            type: 'raster',
            tiles: [tileUrl(overlay)],
            tileSize: serviceOf(overlay).tileSize,
            // Eigener Wert schlägt den gemeinsamen: nicht jeder Layer reicht so
            // tief. `ch.vbs.sperr-gefahrenzonenkarte` endet bei z12 und
            // antwortete darüber mit HTTP 400 — 54 stumme Fehlschläge je
            // Kartenaufbau, bevor das auffiel. Mit korrekter Grenze holt
            // MapLibre die gröbere Kachel und skaliert sie hoch.
            maxzoom: overlay.maxzoom ?? serviceOf(overlay).maxzoom,
            // Alle Layer decken nur die Schweiz ab — ohne die Grenze fordert
            // MapLibre auch ausserhalb Kacheln an (siehe COVERAGE).
            bounds: COVERAGE_BOUNDS
            // Kein `attribution` pro Source: der Quellenhinweis steht fix im
            // HUD, und ein leeres Feld verstösst gegen die Style-Spec — MapLibre
            // verwirft die Source dann per Fehler-Event, statt sie anzulegen.
        });
        map.addLayer({
            id: sourceId(overlay),
            type: 'raster',
            source: sourceId(overlay),
            /*
             * **Alle** starten unsichtbar, auch die vorgabemässig
             * eingeschalteten — `applyDefaults()` schaltet sie nach, sobald
             * Luftbild und Gelände stehen.
             *
             * Grund: unsichtbare Layer fordern keine Kacheln an, und die
             * Overlays sind der grösste Posten der Ladezeit. Gemessen in der
             * Safari-Engine bei 2560 × 1440 Retina: mit ihnen 2856 ms und 599
             * Kacheln, ohne sie 1483 ms und 303 — sie kosten also fast die
             * Hälfte. Zuerst das Luftbild, dann die Flächen darüber: die Karte
             * ist damit rund eine Sekunde früher brauchbar, statt dass alles
             * gleichzeitig um dieselben Verbindungen kämpft.
             */
            layout: {visibility: 'none'},
            // Eigener Wert schlägt den gemeinsamen: Flächen dezent, damit die
            // Karte darunter lesbar bleibt; Linien und Punkte kräftig, damit
            // sie überhaupt zu sehen sind (siehe WMTS.opacity).
            paint: {'raster-opacity': overlay.opacity ?? WMTS.opacity}
        });
    });

    return {
        /**
         * Schaltet die vorgabemässig sichtbaren Overlays ein. Wird aufgerufen,
         * sobald die Basemap steht (siehe main.js) — vorher liegen sie
         * bewusst still.
         */
        applyDefaults() {
            OVERLAYS.forEach((overlay) => {
                if (!overlay.enabled || vomNutzerGesetzt.has(overlay.id)) return;
                map.setLayoutProperty(`${SOURCE_PREFIX}${overlay.id}`, 'visibility', 'visible');
            });
        },

        setVisible(id, visible) {
            vomNutzerGesetzt.add(id);
            map.setLayoutProperty(`${SOURCE_PREFIX}${id}`, 'visibility', visible ? 'visible' : 'none');
        },
        isVisible(id) {
            return map.getLayoutProperty(`${SOURCE_PREFIX}${id}`, 'visibility') !== 'none';
        }
    };
}

/**
 * Prüft jede Layer-ID mit einer einzigen Kachelanfrage.
 *
 * Nötig, weil MapLibre für fehlgeschlagene Raster-Kacheln **kein** Fehler-
 * Ereignis feuert — eine falsche Layer-ID bliebe sonst als stumm leeres Overlay
 * unbemerkt. Die Layer-IDs sind unverifiziert (siehe config.js), deshalb ist
 * diese Prüfung die eigentliche Abnahme des Gerätetests.
 *
 * Ein Fehlschlag heisst „an dieser Stelle keine Kachel" — meist eine falsche ID
 * oder Zeitdimension, seltener eine Lücke in der Abdeckung.
 *
 * Vorbehalt: die Prüfung läuft über `fetch` und damit über CORS. Ein abgelehnter
 * Cross-Origin-Zugriff sieht hier aus wie ein fehlender Layer, obwohl die ID
 * stimmen kann. Der Meldungstext sagt das, damit der Gerätetest nicht die
 * falsche Ursache verfolgt.
 *
 * @param {(id: string, reason: string) => void} onUnavailable
 * @returns {Promise<void>}
 */
export async function probeOverlayLayers(onUnavailable) {
    const {z, x, y} = PROBE_TILE;
    await Promise.all(OVERLAYS.map(async (overlay) => {
        const url = tileUrl(overlay)
            .replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y))
            .replace('{bbox-epsg-3857}', tileBbox(PROBE_TILE));
        try {
            const response = await fetch(url, {method: 'GET', cache: 'no-store'});
            if (!response.ok) onUnavailable(overlay.id, `HTTP ${response.status}`);
        } catch (error) {
            // Ein abgewiesener fetch trennt Netzfehler und fehlende CORS-Freigabe
            // nicht — beides kommt als TypeError ohne Detail. Der Layer kann in
            // diesem Fall trotzdem tragen, deshalb die andere Wortwahl als beim
            // HTTP-Fehler.
            onUnavailable(overlay.id, `Netz-/CORS-Fehler: ${error?.message ?? 'kein Detail'}`);
        }
    }));
}

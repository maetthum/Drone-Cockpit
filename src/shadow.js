/**
 * Geländeschatten im Manuell-Modus: eigenes Raycasting über dem Terrain
 * (siehe `buildShadowGrid` in terrain-worker.js), Sonnenstand über `suncalc`.
 *
 * Kein swissALTI3D-Import und keine `mapbox-gl-shadow-simulator`-Bibliothek —
 * die ist `"license": "UNLICENSED"` und hätte in diesem öffentlichen Repo kein
 * Nutzungsrecht (siehe SHADOW in config.js für die ganze Herleitung).
 */
import {getPosition} from '../vendor/suncalc/index.js';
import {SHADOW} from './config.js';

const SOURCE_ID = 'shadow';

/** MapLibres `image`-Source erwartet die Ecken oben-links im Uhrzeigersinn. */
function boundsToCoordinates({west, south, east, north}) {
    return [[west, north], [east, north], [east, south], [west, south]];
}

/**
 * ImageBitmap zu einer `data:`-URL — die `image`-Source-Spezifikation nimmt
 * kein Bitmap direkt an, nur eine URL oder ein bereits geladenes Element.
 */
async function bitmapToDataUrl(bitmap) {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    const blob = await canvas.convertToBlob({type: 'image/png'});
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
    });
}

/**
 * @param {import('maplibre-gl').Map} map
 * @param {Function|null} computeShadow aus `createMap()` — `null`, wenn das
 *        Terrain nicht geladen werden konnte. Dann bleibt dieses Modul inert.
 */
export function createShadow(map, computeShadow) {
    let enabled = false;
    let date = new Date();
    let debounceTimer = null;
    /** Laufende Nummer je Anfrage, damit eine überholte Antwort verworfen wird. */
    let requestCounter = 0;
    let latestAppliedId = -1;
    /** Zuletzt angewendete Bild-URL — reiner Diagnose-/Testzugang, siehe unten. */
    let lastImageUrl = null;
    /** Laufende Berechnung — reiner Diagnose-/Testzugang, siehe `waitForIdle`. */
    let recomputePromise = Promise.resolve();

    function removeLayer() {
        if (map.getLayer(SOURCE_ID)) map.removeLayer(SOURCE_ID);
        if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
    }

    async function recompute() {
        if (!enabled || !computeShadow) return;
        const id = ++requestCounter;
        const {lng, lat} = map.getCenter();
        // suncalc liefert Azimut bereits nordbasiert im Uhrzeigersinn (0 = N,
        // 90 = O, 180 = S, 270 = W) — dieselbe Konvention wie Kompass und Kurs
        // im übrigen Cockpit, keine Umrechnung nötig.
        const sun = getPosition(date, lat, lng);

        let result;
        try {
            result = await computeShadow({
                center: {lng, lat},
                sunAzimuthDeg: sun.azimuth,
                sunAltitudeDeg: sun.altitude,
                gridZoom: SHADOW.gridZoom,
                gridRadiusTiles: SHADOW.gridRadiusTiles,
                outputRadiusTiles: SHADOW.outputRadiusTiles,
                rayStepPixels: SHADOW.rayStepPixels,
                opacityByte: Math.round(SHADOW.opacity * 255)
            });
        } catch {
            // Netz-/Worker-Fehler: die zuletzt gezeigte Fläche bleibt stehen,
            // statt mit einem Fehlerbanner den Fahrbetrieb zu stören.
            return;
        }
        // Zwischenzeitlich ist eine neuere Anfrage unterwegs, oder der Schatten
        // wurde inzwischen wieder ausgeschaltet — dieses Ergebnis verwerfen.
        if (id <= latestAppliedId || !enabled) return;
        latestAppliedId = id;

        const url = await bitmapToDataUrl(result.bitmap);
        if (!enabled) return; // Ausgeschaltet, während die Kodierung lief.
        lastImageUrl = url;
        const coordinates = boundsToCoordinates(result.bounds);
        const source = map.getSource(SOURCE_ID);
        if (source) {
            source.updateImage({url});
            source.setCoordinates(coordinates);
        } else {
            map.addSource(SOURCE_ID, {type: 'image', url, coordinates});
            map.addLayer({id: SOURCE_ID, type: 'raster', source: SOURCE_ID, paint: {'raster-opacity': 1}});
        }
    }

    /** Startet die Berechnung und hält die Zusage für `waitForIdle` fest. */
    function triggerRecompute() {
        recomputePromise = recompute();
    }

    function scheduleRecompute() {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(triggerRecompute, SHADOW.debounceMs);
    }

    // Nur relevant, solange eingeschaltet — sonst liefe bei jeder
    // Kartenbewegung im Tracking-Modus unnötig eine Anfrage mit.
    map.on('moveend', () => { if (enabled) scheduleRecompute(); });

    return {
        get isEnabled() {
            return enabled;
        },
        /** Verfügbar nur, wenn das Terrain geladen werden konnte. */
        get isAvailable() {
            return !!computeShadow;
        },
        /** Diagnose-/Testzugang: die zuletzt angewendete Bild-URL, oder `null`. */
        get lastImageUrl() {
            return lastImageUrl;
        },
        /** Diagnose-/Testzugang: wartet, bis eine laufende Berechnung angewendet ist. */
        async waitForIdle() {
            await recomputePromise;
        },
        setEnabled(value) {
            enabled = value && !!computeShadow;
            clearTimeout(debounceTimer);
            if (!enabled) {
                removeLayer();
                return;
            }
            triggerRecompute();
        },
        setDate(value) {
            date = value;
            if (enabled) scheduleRecompute();
        }
    };
}

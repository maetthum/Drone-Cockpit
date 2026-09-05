/**
 * Niederschlagsradar als Raster über der Karte.
 *
 * Ein eigenes Modul und nicht Teil von `overlays.js`, weil dieser Layer als
 * einziger **zeitabhängig** ist: der Kachelpfad enthält einen Zeitstempel und
 * wechselt im Zehnminutentakt. Die übrigen Overlays zeigen auf feste Endpunkte
 * und brauchen nie eine neue URL.
 *
 * Herkunft und Attributionspflicht stehen bei `RADAR` in config.js.
 */
import {RADAR} from './config.js';

const SOURCE_ID = 'radar';

/**
 * Neuesten Zeitpunkt holen. Liefert `null`, wenn der Dienst nicht antwortet —
 * ein fehlendes Radarbild ist kein Grund, irgendetwas anderes anzuhalten.
 */
async function fetchLatestTiles() {
    try {
        const response = await fetch(RADAR.indexUrl, {cache: 'no-store'});
        if (!response.ok) return null;
        const index = await response.json();
        const letzter = index?.radar?.past?.at(-1);
        if (!letzter?.path || !index.host) return null;
        return {
            url: RADAR.tileTemplate.replace('{host}', index.host).replace('{pfad}', letzter.path),
            zeit: letzter.time
        };
    } catch {
        return null;
    }
}

/**
 * @param {import('maplibre-gl').Map} map
 * @returns {{setVisible: (on: boolean) => void, isVisible: () => boolean,
 *            lastUpdate: () => number|null}}
 */
export function createRadar(map) {
    let sichtbar = RADAR.enabled;
    let letzteZeit = null;
    let takt = null;

    /**
     * Kacheln auf den neuesten Zeitpunkt setzen. Beim ersten Mal wird die
     * Source angelegt, danach nur noch die URL ausgetauscht — `setTiles()`
     * verwirft die alten Kacheln und lädt neu, ohne den Layer neu aufzubauen.
     */
    async function aktualisieren() {
        const neu = await fetchLatestTiles();
        if (!neu || neu.zeit === letzteZeit) return;
        letzteZeit = neu.zeit;

        const quelle = map.getSource(SOURCE_ID);
        if (quelle) {
            quelle.setTiles([neu.url]);
            return;
        }
        map.addSource(SOURCE_ID, {
            type: 'raster',
            tiles: [neu.url],
            tileSize: RADAR.tileSize,
            maxzoom: RADAR.maxzoom,
            // Bedingung der freien Nutzung. An der Source und nicht im festen
            // Hinweis, damit MapLibre sie genau dann zeigt, wenn der Layer
            // sichtbar ist — bei ausgeschaltetem Radar wird nichts behauptet.
            attribution: RADAR.attribution
        });
        map.addLayer({
            id: SOURCE_ID,
            type: 'raster',
            source: SOURCE_ID,
            layout: {visibility: sichtbar ? 'visible' : 'none'},
            paint: {'raster-opacity': RADAR.opacity}
        });
    }

    function taktSetzen() {
        clearInterval(takt);
        takt = null;
        // Nur nachladen, solange der Layer auch zu sehen ist: ein unsichtbarer
        // Radar muss den Dienst nicht alle zehn Minuten befragen.
        if (!sichtbar) return;
        takt = setInterval(aktualisieren, RADAR.refreshMs);
    }

    if (sichtbar) {
        aktualisieren();
        taktSetzen();
    }

    return {
        setVisible(on) {
            sichtbar = on;
            if (on && !map.getSource(SOURCE_ID)) {
                // Beim ersten Einschalten gibt es die Source noch nicht.
                aktualisieren();
            } else if (map.getLayer(SOURCE_ID)) {
                map.setLayoutProperty(SOURCE_ID, 'visibility', on ? 'visible' : 'none');
            }
            taktSetzen();
        },

        isVisible() {
            return sichtbar;
        },

        /** Zeitpunkt des angezeigten Bildes (Sekunden seit 1970), für das HUD. */
        lastUpdate() {
            return letzteZeit;
        }
    };
}

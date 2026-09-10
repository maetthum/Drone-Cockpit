/**
 * Kacheln vorladen, die als Nächstes gebraucht werden.
 *
 * Beim Fahren kommt der Ausschnitt immer von vorn ins Bild: was gleich sichtbar
 * wird, steht Sekunden vorher fest. Diese Kacheln werden deshalb schon geholt,
 * während man noch hinfährt; über den Service-Worker landen sie im
 * Kachelspeicher, und wenn MapLibre sie später anfordert, liegen sie da.
 *
 * Bewusst an MapLibre vorbei, per blossem `fetch`: dessen Kachelverwaltung lädt
 * nur, was im Bild ist, und ein künstlich vergrösserter Ausschnitt würde die
 * Kacheln auch zeichnen — samt Terrain-Resampling für Gelände, das noch
 * niemand sieht. Ein `fetch` füllt den Speicher, ohne die Darstellung zu
 * belasten.
 *
 * Ohne Service-Worker (LAN-Adresse ohne HTTPS) landen die Antworten immerhin
 * noch im HTTP-Cache des Browsers — dann wirkt es schwächer, aber nie falsch.
 */
import {BASEMAP, OVERLAYS, PREFETCH, WMS, WMTS} from './config.js';
import {tileBbox} from './overlays.js';

/** Web-Mercator-Kachel, in der ein Punkt liegt. */
function tileAt(lng, lat, z) {
    const n = 2 ** z;
    const rad = (lat * Math.PI) / 180;
    return {
        x: Math.floor(((lng + 180) / 360) * n),
        y: Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n)
    };
}

/** Punkt `meters` weit in Richtung `bearing` (Grad, 0 = Nord). */
function pointAhead(lng, lat, bearing, meters) {
    const rad = (bearing * Math.PI) / 180;
    return {
        lng: lng + (meters * Math.sin(rad)) / (111320 * Math.cos((lat * Math.PI) / 180)),
        lat: lat + (meters * Math.cos(rad)) / 110540
    };
}

/** Grobe Distanz in Metern — dieselbe Näherung wie in follow.js. */
function distanceMeters(a, b) {
    const dx = (a.lng - b.lng) * 111320 * Math.cos((a.lat * Math.PI) / 180);
    const dy = (a.lat - b.lat) * 110540;
    return Math.hypot(dx, dy);
}

/**
 * @param {import('maplibre-gl').Map} map
 * @param {{isVisible: (id: string) => boolean}} overlays
 * @returns {{update: (state: {lng: number, lat: number, heading: number|null}) => void}}
 */
export function createPrefetch(map, overlays) {
    /** Schon geholte URLs — dieselbe Kachel nicht zweimal anfordern. */
    const fetched = new Set();
    let lastRunAt = 0;
    let lastRunFrom = null;

    /** Die gerade sichtbaren Quellen mit ihrer jeweiligen Zoom-Obergrenze. */
    function activeSources() {
        const sources = [{template: BASEMAP.tiles[0], maxzoom: BASEMAP.maxzoom}];
        OVERLAYS.forEach((overlay) => {
            if (!overlays.isVisible(overlay.id)) return;
            const service = overlay.service === 'wms' ? WMS : WMTS;
            sources.push({
                template: service.urlTemplate.replace('{layer}', overlay.layer),
                // Dieselbe Grenze wie beim Anlegen der Source — sonst landet
                // eine Kachel im Speicher, die MapLibre nie anfordert.
                maxzoom: overlay.maxzoom ?? service.maxzoom
            });
        });
        return sources;
    }

    /**
     * Kachel-URLs für den 3×3-Block um einen Punkt, je Quelle auf deren
     * Zoom-Obergrenze gedeckelt — genau wie MapLibre sie später anfordern wird,
     * sonst läge eine andere Kachel im Speicher als die gebrauchte.
     */
    function urlsAround({lng, lat}, zoom, ring) {
        const urls = [];
        activeSources().forEach(({template, maxzoom}) => {
            const z = Math.max(0, Math.min(Math.round(zoom), maxzoom));
            const {x, y} = tileAt(lng, lat, z);
            const span = 2 ** z;
            for (let dx = -ring; dx <= ring; dx++) {
                for (let dy = -ring; dy <= ring; dy++) {
                    const tx = x + dx;
                    const ty = y + dy;
                    if (tx < 0 || ty < 0 || tx >= span || ty >= span) continue;
                    urls.push(template
                        .replace('{z}', String(z))
                        .replace('{x}', String(tx))
                        .replace('{y}', String(ty))
                        .replace('{bbox-epsg-3857}', tileBbox({z, x: tx, y: ty})));
                }
            }
        });
        return urls;
    }

    return {
        /**
         * Aus dem Fix-Takt aufgerufen. Bremst sich selbst nach Zeit und
         * Strecke: im Stand bringt Vorladen nichts, und ohne Fahrtrichtung
         * wüsste es ohnehin nicht, wohin.
         */
        update({lng, lat, heading}) {
            // Kein Vorladen, wenn der Nutzer Daten sparen will oder das Gerät
            // sich als offline meldet.
            if (navigator.connection?.saveData || navigator.onLine === false) return;

            const now = performance.now();
            if (now - lastRunAt < PREFETCH.minIntervalMs) return;
            const here = {lng, lat};
            if (lastRunFrom && distanceMeters(here, lastRunFrom) < PREFETCH.minDistanceMeters) return;
            lastRunAt = now;
            lastRunFrom = here;

            // Merkliste beschneiden, bevor sie unbegrenzt wächst. Ältestes
            // zuerst: ein Set liefert in Einfügereihenfolge.
            if (fetched.size > PREFETCH.memory) {
                [...fetched].slice(0, fetched.size - PREFETCH.memory).forEach((url) => fetched.delete(url));
            }

            /*
             * Die Stufen der Reihe nach durchgehen — die Reihenfolge trägt die
             * Priorität bis in die Abfolge der Netzanfragen: erst der eigene
             * Standort, dann Blickrichtung nah, dann fern.
             */
            const zoom = map.getZoom();
            const kandidaten = [];
            PREFETCH.stufen.forEach((stufe) => {
                // Alles ausser dem Ring um den Standort braucht eine Richtung.
                // Im Stand ohne Kurs bleibt es beim Nahbereich — vorwärts
                // laden, ohne zu wissen wohin, träfe die falschen Kacheln.
                const brauchtKurs = stufe.aheadMeters > 0;
                if (brauchtKurs && (heading === null || heading === undefined)) return;
                const ziel = brauchtKurs ? pointAhead(lng, lat, heading, stufe.aheadMeters) : here;
                // Kontingent je Stufe: sonst schöpft der Nahbereich den
                // Gesamtdeckel aus und die Ferne kommt nie an die Reihe.
                kandidaten.push(...urlsAround(ziel, zoom - stufe.zoomAbschlag, stufe.ring)
                    .filter((url) => !fetched.has(url))
                    .slice(0, stufe.deckel));
            });

            // Reihenfolge erhalten, Doppelte zwischen den Stufen entfernen.
            const wanted = [...new Set(kandidaten)]
                .filter((url) => !fetched.has(url))
                .slice(0, PREFETCH.maxTilesPerRun);

            wanted.forEach((url) => {
                fetched.add(url);
                // `priority: 'low'` hält das Vorladen hinter den Kacheln, die
                // gerade gezeichnet werden sollen. Browser ohne diese Option
                // ignorieren sie.
                // Fehlschläge sind ohne Belang: die Kachel wird dann eben
                // später auf dem normalen Weg geholt.
                fetch(url, {priority: 'low'}).catch(() => fetched.delete(url));
            });
        }
    };
}

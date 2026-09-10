/**
 * Eigene Position auf der Karte: blauer Richtungspfeil.
 *
 * **Als DOM-Marker, nicht als Symbolebene.** Bis zum 7.9.2026 war das ein
 * `symbol`-Layer auf einer GeoJSON-Quelle. Seit die optische Mitte über
 * `padding` nach unten geschoben wird (siehe `setzePadding` in follow.js),
 * zeichnet MapLibre solche Symbole nicht mehr sichtbar: `queryRenderedFeatures`
 * meldet sie zwar, im Bild fehlen sie. Dasselbe Muster wie beim Himmel — das
 * `padding` geht in die Darstellung nicht ein.
 *
 * Ein `Marker` ist ein DOM-Element, das MapLibre über `project()` setzt, und
 * `project()` rechnet das `padding` korrekt mit. Der Pfeil bleibt damit an der
 * echten Koordinate und erscheint zuverlässig.
 */
import {ME} from './config.js';

/** Für Tests: die Kennung des Elements, das den eigenen Standort zeigt. */
export const ME_ELEMENT_ID = 'me-marker';

/**
 * Pfeil als SVG. Bewusst gezeichnet statt geladen: eine Bilddatei wäre eine
 * weitere Anfrage und ein weiterer Pfad, der beim Ausliefern stimmen muss.
 */
function pfeilElement() {
    const el = document.createElement('div');
    el.id = ME_ELEMENT_ID;
    el.style.willChange = 'transform';
    el.innerHTML = `<svg viewBox="0 0 40 40" width="${Math.round(32 * ME.arrowScale)}"
         height="${Math.round(32 * ME.arrowScale)}" aria-hidden="true" focusable="false">
      <path d="M20 3 L33 31 L20 24 L7 31 Z" fill="${ME.color}" stroke="#ffffff"
            stroke-width="2.4" stroke-linejoin="round"/>
    </svg>`;
    return el;
}

/**
 * @param {import('maplibre-gl').Map} map
 * @param {typeof import('../vendor/maplibre-gl/maplibre-gl.mjs')} maplibregl
 * @returns {{update: (state: {lng: number, lat: number, heading: number|null}|null) => void,
 *            hasPosition: () => boolean, position: () => [number, number]|null}}
 */
export function createMe(map, maplibregl) {
    const element = pfeilElement();
    /*
     * `pitchAlignment: 'viewport'` hält den Pfeil aufrecht im Bild — flach auf
     * das Gelände gelegt läge er bei Neigung 80° fast in der Blickachse und
     * wäre nur noch ein Strich. `rotationAlignment: 'map'` dreht ihn mit der
     * Karte, sodass er die Fahrtrichtung im Gelände zeigt; im Tracking steht
     * die Karte in Fahrtrichtung und der Pfeil damit senkrecht nach oben.
     */
    const marker = new maplibregl.Marker({
        element,
        pitchAlignment: 'viewport',
        rotationAlignment: 'map'
    });

    let current = null;
    let angehaengt = false;

    return {
        update(state) {
            if (!state) return;
            current = [state.lng, state.lat];
            marker.setLngLat(current);
            // Ohne bekannte Richtung nicht drehen — jede gezeichnete wäre
            // gelogen. Der Pfeil zeigt dann nach Norden.
            marker.setRotation(state.heading ?? 0);
            if (!angehaengt) {
                marker.addTo(map);
                angehaengt = true;
            }
        },
        hasPosition() {
            return current !== null;
        },
        position() {
            return current;
        }
    };
}

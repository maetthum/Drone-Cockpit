/**
 * Eigene Position auf der Karte: blauer Punkt mit Richtungspfeil.
 *
 * Im Tracking-Modus liegt der Punkt naturgemäss in der Bildmitte — dort zeigt
 * er vor allem, ob überhaupt ein Fix da ist und wohin die Nase zeigt. Sein
 * eigentlicher Wert liegt im Manuell-Modus: dort schaut man anderswo hin und
 * will trotzdem sehen, wo man selbst steht.
 */
import {ME} from './config.js';

const SOURCE_ID = 'me';
export const ME_LAYER_IDS = ['me-arrow', 'me-dot'];

/**
 * Richtungspfeil als Bild im Speicher erzeugen.
 *
 * Bewusst gezeichnet statt geladen: eine Bilddatei wäre eine weitere
 * Anfrage und ein weiterer Pfad, der beim Ausliefern stimmen muss. Icons
 * brauchen — anders als Text — keine Glyphen-Quelle.
 */
function arrowImage(size) {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const g = canvas.getContext('2d');
    const c = size / 2;
    g.beginPath();
    g.moveTo(c, size * 0.06);                 // Spitze
    g.lineTo(size * 0.82, size * 0.72);
    g.lineTo(c, size * 0.56);                 // Kerbe
    g.lineTo(size * 0.18, size * 0.72);
    g.closePath();
    g.fillStyle = ME.color;
    g.strokeStyle = '#ffffff';
    g.lineWidth = size * 0.05;
    g.fill();
    g.stroke();
    return g.getImageData(0, 0, size, size);
}

/**
 * @param {import('maplibre-gl').Map} map
 * @returns {{update: (state: {lng: number, lat: number, heading: number|null}|null) => void,
 *            hasPosition: () => boolean, position: () => [number, number]|null}}
 */
export function createMe(map) {
    map.addImage('me-arrow-icon', arrowImage(ME.iconSize), {pixelRatio: 2});
    map.addSource(SOURCE_ID, {type: 'geojson', data: {type: 'FeatureCollection', features: []}});

    /*
     * Der Pfeil **ist** der Standortmarker, nicht mehr eine Beigabe zum Punkt.
     * Im Cockpit zählt die Blickrichtung mindestens so viel wie der Ort, und
     * zwei Zeichen übereinander lasen sich schlechter als eines.
     *
     * Der Punkt bleibt als Rückfall für den Fall, dass kein Kurs bekannt ist —
     * dann wäre jede gezeichnete Richtung gelogen (siehe unten).
     */
    map.addLayer({
        id: ME_LAYER_IDS[0],
        type: 'symbol',
        source: SOURCE_ID,
        filter: ['has', 'heading'],
        layout: {
            'icon-image': 'me-arrow-icon',
            'icon-size': ME.arrowScale,
            'icon-rotate': ['get', 'heading'],
            // An der Karte ausgerichtet, nicht am Bildschirm — sonst zeigte der
            // Pfeil bei gedrehter Karte in die falsche Richtung.
            /*
             * **Beides `viewport`, und das gehört zusammen.**
             *
             * `icon-pitch-alignment: 'viewport'` stellt den Pfeil aufrecht —
             * flach auf das Gelände gelegt läge er bei Neigung 80° fast in der
             * Blickachse und wäre nur noch ein schmaler Strich.
             *
             * Die Drehung muss dann **ebenfalls** bildschirmbezogen sein. Mit
             * `'map'` rotiert das Symbol in der Kartenebene, und bei geneigter
             * Karte erscheint genau das als seitliches Kippen — der Pfeil legte
             * sich nach links und rechts. Die Kartenrotation wird stattdessen
             * beim Setzen der Daten herausgerechnet (siehe `update`).
             */
            'icon-rotation-alignment': 'viewport',
            'icon-pitch-alignment': 'viewport',
            'icon-allow-overlap': true,
            'icon-ignore-placement': true
        }
    });
    map.addLayer({
        id: ME_LAYER_IDS[1],
        type: 'circle',
        source: SOURCE_ID,
        // Nur, solange keine Richtung bekannt ist: sonst läge der Punkt unter
        // dem Pfeil und machte ihn bloss unruhig.
        filter: ['!', ['has', 'heading']],
        paint: {
            'circle-radius': ME.dotRadius,
            'circle-color': ME.color,
            'circle-stroke-width': 2,
            'circle-stroke-color': '#ffffff'
        }
    });

    let current = null;
    /** Letzter Zustand, um beim Drehen der Karte neu zeichnen zu können. */
    let letzterZustand = null;

    function zeichne(state) {
        if (!state) return;
        letzterZustand = state;
        current = [state.lng, state.lat];
        /*
         * Die Kartenrotation herausrechnen: das Symbol steht aufrecht im Bild
         * (`icon-rotation-alignment: 'viewport'`), seine Drehung ist also
         * bildschirmbezogen. Im Tracking zeigt die Karte in Fahrtrichtung —
         * die Differenz ist dann null und der Pfeil steht senkrecht nach oben,
         * ohne seitliche Neigung.
         */
        const imBild = state.heading === null || state.heading === undefined
            ? null
            : (((state.heading - map.getBearing()) % 360) + 360) % 360;
        map.getSource(SOURCE_ID)?.setData({
            type: 'FeatureCollection',
            features: [{
                type: 'Feature',
                // `heading` nur setzen, wenn bekannt — der Filter blendet
                // den Pfeil sonst aus, statt nach Norden zu zeigen.
                properties: imBild === null ? {} : {heading: imBild},
                geometry: {type: 'Point', coordinates: current}
            }]
        });
    }

    // Dreht der Nutzer die Karte (Manuell-Modus), steht der Frame-Loop still —
    // ohne das hier bliebe der Pfeil auf der alten Bildrichtung stehen.
    map.on('rotate', () => zeichne(letzterZustand));

    return {
        update(state) {
            zeichne(state);
        },
        hasPosition() {
            return current !== null;
        },
        position() {
            return current;
        }
    };
}

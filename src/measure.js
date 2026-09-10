/**
 * Luftlinienmessung.
 *
 * Rechtsklick (Desktop) öffnet ein kleines Menü an der Klickposition statt
 * sofort einen Punkt zu setzen: das erlaubt beliebig viele Punkte, nicht nur
 * zwei, und braucht kein Umschalten zwischen Modi.
 *
 * **Long-Press auf Touch läuft über eine eigene Erkennung, nicht über das
 * `contextmenu`-Ereignis.** iOS Safari feuert `contextmenu` zuverlässig nur
 * bei Links, Bildern und Text — bei einem blossen `<canvas>` (die Karte) im
 * Praxistest gar nicht. Deshalb `touchstart`/`touchmove`/`touchend` selbst
 * auswerten: hält ein einzelner Finger `LONG_PRESS_MS` still, gilt das als
 * Long-Press. Läuft neben MapLibres eigenen Touch-Handlern (Verschieben,
 * Kneifen) her, ohne sie zu stören — es wird nirgends `stopPropagation()`
 * aufgerufen, nur bei echter Bewegung bricht der eigene Timer ab.
 *
 * Eigenes `contextmenu`/Long-Press, nicht `click`: der Einzeltap ist bereits
 * an die Sachdaten-Abfrage vergeben (siehe info.js) — beide Gesten laufen so
 * ohne Modus-Umschaltung nebeneinander her.
 */
import {MEASURE} from './config.js';

const SOURCE_ID = 'measure';
const LINE_LAYER_ID = 'measure-line';
const POINT_LAYER_ID = 'measure-points';

const EARTH_RADIUS_M = 6371000;
const LONG_PRESS_MS = 550;
/** Bewegungstoleranz in Pixeln, bevor ein Long-Press als Verschieben gilt. */
const LONG_PRESS_TOLERANCE_PX = 10;

/** Grosskreisdistanz zweier Punkte in Metern (Haversine). */
function distance([lng1, lat1], [lng2, lat2]) {
    const toRad = (deg) => (deg * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2
        + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

function formatDistance(meters) {
    return meters >= 1000 ? `${(meters / 1000).toFixed(2)} km` : `${Math.round(meters)} m`;
}

/** `null`, wenn an einem der beiden Punkte keine Geländehöhe vorliegt. */
function formatElevation(a, b) {
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    const diff = Math.round(b - a);
    if (diff === 0) return '±0 Hm';
    return `${diff > 0 ? '+' : ''}${diff} Hm`;
}

function midpoint([lng1, lat1], [lng2, lat2]) {
    return [(lng1 + lng2) / 2, (lat1 + lat2) / 2];
}

/**
 * @param {import('maplibre-gl').Map} map
 * @param {typeof import('../vendor/maplibre-gl/maplibre-gl.mjs')} maplibregl
 * @param {{menu: HTMLElement, panel: HTMLElement, text: HTMLElement, clear: HTMLElement}} els
 */
export function createMeasure(map, maplibregl, els) {
    /** @type {Array<[number, number]>} */
    let points = [];
    /** Geländehöhe je Punkt (Meter), parallel zu `points`; `NaN` ohne Gelände an der Stelle. */
    let elevations = [];
    /**
     * Distanz-Beschriftung je Streckenabschnitt, direkt auf der Karte.
     *
     * Als DOM-Marker wie der eigene Standort (siehe me.js), nicht als
     * `symbol`-Layer: seit die optische Mitte über `padding` verschoben wird,
     * zeichnet MapLibre Symbol-Layer dort nicht mehr sichtbar. `Marker`
     * rechnet das `padding` über `project()` korrekt mit.
     */
    let labelMarkers = [];

    /**
     * Der Strich braucht mindestens zwei Koordinaten — bei nur einem Punkt
     * bliebe sonst eine ungültige `LineString` stehen.
     */
    function data() {
        const features = points.map((coord) => ({type: 'Feature', geometry: {type: 'Point', coordinates: coord}}));
        if (points.length >= 2) {
            features.push({type: 'Feature', geometry: {type: 'LineString', coordinates: points}});
        }
        return {type: 'FeatureCollection', features};
    }

    map.addSource(SOURCE_ID, {type: 'geojson', data: data()});
    map.addLayer({
        id: LINE_LAYER_ID,
        type: 'line',
        source: SOURCE_ID,
        filter: ['==', ['geometry-type'], 'LineString'],
        paint: {'line-color': MEASURE.color, 'line-width': MEASURE.lineWidth, 'line-dasharray': [2, 2]}
    });
    map.addLayer({
        id: POINT_LAYER_ID,
        type: 'circle',
        source: SOURCE_ID,
        filter: ['==', ['geometry-type'], 'Point'],
        paint: {
            'circle-radius': MEASURE.dotRadius,
            'circle-color': MEASURE.color,
            'circle-stroke-width': 2,
            'circle-stroke-color': '#ffffff'
        }
    });

    function panelText() {
        if (points.length === 0) return null;
        if (points.length === 1) return 'Startpunkt gesetzt — weiteren Punkt wählen';
        let total = 0;
        for (let i = 1; i < points.length; i++) total += distance(points[i - 1], points[i]);
        return `${formatDistance(total)} Luftlinie · ${points.length} Punkte`;
    }

    /** Je Streckenabschnitt eine Beschriftung an dessen Mittelpunkt. */
    function updateLabels() {
        while (labelMarkers.length > points.length - 1) labelMarkers.pop().remove();
        for (let i = 1; i < points.length; i++) {
            const hoehe = formatElevation(elevations[i - 1], elevations[i]);
            const text = hoehe === null
                ? formatDistance(distance(points[i - 1], points[i]))
                : `${formatDistance(distance(points[i - 1], points[i]))} · ${hoehe}`;
            let marker = labelMarkers[i - 1];
            if (!marker) {
                const element = document.createElement('div');
                element.className = 'measure-label';
                marker = new maplibregl.Marker({element, pitchAlignment: 'viewport', rotationAlignment: 'viewport'});
                // Position vor dem Anhängen setzen — sonst projiziert
                // MapLibre beim Anhängen eine noch fehlende Koordinate.
                marker.setLngLat(midpoint(points[i - 1], points[i]));
                marker.addTo(map);
                labelMarkers[i - 1] = marker;
            }
            marker.getElement().textContent = text;
            marker.setLngLat(midpoint(points[i - 1], points[i]));
        }
    }

    function render() {
        map.getSource(SOURCE_ID).setData(data());
        updateLabels();
        const text = panelText();
        els.panel.hidden = text === null;
        if (text !== null) els.text.textContent = text;
    }

    function addPoint(lngLat) {
        points.push([lngLat.lng, lngLat.lat]);
        // Sofort abfragen, nicht erst bei der Beschriftung: das Gelände unter
        // dem Punkt ändert sich nicht mehr, der Wert soll aber feststehen,
        // auch wenn die Kamera später woanders hinsieht.
        elevations.push(map.queryTerrainElevation(lngLat));
        render();
    }

    function clear() {
        points = [];
        elevations = [];
        render();
    }

    function hideMenu() {
        els.menu.hidden = true;
        document.removeEventListener('pointerdown', onOutside, true);
        document.removeEventListener('keydown', onEscape, true);
    }

    function onOutside(event) {
        if (!els.menu.contains(event.target)) hideMenu();
    }

    function onEscape(event) {
        if (event.key === 'Escape') hideMenu();
    }

    function menuButton(label, action) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.addEventListener('click', () => {
            action();
            hideMenu();
        });
        return button;
    }

    function showMenu(x, y, lngLat) {
        const buttons = [menuButton('Punkt setzen', () => addPoint(lngLat))];
        if (points.length > 0) buttons.push(menuButton('Messung löschen', clear));
        els.menu.replaceChildren(...buttons);
        els.menu.style.left = `${x}px`;
        els.menu.style.top = `${y}px`;
        els.menu.hidden = false;
        // Innerhalb des Bildschirms halten — ein Long-Press nahe am Rand
        // würde das Menü sonst abgeschnitten anzeigen.
        const rect = els.menu.getBoundingClientRect();
        if (rect.right > window.innerWidth) els.menu.style.left = `${x - rect.width}px`;
        if (rect.bottom > window.innerHeight) els.menu.style.top = `${y - rect.height}px`;
        // Verzögert registriert, sonst schliesst derselbe Tap, der das Menü
        // öffnet, es im selben Zug wieder (der `contextmenu`-Tap trifft den
        // `document`-Listener sonst noch in seiner eigenen Bubble-Phase).
        setTimeout(() => {
            document.addEventListener('pointerdown', onOutside, true);
            document.addEventListener('keydown', onEscape, true);
        }, 0);
    }

    map.on('contextmenu', (event) => showMenu(event.point.x, event.point.y, event.lngLat));

    /*
     * Long-Press auf Touch — eigene Erkennung statt `contextmenu` (siehe
     * Kopfkommentar). Derselbe Container, auf dem auch MapLibres eigene
     * Touch-Handler (Verschieben, Kneifen) hören; ohne `stopPropagation`
     * oder `preventDefault` laufen beide nebeneinander her.
     */
    const container = map.getCanvasContainer();
    let pressTimer = null;
    let pressStart = null;

    function cancelPress() {
        clearTimeout(pressTimer);
        pressTimer = null;
        pressStart = null;
    }

    container.addEventListener('touchstart', (event) => {
        // Nur bei einem Finger — zwei sind Kneifen/Drehen, kein Long-Press.
        if (event.touches.length !== 1) {
            cancelPress();
            return;
        }
        const touch = event.touches[0];
        pressStart = {x: touch.clientX, y: touch.clientY};
        pressTimer = setTimeout(() => {
            const rect = container.getBoundingClientRect();
            const x = pressStart.x - rect.left;
            const y = pressStart.y - rect.top;
            const lngLat = map.unproject([x, y]);
            pressTimer = null;
            showMenu(x, y, lngLat);
        }, LONG_PRESS_MS);
    }, {passive: true});

    container.addEventListener('touchmove', (event) => {
        if (!pressStart) return;
        const touch = event.touches[0];
        const moved = Math.hypot(touch.clientX - pressStart.x, touch.clientY - pressStart.y);
        // Der Finger verschiebt statt zu halten — das ist Schieben, kein
        // Long-Press.
        if (moved > LONG_PRESS_TOLERANCE_PX) cancelPress();
    }, {passive: true});

    container.addEventListener('touchend', cancelPress, {passive: true});
    container.addEventListener('touchcancel', cancelPress, {passive: true});

    els.clear.addEventListener('click', clear);
}

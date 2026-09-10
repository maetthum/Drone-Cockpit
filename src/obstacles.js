/**
 * Luftfahrthindernisse als Vektor statt als Raster-Overlay.
 *
 * Grund: der WMS-Layer `ch.bazl.luftfahrthindernis` stempelt „Last update: …"
 * in *jedes* ausgelieferte Bild. Bei Kachelbetrieb heisst das ein roter
 * Schriftzug pro Kachel — am Gerät (3.9.2026) lag die halbe Karte voll. Der
 * Stempel steckt in der Serverdarstellung und lässt sich nicht abschalten;
 * grössere Kacheln verteilen ihn nur weiter.
 *
 * Der Vektorweg über den identify-Dienst liefert dieselben Objekte plus die
 * Höhe über Grund je Hindernis (`maxheightagl`) — genau die Zahl, um die es
 * beim Fliegen geht.
 */
import {OBSTACLES} from './config.js';

export const OBSTACLE_SOURCE_ID = `overlay-${OBSTACLES.id}`;
/** Punkte und Linien brauchen je einen Layer — Masten sind Punkte, Leitungen nicht. */
export const OBSTACLE_LAYER_IDS = [`${OBSTACLE_SOURCE_ID}-point`, `${OBSTACLE_SOURCE_ID}-line`];

const EMPTY = {type: 'FeatureCollection', features: []};

/** WGS84 → EPSG:3857, für die BBOX der Abfrage. */
function toMercator(lng, lat) {
    const R = 6378137;
    return [
        R * (lng * Math.PI) / 180,
        R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))
    ];
}

/** Grobe Distanz in Metern — reicht, um „hat sich die Kamera bewegt?" zu beantworten. */
function distanceMeters(a, b) {
    const dx = (a.lng - b.lng) * 111320 * Math.cos((a.lat * Math.PI) / 180);
    const dy = (a.lat - b.lat) * 110540;
    return Math.hypot(dx, dy);
}

/**
 * Einfärbung nach Höhe über Grund: je höher das Hindernis, desto kräftiger.
 * Ohne Beschriftung, weil Textlayer eine Glyphen-Quelle bräuchten — die wäre
 * eine zusätzliche externe Abhängigkeit für eine App, die ohne auskommt.
 */
const HEIGHT_COLOR = [
    'interpolate', ['linear'], ['coalesce', ['get', 'maxheightagl'], 0],
    0, '#ffd166', 40, '#f3722c', 100, '#d00000'
];

/**
 * @param {import('maplibre-gl').Map} map
 * @returns {{refresh: () => void, setVisible: (v: boolean) => void, isVisible: () => boolean}}
 */
export function createObstacles(map) {
    map.addSource(OBSTACLE_SOURCE_ID, {type: 'geojson', data: EMPTY});
    map.addLayer({
        id: OBSTACLE_LAYER_IDS[0],
        type: 'circle',
        source: OBSTACLE_SOURCE_ID,
        filter: ['==', ['geometry-type'], 'Point'],
        layout: {visibility: OBSTACLES.enabled ? 'visible' : 'none'},
        paint: {
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 3, 17, 9],
            'circle-color': HEIGHT_COLOR,
            'circle-opacity': 0.85,
            'circle-stroke-width': 1,
            'circle-stroke-color': '#1a0c00'
        }
    });
    map.addLayer({
        id: OBSTACLE_LAYER_IDS[1],
        type: 'line',
        source: OBSTACLE_SOURCE_ID,
        filter: ['!=', ['geometry-type'], 'Point'],
        layout: {visibility: OBSTACLES.enabled ? 'visible' : 'none', 'line-cap': 'round'},
        paint: {'line-color': HEIGHT_COLOR, 'line-width': 2.5, 'line-opacity': 0.9}
    });

    let lastFetchAt = 0;
    let lastCenter = null;
    let inFlight = false;

    async function load() {
        const bounds = map.getBounds();
        const [minX, minY] = toMercator(bounds.getWest(), bounds.getSouth());
        const [maxX, maxY] = toMercator(bounds.getEast(), bounds.getNorth());
        const bbox = `${minX},${minY},${maxX},${maxY}`;
        const url = `${OBSTACLES.identifyUrl}?geometryType=esriGeometryEnvelope&geometry=${bbox}`
            + `&mapExtent=${bbox}&imageDisplay=512,512,96&tolerance=0`
            + `&layers=all:${OBSTACLES.layer}&sr=3857&geometryFormat=geojson&returnGeometry=true`
            + `&limit=${OBSTACLES.limit}`;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await response.json();
        map.getSource(OBSTACLE_SOURCE_ID)?.setData({
            type: 'FeatureCollection',
            features: (body.results ?? []).filter((feature) => feature.geometry)
        });
    }

    return {
        /**
         * Nachladen, wenn es sich lohnt. Darf bedenkenlos bei jedem `moveend`
         * gerufen werden: der Frame-Loop feuert das im Folgen-Modus dauernd,
         * deshalb bremsen Zeit *und* zurückgelegte Strecke die Abfrage.
         */
        refresh() {
            if (!this.isVisible() || inFlight) return;
            if (map.getZoom() < OBSTACLES.minZoom) return;
            const now = performance.now();
            const center = map.getCenter();
            // Schwelle aus dem Kartenmassstab, nicht aus `getBounds()`: bei
            // Pitch 75–85° reicht der Sichtkeil bis zum Horizont und ist damit
            // ein Vielfaches der Bildbreite (gemessen 2,5 km statt 500 m) — die
            // Schwelle wäre so gross geworden, dass in Fahrt nie nachgeladen
            // wurde. Der Massstab in der Bildmitte trifft die Nahzone.
            // 2^(zoom+1): MapLibre rechnet Zoomstufen auf 512er-Kacheln.
            const metersPerPixel = 156543.03392804097
                * Math.cos((center.lat * Math.PI) / 180) / 2 ** (map.getZoom() + 1);
            const viewportMeters = metersPerPixel * map.getCanvas().clientWidth;
            const threshold = Math.min(OBSTACLES.maxRefreshDistanceMeters,
                Math.max(OBSTACLES.minRefreshDistanceMeters,
                    viewportMeters * OBSTACLES.refreshViewportFraction));
            const moved = lastCenter === null || distanceMeters(center, lastCenter) > threshold;
            if (!moved && now - lastFetchAt < OBSTACLES.idleRefreshMs) return;

            inFlight = true;
            lastFetchAt = now;
            lastCenter = center;
            load()
                .catch(() => {
                    // Ein Ausfall darf die Karte nicht anhalten: die alten
                    // Hindernisse bleiben stehen, der nächste Versuch kommt
                    // beim nächsten Kameraschwenk.
                    lastCenter = null;
                })
                .finally(() => {
                    inFlight = false;
                });
        },

        setVisible(visible) {
            OBSTACLE_LAYER_IDS.forEach((id) =>
                map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none'));
            if (visible) this.refresh();
        },

        isVisible() {
            return map.getLayoutProperty(OBSTACLE_LAYER_IDS[0], 'visibility') !== 'none';
        }
    };
}

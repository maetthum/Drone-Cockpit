/**
 * Karten-Aufbau. Kennt nur die Kartenschicht — keine Sensorik, kein UI-Text.
 */
import {BASEMAP, COVERAGE_BOUNDS, SKY, TERRAIN} from './config.js';
import {setUpTerrain} from './terrain.js';

const TERRAIN_SOURCE_ID = 'swisstopo-terrain';

/**
 * Erzeugt die Karte mit Basemap auf der übergebenen Startansicht. Das Terrain
 * wird nachgeladen: schlägt es fehl, bleibt eine flache, aber benutzbare Karte
 * stehen statt einer weissen Seite.
 *
 * @param {object} maplibregl geladenes maplibre-gl-Modul
 * @param {HTMLElement|string} container
 * @param {(state: 'basemap'|'terrain'|'terrain-failed', detail?: Error) => void} onStatus
 * @param {{center: [number, number], zoom: number, pitch: number, bearing: number}} view
 *        Startansicht — steht schon auf der eigenen Position, damit der erste
 *        Satz Kacheln der ist, den der Nutzer auch zu sehen bekommt
 *        (siehe START_VIEW in config.js).
 * @returns {Promise<import('maplibre-gl').Map>}
 */
export async function createMap(maplibregl, container, onStatus, view) {
    const map = new maplibregl.Map({
        container,
        style: {
            version: 8,
            sources: {
                [BASEMAP.id]: {
                    type: 'raster',
                    tiles: BASEMAP.tiles,
                    tileSize: BASEMAP.tileSize,
                    minzoom: BASEMAP.minzoom,
                    maxzoom: BASEMAP.maxzoom,
                    // Ausserhalb der Schweiz gibt es keine Luftbilder; ohne die
                    // Grenze fordert MapLibre sie trotzdem an und kassiert
                    // stumme 400er (siehe COVERAGE).
                    bounds: COVERAGE_BOUNDS,
                    attribution: BASEMAP.attribution
                }
            },
            layers: [
                // Die Farbe scheint überall dort durch, wo MapLibre nichts
                // zeichnet — vor allem jenseits der Renderdistanz, die bei
                // tiefer Kamera nur wenige Kilometer beträgt. Deshalb der
                // Horizontton des Himmels: dieser Bereich liegt optisch in der
                // Ferne und soll als Dunst durchgehen, nicht als Boden
                // (Graugrün) oder Loch (Schwarz).
                {id: 'background', type: 'background', paint: {'background-color': '#cddced'}},
                {id: BASEMAP.id, type: 'raster', source: BASEMAP.id}
            ]
        },
        ...view,
        maxPitch: 89,
        // Quellenhinweis: die Source-Attributions laufen in MapLibres
        // Attribution-Control zusammen, zusätzlich steht der fixe Hinweis
        // dauerhaft im HUD (siehe main.js).
        // Die Kamera wird ab Phase 2 vom Render-Loop gesetzt; Gesten bleiben für
        // die manuelle Kontrolle in Phase 1 aktiv.
        pitchWithRotate: true
    });

    await map.once('load');
    // Himmel erst nach `load`: vorher gibt es keinen Style, an dem er hängt.
    map.setSky(SKY);
    onStatus('basemap');

    try {
        const {sourceSpec} = await setUpTerrain(maplibregl);
        map.addSource(TERRAIN_SOURCE_ID, sourceSpec);
        map.setTerrain({source: TERRAIN_SOURCE_ID, exaggeration: TERRAIN.exaggeration});
        onStatus('terrain');
    } catch (error) {
        onStatus('terrain-failed', error);
    }

    return map;
}

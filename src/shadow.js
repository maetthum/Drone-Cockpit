/**
 * Geländeschatten im Manuell-Modus: Sonnenstand über `suncalc`, Verschattung
 * pro Bildpunkt im Fragment-Shader einer MapLibre-Custom-Layer — nicht mehr
 * per CPU-Raycasting im Worker (siehe SHADOW in config.js, 13.9.2026: am
 * Gerät hinkte die CPU-Fläche bei Kartenbewegung im Manuell-Modus spürbar
 * hinterher).
 *
 * `terrain.js#computeShadow()` (→ `terrain-worker.js`) liefert nur noch das
 * rohe Terrarium-Höhenraster plus ein grobes Stützpunktraster fürs
 * Gelände-Drape. Alles Sonnenstand-Abhängige (Azimut, Höhe, Nacht) bleibt
 * hier als Uniform und wird bei jedem `setDate()` sofort neu gesetzt, ohne
 * die Höhendaten neu zu laden — nur eine Kamerabewegung ausserhalb des
 * geladenen Rasters braucht ein Nachladen (debounced, wie bisher).
 *
 * Kein swissALTI3D-Import und keine `mapbox-gl-shadow-simulator`-Bibliothek —
 * die ist `"license": "UNLICENSED"` und hätte in diesem öffentlichen Repo kein
 * Nutzungsrecht (siehe SHADOW in config.js für die ganze Herleitung).
 */
import {getPosition} from '../vendor/suncalc/index.js';
import {SHADOW, TERRAIN} from './config.js';

const LAYER_ID = 'shadow';
const TILE_SIZE = 256;
/** Obergrenze der Shader-Schleife — muss zur Kompilierzeit feststehen (GLSL ES 1.00). */
const MAX_STEPS = 128;

const VERTEX_SRC = `
attribute vec3 a_pos;
attribute vec2 a_uv;
uniform mat4 u_matrix;
// modelViewProjectionMatrix erwartet MapLibres "World Space" (Mercator-Einheits-
// quadrat × worldSize = 512 · 2^zoom), nicht die rohen [0,1]-Koordinaten aus
// MercatorCoordinate — deshalb hier hochskaliert statt beim Bau des Netzes
// (worldSize ändert sich mit jedem Zoom-Schritt, das Netz nicht).
uniform float u_worldSize;
varying vec2 v_uv;
void main() {
    v_uv = a_uv;
    gl_Position = u_matrix * vec4(a_pos * u_worldSize, 1.0);
}
`;

const FRAGMENT_SRC = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_heights;
uniform float u_texelSize;
uniform float u_metersPerPixel;
uniform float u_rayStepPixels;
uniform float u_maxSteps;
uniform vec2 u_sunDir;
uniform float u_altitudeRad;
uniform float u_night;
uniform vec3 u_color;
uniform float u_opacity;

// Terrarium-Kodierung wie in terrain-worker.js: height = R*256 + G + B/256 - 32768.
// Hardware-bilineares Sampling auf den kodierten Bytes statt exaktem Bilinear
// auf dekodierten Metern — dieselbe Näherung, die MapLibre selbst für sein
// Hillshading auf raster-dem-Kacheln macht.
float decodeHeight(vec2 uv) {
    vec3 c = texture2D(u_heights, uv).rgb * 255.0;
    return c.r * 256.0 + c.g + c.b / 256.0 - 32768.0;
}

void main() {
    if (u_night > 0.5) {
        gl_FragColor = vec4(u_color, u_opacity);
        return;
    }
    float originHeight = decodeHeight(v_uv);
    vec2 step = u_sunDir * u_texelSize * u_rayStepPixels;
    bool shadowed = false;
    for (int i = 1; i <= ${MAX_STEPS}; i++) {
        if (float(i) > u_maxSteps) break;
        vec2 uv = v_uv + step * float(i);
        if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) break;
        float h = decodeHeight(uv);
        float dist = float(i) * u_rayStepPixels * u_metersPerPixel;
        // Sichtwinkel vom Ursprung zum abgetasteten Punkt, gegen die
        // Sonnenhöhe: darüber blockiert das Gelände dort die Sonne von hier aus.
        if (atan(h - originHeight, dist) > u_altitudeRad) {
            shadowed = true;
            break;
        }
    }
    if (!shadowed) discard;
    gl_FragColor = vec4(u_color, u_opacity);
}
`;

function compileShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const info = gl.getShaderInfoLog(shader);
        gl.deleteShader(shader);
        throw new Error(`Shadow-Shader liess sich nicht kompilieren: ${info}`);
    }
    return shader;
}

function createProgram(gl) {
    const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SRC);
    const fragment = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SRC);
    const program = gl.createProgram();
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error(`Shadow-Programm liess sich nicht linken: ${gl.getProgramInfoLog(program)}`);
    }
    return program;
}

/**
 * Baut das Drape-Netz: ein `meshCells` × `meshCells`-Raster über
 * `innerBounds`, dessen Eckpunkte mit den geladenen Höhen (aus
 * `meshHeights`) angehoben sind, plus UV-Koordinaten in die grössere
 * Höhentextur über `gridBounds` — der Rand darüber hinaus bleibt so für die
 * Verdeckungsprüfung Richtung Sonne im Shader erreichbar, genau wie zuvor
 * beim CPU-Raycasting.
 */
function buildMesh(maplibregl, gridBounds, innerBounds, meshHeights, meshCells) {
    const count = meshCells + 1;
    const positions = new Float32Array(count * count * 3);
    const uvs = new Float32Array(count * count * 2);
    for (let row = 0; row < count; row++) {
        const lat = innerBounds.north + (row / meshCells) * (innerBounds.south - innerBounds.north);
        for (let col = 0; col < count; col++) {
            const lng = innerBounds.west + (col / meshCells) * (innerBounds.east - innerBounds.west);
            const height = meshHeights[row * count + col] * TERRAIN.exaggeration;
            const merc = maplibregl.MercatorCoordinate.fromLngLat({lng, lat}, height);
            const i = row * count + col;
            positions[i * 3] = merc.x;
            positions[i * 3 + 1] = merc.y;
            // `MercatorCoordinate.z` allein setzt das Quad zu tief/hoch — an
            // Kamera-Roundtrips (unproject → reproject) gegengeprüft braucht
            // MapLibres `modelViewProjectionMatrix` hier zusätzlich durch
            // cos(Breite) geteilt, sonst driftet die Fläche mit der Neigung
            // sichtbar vom echten Boden weg. In der offiziellen Doku nicht
            // (klar) belegt, empirisch verifiziert (13.9.2026).
            positions[i * 3 + 2] = merc.z / Math.cos((lat * Math.PI) / 180);
            uvs[i * 2] = (lng - gridBounds.west) / (gridBounds.east - gridBounds.west);
            uvs[i * 2 + 1] = (lat - gridBounds.north) / (gridBounds.south - gridBounds.north);
        }
    }
    const indices = new Uint16Array(meshCells * meshCells * 6);
    let k = 0;
    for (let row = 0; row < meshCells; row++) {
        for (let col = 0; col < meshCells; col++) {
            const i0 = row * count + col;
            const i1 = i0 + 1;
            const i2 = i0 + count;
            const i3 = i2 + 1;
            indices[k++] = i0;
            indices[k++] = i2;
            indices[k++] = i1;
            indices[k++] = i1;
            indices[k++] = i2;
            indices[k++] = i3;
        }
    }
    return {positions, uvs, indices};
}

/**
 * @param {import('maplibre-gl').Map} map
 * @param {object} maplibregl geladenes maplibre-gl-Modul (für `MercatorCoordinate`)
 * @param {Function|null} computeShadow aus `createMap()` — `null`, wenn das
 *        Terrain nicht geladen werden konnte. Dann bleibt dieses Modul inert.
 */
export function createShadow(map, maplibregl, computeShadow) {
    let enabled = false;
    let date = new Date();
    let debounceTimer = null;
    /** Laufende Nummer je Anfrage, damit eine überholte Antwort verworfen wird. */
    let requestCounter = 0;
    let latestAppliedId = -1;
    /** Laufende Berechnung — reiner Diagnose-/Testzugang, siehe `waitForIdle`. */
    let recomputePromise = Promise.resolve();

    // GL-Ressourcen, erst in onAdd() angelegt (dort gibt MapLibre den
    // gemeinsamen WebGL-Kontext).
    let gl = null;
    let program = null;
    let loc = null;
    let texture = null;
    let vertexBuffer = null;
    let uvBuffer = null;
    let indexBuffer = null;
    let indexCount = 0;
    let hasMesh = false;
    let currentMetersPerPixel = 1;

    // Konstant aus SHADOW abgeleitet, unabhängig von den geladenen Daten.
    const gridPixels = (SHADOW.gridRadiusTiles * 2 + 1) * TILE_SIZE;
    const texelSize = 1 / gridPixels;
    const maxSteps = Math.floor(((SHADOW.gridRadiusTiles - SHADOW.outputRadiusTiles) * TILE_SIZE) / SHADOW.rayStepPixels);

    // Sonnenstand-Uniforms — unabhängig von der Höhendaten-Neuberechnung,
    // sofort aktuell nach jedem `setDate()`.
    let sunDirX = 0;
    let sunDirY = -1;
    let altitudeRad = 0;
    let night = true;

    function updateSun() {
        const {lng, lat} = map.getCenter();
        // suncalc liefert Azimut bereits nordbasiert im Uhrzeigersinn (0 = N,
        // 90 = O, 180 = S, 270 = W) — dieselbe Konvention wie Kompass und Kurs
        // im übrigen Cockpit, keine Umrechnung nötig.
        const sun = getPosition(date, lat, lng);
        const azimuthRad = (sun.azimuth * Math.PI) / 180;
        sunDirX = Math.sin(azimuthRad);
        sunDirY = -Math.cos(azimuthRad);
        altitudeRad = (sun.altitude * Math.PI) / 180;
        night = sun.altitude <= 0;
    }

    const layer = {
        id: LAYER_ID,
        type: 'custom',
        renderingMode: '3d',
        onAdd(_map, glArg) {
            gl = glArg;
            program = createProgram(gl);
            loc = {
                matrix: gl.getUniformLocation(program, 'u_matrix'),
                worldSize: gl.getUniformLocation(program, 'u_worldSize'),
                heights: gl.getUniformLocation(program, 'u_heights'),
                texelSize: gl.getUniformLocation(program, 'u_texelSize'),
                metersPerPixel: gl.getUniformLocation(program, 'u_metersPerPixel'),
                rayStepPixels: gl.getUniformLocation(program, 'u_rayStepPixels'),
                maxSteps: gl.getUniformLocation(program, 'u_maxSteps'),
                sunDir: gl.getUniformLocation(program, 'u_sunDir'),
                altitudeRad: gl.getUniformLocation(program, 'u_altitudeRad'),
                night: gl.getUniformLocation(program, 'u_night'),
                color: gl.getUniformLocation(program, 'u_color'),
                opacity: gl.getUniformLocation(program, 'u_opacity'),
                pos: gl.getAttribLocation(program, 'a_pos'),
                uv: gl.getAttribLocation(program, 'a_uv')
            };
            texture = gl.createTexture();
            vertexBuffer = gl.createBuffer();
            uvBuffer = gl.createBuffer();
            indexBuffer = gl.createBuffer();
        },
        onRemove() {
            if (!gl) return;
            gl.deleteProgram(program);
            gl.deleteTexture(texture);
            gl.deleteBuffer(vertexBuffer);
            gl.deleteBuffer(uvBuffer);
            gl.deleteBuffer(indexBuffer);
            gl = null;
            hasMesh = false;
        },
        // MapLibre ≥ 5 (auch 6.7) ruft Custom Layer mit einem Argument-Objekt
        // statt der früheren flachen Matrix auf — `modelViewProjectionMatrix`
        // ist der direkte Ersatz für dieses Mercator-Koordinaten-Quad.
        render(_gl, {modelViewProjectionMatrix}) {
            if (!hasMesh) return;
            gl.useProgram(program);
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
            // Absichtlich kein Tiefentest: die `cos(Breite)`-Korrektur oben ist
            // empirisch kalibriert, nicht exakt — mit Tiefentest verlor die
            // Fläche bei bestimmten (u.a. ganzzahligen) Zoomstufen den
            // Tiefenvergleich gegen das Live-Terrain hauchdünn und verschwand
            // komplett (13.9.2026, per Zoom-Test gefunden). Bekannter Verlust:
            // ein Berg davor verdeckt die Fläche dadurch nicht mehr.
            gl.disable(gl.DEPTH_TEST);
            gl.disable(gl.CULL_FACE);

            gl.uniformMatrix4fv(loc.matrix, false, modelViewProjectionMatrix);
            gl.uniform1f(loc.worldSize, 512 * 2 ** map.getZoom());
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, texture);
            gl.uniform1i(loc.heights, 0);
            gl.uniform1f(loc.texelSize, texelSize);
            gl.uniform1f(loc.metersPerPixel, currentMetersPerPixel);
            gl.uniform1f(loc.rayStepPixels, SHADOW.rayStepPixels);
            gl.uniform1f(loc.maxSteps, maxSteps);
            gl.uniform2f(loc.sunDir, sunDirX, sunDirY);
            gl.uniform1f(loc.altitudeRad, altitudeRad);
            gl.uniform1f(loc.night, night ? 1 : 0);
            gl.uniform3f(loc.color, SHADOW.color[0] / 255, SHADOW.color[1] / 255, SHADOW.color[2] / 255);
            gl.uniform1f(loc.opacity, SHADOW.opacity);

            gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
            gl.enableVertexAttribArray(loc.pos);
            gl.vertexAttribPointer(loc.pos, 3, gl.FLOAT, false, 0, 0);

            gl.bindBuffer(gl.ARRAY_BUFFER, uvBuffer);
            gl.enableVertexAttribArray(loc.uv);
            gl.vertexAttribPointer(loc.uv, 2, gl.FLOAT, false, 0, 0);

            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
            gl.drawElements(gl.TRIANGLES, indexCount, gl.UNSIGNED_SHORT, 0);

            gl.disableVertexAttribArray(loc.pos);
            gl.disableVertexAttribArray(loc.uv);
        }
    };

    function addLayerIfNeeded() {
        if (!map.getLayer(LAYER_ID)) map.addLayer(layer);
    }
    function removeLayerIfPresent() {
        if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
    }

    async function recompute() {
        if (!enabled || !computeShadow) return;
        const id = ++requestCounter;
        const {lng, lat} = map.getCenter();
        // Folgt dem Kamera-Zoom statt fix: dieselbe Kachelzahl deckt bei
        // niedrigerem Zoom automatisch mehr Fläche ab (reale Kachelbreite
        // wächst), ohne mehr Kacheln laden zu müssen.
        const gridZoom = Math.min(SHADOW.maxGridZoom, Math.max(SHADOW.minGridZoom, Math.round(map.getZoom())));

        let result;
        try {
            result = await computeShadow({
                center: {lng, lat},
                gridZoom,
                gridRadiusTiles: SHADOW.gridRadiusTiles,
                outputRadiusTiles: SHADOW.outputRadiusTiles,
                meshCells: SHADOW.meshCells
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

        const {bitmap, gridBounds, innerBounds, meshHeights, meshCells, metersPerPixel} = result;
        currentMetersPerPixel = metersPerPixel;
        const mesh = buildMesh(maplibregl, gridBounds, innerBounds, meshHeights, meshCells);

        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

        gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, uvBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, mesh.uvs, gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.DYNAMIC_DRAW);
        indexCount = mesh.indices.length;

        hasMesh = true;
        map.triggerRepaint();
        // `triggerRepaint()` stösst den nächsten Frame nur an, zeichnet nicht
        // sofort — ohne diese Wartemarke gilt `waitForIdle()` schon erfüllt,
        // bevor die neuen Daten tatsächlich auf dem Bildschirm stehen.
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
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
    // Kartenbewegung im Tracking-Modus unnötig eine Anfrage mit. Eine reine
    // Zeitänderung braucht das nicht (siehe setDate) — nur eine neue Position
    // braucht neue Höhendaten.
    map.on('moveend', () => { if (enabled) scheduleRecompute(); });

    return {
        get isEnabled() {
            return enabled;
        },
        /** Verfügbar nur, wenn das Terrain geladen werden konnte. */
        get isAvailable() {
            return !!computeShadow;
        },
        /** Diagnose-/Testzugang: wartet, bis eine laufende Höhendaten-Ladung angewendet ist. */
        async waitForIdle() {
            await recomputePromise;
        },
        setEnabled(value) {
            enabled = value && !!computeShadow;
            clearTimeout(debounceTimer);
            if (!enabled) {
                removeLayerIfPresent();
                hasMesh = false;
                return;
            }
            addLayerIfNeeded();
            updateSun();
            triggerRecompute();
        },
        setDate(value) {
            date = value;
            if (!enabled) return;
            // Nur die Sonnenstand-Uniforms ändern sich — keine neuen
            // Höhendaten nötig, ein einzelner Repaint genügt für die sofort
            // aktuelle Fläche.
            updateSun();
            map.triggerRepaint();
        }
    };
}

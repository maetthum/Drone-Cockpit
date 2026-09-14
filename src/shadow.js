/**
 * Geländeschatten im Manuell-Modus: Sonnenstand über `suncalc`, Verschattung
 * pro Bildpunkt in einem eigenen, unsichtbaren WebGL-Kontext gerechnet und als
 * MapLibre-`image`-Source angezeigt.
 *
 * Zwei frühere Wege verworfen (13.9.2026, siehe SHADOW in config.js):
 *  1. CPU-Raycasting im Worker — kam am Gerät bei Kartenbewegung nicht mit
 *     dem Kamera-Takt mit.
 *  2. Direktes Zeichnen in MapLibres 3D-Szene (Custom Layer mit eigenem
 *     Mercator-Mesh) — brauchte eine eigene Höhen-Umrechnung, die sich über
 *     drei Gerätetests hinweg nie exakt genug kalibrieren liess (falsche
 *     Bildschirmposition, dann Verschwinden bei bestimmten Zoomstufen, dann
 *     sichtbares Schweben vor Bergkanten trotz Tiefen-Offset).
 *
 * Jetzt: dieselbe Verschattungsrechnung (Fragment-Shader, unverändert) läuft
 * in einem isolierten `OffscreenCanvas`+WebGL-Kontext ohne jede Kamera-Matrix —
 * nur ein Vollbild-Quad. Das Ergebnis geht als fertiges Bild an eine
 * `image`-Source, die MapLibre genauso geländetreu drapiert wie das
 * Luftbild — dieselbe, nachweislich korrekte Drapierung wie in der
 * ursprünglichen (nur zu langsamen) CPU-Version, jetzt mit GPU-Tempo.
 *
 * `terrain.js#computeShadow()` (→ `terrain-worker.js`) liefert dafür nur noch
 * das rohe Terrarium-Höhenraster plus geografische Ausdehnung — keine
 * Verschattungsrechnung und kein Drape-Netz mehr nötig.
 *
 * Kein swissALTI3D-Import und keine `mapbox-gl-shadow-simulator`-Bibliothek —
 * die ist `"license": "UNLICENSED"` und hätte in diesem öffentlichen Repo kein
 * Nutzungsrecht (siehe SHADOW in config.js für die ganze Herleitung).
 */
import {getPosition} from '../vendor/suncalc/index.js';
import {SHADOW} from './config.js';

const SOURCE_ID = 'shadow';
/** Obergrenze der Shader-Schleife — muss zur Kompilierzeit feststehen (GLSL ES 1.00). */
const MAX_STEPS = 128;

/** Vollbild-Quad, keine Kamera-Matrix nötig — reines Rechen-Target. */
const VERTEX_SRC = `
attribute vec2 a_pos;
varying vec2 v_outputUv;
void main() {
    // Clip-Space y=+1 landet am oberen Bildrand (per Test verifiziert, siehe
    // Commit-Beschreibung) — hier gegen die Bild-Zeile gespiegelt, damit
    // v_outputUv=(0,0) der Nordwest-Ecke des sichtbaren Ausschnitts entspricht,
    // wie überall sonst im Cockpit (Zeile 0 = Norden).
    v_outputUv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5);
    gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

const FRAGMENT_SRC = `
precision highp float;
varying vec2 v_outputUv;
uniform sampler2D u_heights;
// v_outputUv deckt nur den sichtbaren inneren Ausschnitt ab; u_heights ist
// das grössere geladene Raster (Rand für die Verdeckungsprüfung Richtung
// Sonne) — dieselbe lineare Abbildung wie zuvor im Drape-Netz, jetzt hier.
uniform float u_uvScale;
uniform float u_uvOffset;
uniform float u_texelSize;
uniform float u_metersPerPixel;
uniform float u_rayStepPixels;
uniform float u_maxSteps;
uniform vec2 u_sunDir;
uniform float u_altitudeRad;
uniform float u_edgeSoftness;
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
    vec2 v_uv = v_outputUv * u_uvScale + u_uvOffset;
    if (u_night > 0.5) {
        gl_FragColor = vec4(u_color, u_opacity);
        return;
    }
    float originHeight = decodeHeight(v_uv);
    vec2 step = u_sunDir * u_texelSize * u_rayStepPixels;
    // Grösster Sichtwinkel entlang des Strahls statt eines reinen Ja/Nein —
    // so lässt sich die Verschattung unten weich statt hart einblenden
    // (14.9.2026, Gerätebefund: harte Schwelle erzeugte ein Sägezahnmuster
    // an Gratlinien, weil benachbarte Ausgabepixel bei kleinsten
    // Höhenschwankungen unabhängig voneinander kippten).
    float maxAngle = -1.5707963;
    for (int i = 1; i <= ${MAX_STEPS}; i++) {
        if (float(i) > u_maxSteps) break;
        vec2 uv = v_uv + step * float(i);
        if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) break;
        float h = decodeHeight(uv);
        float dist = float(i) * u_rayStepPixels * u_metersPerPixel;
        // Sichtwinkel vom Ursprung zum abgetasteten Punkt, gegen die
        // Sonnenhöhe: darüber blockiert das Gelände dort die Sonne von hier aus.
        maxAngle = max(maxAngle, atan(h - originHeight, dist));
        // Schon jenseits des Weichzeichner-Bands voll verschattet — weitere
        // Schritte können das Ergebnis nicht mehr ändern.
        if (maxAngle > u_altitudeRad + u_edgeSoftness) break;
    }
    float shadowFactor = smoothstep(u_altitudeRad - u_edgeSoftness, u_altitudeRad + u_edgeSoftness, maxAngle);
    if (shadowFactor <= 0.0) discard;
    gl_FragColor = vec4(u_color, u_opacity * shadowFactor);
}
`;

/**
 * Weichzeichnet das rohe Höhenraster, bevor der Sonnenstrahl-Test darauf
 * läuft (14.9.2026, Gerätebefund: bei hohem Zoom zeigte der Schattenrand
 * grosse, gerade Facetten). Glättet die Dreieckskanten des Quantized-Mesh,
 * die sonst als gerade Knicke im Schattenrand stehen — die eigentliche
 * Ursache der groben Facetten lag aber im Kachel-Deckel des Terrain-Plugins
 * und ist dort behoben (siehe `MAX_SOURCE_TILES` dort sowie
 * SHADOW.heightBlurMeters in config.js für die widerlegte Erstvermutung).
 *
 * Läuft als eigener, einmaliger Durchgang statt in der Raycasting-Schleife:
 * dort würde eine 9-fache Texturabtastung pro Schritt (bis zu 128 Schritte,
 * jeder Ausgabepixel) die Rechenzeit unnötig vervielfachen, obwohl das
 * Höhenraster für alle Schritte gleich bleibt.
 */
const BLUR_FRAGMENT_SRC = `
precision highp float;
varying vec2 v_outputUv;
uniform sampler2D u_heights;
uniform float u_texelSize;
uniform float u_blurTexels;

float decodeHeight(vec2 uv) {
    vec3 c = texture2D(u_heights, uv).rgb * 255.0;
    return c.r * 256.0 + c.g + c.b / 256.0 - 32768.0;
}

// Kehrwert von terrariumPack() in terrain-worker.js.
vec3 encodeHeight(float h) {
    float value = floor((h + 32768.0) * 256.0 + 0.5);
    float r = floor(value / 65536.0);
    float rest = value - r * 65536.0;
    float g = floor(rest / 256.0);
    float b = rest - g * 256.0;
    return vec3(r, g, b) / 255.0;
}

void main() {
    float step = u_texelSize * u_blurTexels;
    float sum = 0.0;
    for (int dx = -1; dx <= 1; dx++) {
        for (int dy = -1; dy <= 1; dy++) {
            sum += decodeHeight(v_outputUv + vec2(float(dx), float(dy)) * step);
        }
    }
    gl_FragColor = vec4(encodeHeight(sum / 9.0), 1.0);
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

function createProgram(gl, fragmentSrc) {
    const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SRC);
    const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSrc);
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
 * `image`-Source-Ecken, oben-links im Uhrzeigersinn — wie von MapLibre
 * verlangt.
 */
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
 * Eigener, unsichtbarer WebGL-Kontext nur für die Verschattungsrechnung — mit
 * MapLibres eigenem Kontext (Kamera, Terrain-Tiefenpuffer) hat das nichts zu
 * tun, deshalb auch keine der drei früheren Kamera-Kalibrierungsprobleme.
 */
function createComputer(canvasSize) {
    const canvas = new OffscreenCanvas(canvasSize, canvasSize);
    const gl = canvas.getContext('webgl');
    if (!gl) throw new Error('WebGL für Geländeschatten-Berechnung nicht verfügbar');
    const program = createProgram(gl, FRAGMENT_SRC);
    const blurProgram = createProgram(gl, BLUR_FRAGMENT_SRC);
    const blurLoc = {
        heights: gl.getUniformLocation(blurProgram, 'u_heights'),
        texelSize: gl.getUniformLocation(blurProgram, 'u_texelSize'),
        blurTexels: gl.getUniformLocation(blurProgram, 'u_blurTexels'),
        pos: gl.getAttribLocation(blurProgram, 'a_pos')
    };
    const loc = {
        heights: gl.getUniformLocation(program, 'u_heights'),
        uvScale: gl.getUniformLocation(program, 'u_uvScale'),
        uvOffset: gl.getUniformLocation(program, 'u_uvOffset'),
        texelSize: gl.getUniformLocation(program, 'u_texelSize'),
        metersPerPixel: gl.getUniformLocation(program, 'u_metersPerPixel'),
        rayStepPixels: gl.getUniformLocation(program, 'u_rayStepPixels'),
        maxSteps: gl.getUniformLocation(program, 'u_maxSteps'),
        sunDir: gl.getUniformLocation(program, 'u_sunDir'),
        altitudeRad: gl.getUniformLocation(program, 'u_altitudeRad'),
        edgeSoftness: gl.getUniformLocation(program, 'u_edgeSoftness'),
        night: gl.getUniformLocation(program, 'u_night'),
        color: gl.getUniformLocation(program, 'u_color'),
        opacity: gl.getUniformLocation(program, 'u_opacity'),
        pos: gl.getAttribLocation(program, 'a_pos')
    };
    const quadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // Zwischenziel des Weichzeichner-Durchgangs — dieselbe Auflösung wie das
    // geladene Höhenraster, nicht die Ausgabe-Canvas. Die Rastergrösse ändert
    // sich seit dem stufenlosen Umbau mit der Sichtweite, die Textur wird
    // daher bei Bedarf neu angelegt.
    const blurTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, blurTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const blurFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, blurFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, blurTexture, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    let blurSize = 0;

    return {
        /**
         * Rechnet die Schattenfläche für ein geladenes Höhenraster und gibt
         * sie als ImageBitmap zurück (Alpha 0 ausserhalb der Schattenfläche).
         */
        compute({heightsBitmap, gridPixels, uvScale, uvOffset, texelSize, rayStepPixels, maxSteps,
            metersPerPixel, sunDirX, sunDirY, altitudeRad, night}) {
            gl.disable(gl.DEPTH_TEST);
            gl.disable(gl.BLEND);

            if (blurSize !== gridPixels) {
                gl.bindTexture(gl.TEXTURE_2D, blurTexture);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gridPixels, gridPixels, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
                blurSize = gridPixels;
            }

            gl.bindTexture(gl.TEXTURE_2D, texture);
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, heightsBitmap);

            // Weichzeichner-Durchgang: rohes Höhenraster → `blurTexture`, in
            // Texeln proportional zur realen Kachelauflösung (siehe
            // SHADOW.heightBlurMeters) statt einer festen Texelzahl — sonst
            // würde derselbe Radius bei niedrigem Zoom unnötig viel und bei
            // hohem Zoom zu wenig glätten.
            gl.bindFramebuffer(gl.FRAMEBUFFER, blurFbo);
            gl.viewport(0, 0, gridPixels, gridPixels);
            gl.useProgram(blurProgram);
            gl.bindTexture(gl.TEXTURE_2D, texture);
            gl.activeTexture(gl.TEXTURE0);
            gl.uniform1i(blurLoc.heights, 0);
            gl.uniform1f(blurLoc.texelSize, texelSize);
            gl.uniform1f(blurLoc.blurTexels, SHADOW.heightBlurMeters / metersPerPixel);
            gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
            gl.enableVertexAttribArray(blurLoc.pos);
            gl.vertexAttribPointer(blurLoc.pos, 2, gl.FLOAT, false, 0, 0);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.viewport(0, 0, canvasSize, canvasSize);
            gl.clearColor(0, 0, 0, 0);
            gl.clear(gl.COLOR_BUFFER_BIT);

            gl.useProgram(program);
            gl.bindTexture(gl.TEXTURE_2D, blurTexture);
            gl.activeTexture(gl.TEXTURE0);
            gl.uniform1i(loc.heights, 0);
            gl.uniform1f(loc.uvScale, uvScale);
            gl.uniform1f(loc.uvOffset, uvOffset);
            gl.uniform1f(loc.texelSize, texelSize);
            gl.uniform1f(loc.metersPerPixel, metersPerPixel);
            gl.uniform1f(loc.rayStepPixels, rayStepPixels);
            gl.uniform1f(loc.maxSteps, maxSteps);
            gl.uniform2f(loc.sunDir, sunDirX, sunDirY);
            gl.uniform1f(loc.altitudeRad, altitudeRad);
            gl.uniform1f(loc.edgeSoftness, SHADOW.edgeSoftnessRad);
            gl.uniform1f(loc.night, night ? 1 : 0);
            gl.uniform3f(loc.color, SHADOW.color[0] / 255, SHADOW.color[1] / 255, SHADOW.color[2] / 255);
            gl.uniform1f(loc.opacity, SHADOW.opacity);

            gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
            gl.enableVertexAttribArray(loc.pos);
            gl.vertexAttribPointer(loc.pos, 2, gl.FLOAT, false, 0, 0);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

            return canvas.transferToImageBitmap();
        }
    };
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
    /** Laufende Berechnung — reiner Diagnose-/Testzugang, siehe `waitForIdle`. */
    let recomputePromise = Promise.resolve();
    /** Diagnose-/Testzugang: die zuletzt angewendete Bild-URL. */
    let lastImageUrl = null;

    /** Erst bei der ersten Anfrage angelegt (kein WebGL-Kontext für ungenutztes Feature). */
    let computer = null;

    /** Zuletzt gewählte Quellstufe — Gedächtnis der Hysterese, siehe `planGrid()`. */
    let sourceZoomState = null;

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

    function removeLayer() {
        if (map.getLayer(SOURCE_ID)) map.removeLayer(SOURCE_ID);
        if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
    }

    /**
     * Geografischer Punkt, um den das Schattenraster gebaut wird — nicht die
     * Bildschirmmitte, sondern ein Punkt näher am unteren Bildrand (siehe
     * `SHADOW.centerScreenFraction`). `unproject()` ist geländebewusst
     * (berücksichtigt `map.terrain`), liefert hier also den tatsächlichen
     * Bodenpunkt.
     */
    function gridCenter() {
        const canvas = map.getCanvas();
        return map.unproject([canvas.clientWidth / 2, canvas.clientHeight * SHADOW.centerScreenFraction]);
    }

    /** Sichtweite in Metern: grösster Abstand der Abtastpunkte vom Fensterzentrum. */
    function visibleRadiusMeters(center) {
        const canvas = map.getCanvas();
        const metersPerLng = 111320 * Math.cos((center.lat * Math.PI) / 180);
        let distance = 0;
        for (const [fx, fy] of SHADOW.extentSamples) {
            const point = map.unproject([fx * canvas.clientWidth, fy * canvas.clientHeight]);
            const dx = (point.lng - center.lng) * metersPerLng;
            const dy = (point.lat - center.lat) * 110540;
            const d = Math.hypot(dx, dy);
            // Zielt der Abtastpunkt über den Horizont, liefert `unproject()`
            // keinen brauchbaren Bodenpunkt — das fangen der Endlichkeitstest
            // und der Deckel darunter ab.
            if (Number.isFinite(d)) distance = Math.max(distance, d);
        }
        return Math.min(Math.max(distance, SHADOW.minVisibleMeters), SHADOW.maxVisibleMeters);
    }

    /**
     * Legt Fenster und Abtastung für eine Neuberechnung fest — **stufenlos**
     * (14.9.2026, Gerätebefund „Schatten springt hin und her, nur durch
     * Zoomänderung" und „ich will keine Stufen").
     *
     * Vorher hing alles an einer ganzzahligen Kachelstufe: Fensterbreite,
     * Reichweite des Sonnenstrahls und Auflösung sprangen gemeinsam, sobald
     * `Math.round(map.getZoom())` umklappte — das Fenster halbierte sich (bei
     * Stufe 12 20 km breit, bei 13 nur noch 10 km), und entferntes Gelände
     * verlor schlagartig seinen Schatten. Gemessen kippte die verschattete
     * Fläche bei 0,1 Zoomstufen Unterschied zwischen 20,1 % und 24,8 %.
     * Zusätzlich sass das Fenster auf ganzen Kachelgrenzen und sprang beim
     * Schwenken in Kachelbreiten (3,3 km bei Stufe 13).
     *
     * Jetzt sind **Fensterbreite und Reichweite Meterwerte**, die stetig der
     * Sichtweite folgen. Ganzzahlig bleibt allein die Stufe der Quellkacheln
     * (Kacheln gibt es nur so) — sie bestimmt nur noch den Detailgrad, nicht
     * mehr Ausschnitt oder Reichweite, und wird über eine Hysterese selten
     * gewechselt. Der Wechsel ändert das Bild dadurch kaum sichtbar.
     */
    function planGrid(center) {
        const sichtweite = visibleRadiusMeters(center);
        const halbeBreite = sichtweite + SHADOW.rayReachMeters;
        const metersPerPixelAt = (zoom) => (156543.03392804097 * Math.cos((center.lat * Math.PI) / 180)) / 2 ** zoom;
        // Feinste Stufe, deren Raster noch unter den Pixel-Deckel passt — der
        // deckelt zugleich die Zahl der zu ladenden Kacheln.
        const ideal = Math.log2((SHADOW.maxGridPixels * 156543.03392804097
            * Math.cos((center.lat * Math.PI) / 180)) / (2 * halbeBreite));
        const ziel = Math.min(SHADOW.maxGridZoom, Math.max(SHADOW.minGridZoom, Math.floor(ideal)));
        // Einseitige Hysterese: passt die laufende Stufe nicht mehr unter den
        // Deckel, sofort wechseln; wäre bloss eine feinere möglich, erst nach
        // einem vollen Stufenabstand plus Totband.
        const behalten = sourceZoomState !== null
            && sourceZoomState <= ideal
            && ideal - sourceZoomState < 1 + SHADOW.gridZoomHysteresis
            && sourceZoomState >= SHADOW.minGridZoom
            && sourceZoomState <= SHADOW.maxGridZoom;
        const sourceZoom = behalten ? sourceZoomState : ziel;
        sourceZoomState = sourceZoom;

        const metersPerPixel = metersPerPixelAt(sourceZoom);
        // Gerade Pixelzahl, damit das Zentrum auf einer Pixelgrenze liegt.
        const gridPixels = 2 * Math.round(halbeBreite / metersPerPixel);
        const marginPixels = Math.round(SHADOW.rayReachMeters / metersPerPixel);
        const outputPixels = gridPixels - 2 * marginPixels;
        // Der Strahl durchquert den Rand in stets derselben Schrittzahl, die
        // Schrittweite wächst also mit dem Rand — so bleibt die Reichweite in
        // Metern konstant, statt an der Schrittzahl zu hängen.
        const rayStepPixels = Math.max(1, marginPixels / MAX_STEPS);
        return {
            sourceZoom, gridPixels, marginPixels, metersPerPixel, rayStepPixels,
            maxSteps: Math.min(MAX_STEPS, Math.floor(marginPixels / rayStepPixels)),
            texelSize: 1 / gridPixels,
            uvScale: outputPixels / gridPixels,
            uvOffset: marginPixels / gridPixels
        };
    }

    async function recompute() {
        if (!enabled || !computeShadow) return;
        const id = ++requestCounter;
        const center = gridCenter();
        const {lng, lat} = center;
        const plan = planGrid(center);
        // Sonnenstand jetzt einfangen, nicht erst nach dem Warten auf die
        // Höhendaten lesen: `sunDirX`/`night`/... sind gemeinsamer,
        // veränderlicher Zustand — würde eine neuere Anfrage (anderes Datum)
        // dazwischen `updateSun()` aufrufen, rechnete diese Anfrage sonst
        // versehentlich mit fremdem Sonnenstand weiter.
        const sunSnapshot = {sunDirX, sunDirY, altitudeRad, night};

        // Bei einem Fehlschlag (z.B. kurzer Netz-Hänger beim Kachel-Nachladen)
        // ein paar Mal automatisch erneut versuchen, statt die zuletzt gezeigte
        // Fläche stillschweigend für den Rest der Fahrt einfrieren zu lassen —
        // ohne jeden Hinweis war das am Gerät nicht von einer echten
        // Nacht-Berechnung zu unterscheiden (13./14.9.2026).
        let result;
        for (let attempt = 0; ; attempt++) {
            try {
                result = await computeShadow({
                    center: {lng, lat},
                    sourceZoom: plan.sourceZoom,
                    gridPixels: plan.gridPixels,
                    marginPixels: plan.marginPixels
                });
                break;
            } catch {
                if (attempt >= SHADOW.maxRetries - 1 || !enabled || id <= latestAppliedId) return;
                await new Promise((resolve) => setTimeout(resolve, SHADOW.retryDelayMs));
            }
        }
        // Zwischenzeitlich ist eine neuere Anfrage unterwegs, oder der Schatten
        // wurde inzwischen wieder ausgeschaltet — dieses Ergebnis verwerfen.
        if (id <= latestAppliedId || !enabled) return;

        const {bitmap, innerBounds, metersPerPixel} = result;
        // Feste Auflösung der Ausgabe, unabhängig von der Rastergrösse: der
        // Shader bildet `v_outputUv` (0…1 über die Rechen-Canvas) ohnehin über
        // `uvScale`/`uvOffset` auf das Raster ab, die beiden Grössen müssen
        // also nicht zueinander passen.
        if (!computer) computer = createComputer(SHADOW.outputPixels);
        const resultBitmap = computer.compute({
            heightsBitmap: bitmap,
            gridPixels: plan.gridPixels,
            uvScale: plan.uvScale,
            uvOffset: plan.uvOffset,
            texelSize: plan.texelSize,
            rayStepPixels: plan.rayStepPixels,
            maxSteps: plan.maxSteps,
            metersPerPixel,
            ...sunSnapshot
        });
        const url = await bitmapToDataUrl(resultBitmap);
        // Erneut prüfen statt die Nummer schon vor der Kodierung zu setzen:
        // `bitmapToDataUrl` ist asynchron — ohne diese zweite Prüfung könnte
        // eine ältere, aber langsamere Anfrage eine inzwischen bereits
        // angewendete neuere überschreiben (z.B. beim schnellen Antippen der
        // Checkbox oder Ziehen am Zeit-Regler).
        if (!enabled || id <= latestAppliedId) return;
        latestAppliedId = id;
        lastImageUrl = url;
        const coordinates = boundsToCoordinates(innerBounds);
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
            updateSun();
            triggerRecompute();
        },
        setDate(value) {
            date = value;
            if (enabled) scheduleRecompute();
        }
    };
}

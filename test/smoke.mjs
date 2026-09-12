/**
 * Browser-Smoke-Test für die Phasen 1 und 2.
 *
 * Warum gestubbte Endpunkte und gefälschte Sensoren: die Entwicklungsumgebung
 * hat keinen Netzzugang zu *.geo.admin.ch und kein GPS. Der Test prüft deshalb
 * die Verdrahtung und das Regelverhalten der Kameraführung — nicht die
 * Korrektheit der echten Layer-IDs und nicht das Verhalten echter Sensorik.
 * Beides braucht einen Gerätetest.
 *
 * Voraussetzung: statischer Server auf http://127.0.0.1:8099 im Repo-Wurzelverzeichnis.
 *   npx http-server -p 8099 -s .
 * Aufruf: NODE_PATH=$(npm root -g) node test/smoke.mjs   (playwright global installiert)
 */
// CommonJS-Auflösung, damit playwright auch global installiert gefunden wird
// (ESM-Imports ignorieren NODE_PATH).
import {createRequire} from 'node:module';
// Der erwartete Quellenhinweis kommt aus der Konfiguration, nicht als Kopie im
// Test: sonst hält eine Änderung an den Layern den Test grün, obwohl der
// Rechteinhaber fehlt.
import {ATTRIBUTION_TEXT, DISCLAIMER, FOLLOW, OBSTACLES, OVERLAYS, PREFETCH, SKY} from '../src/config.js';
import {PROBE_TILE, tileBbox} from '../src/overlays.js';

const {chromium} = createRequire(import.meta.url)('playwright');
const BASE_URL = process.env.SMOKE_URL ?? 'http://127.0.0.1:8099/index.html';

/** 1×1-PNG als Platzhalter für WMTS-Kacheln. */
const STUB_TILE = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64');

const STUB_LAYER_JSON = {
    tilejson: '2.1.0',
    format: 'quantized-mesh-1.0',
    version: '1.0.0',
    scheme: 'tms',
    tiles: ['{z}/{x}/{y}.terrain?v={version}'],
    projection: 'EPSG:4326',
    bounds: [5.6, 45.5, 11.0, 48.2],
    minzoom: 0,
    maxzoom: 14,
    attribution: '© swisstopo (stub)'
};

/**
 * Ersetzt Geolocation und DeviceOrientation durch steuerbare Attrappen, damit
 * Fahrprofile deterministisch abgespielt werden können.
 */
function installSensorHarness() {
    const successCallbacks = [];
    window.__harness = {
        /** Bildschirmlage, die screen.orientation.angle unten zurückgibt. */
        screenAngle: 0,
        emitFix(coords) {
            const full = {
                longitude: 7.909, latitude: 46.588, altitude: null, altitudeAccuracy: null,
                accuracy: 5, speed: null, heading: null, ...coords
            };
            successCallbacks.forEach((cb) => cb({coords: full, timestamp: Date.now()}));
        },
        emitCompass(heading) {
            const event = new Event('deviceorientation');
            event.webkitCompassHeading = heading;
            window.dispatchEvent(event);
        },
        /** Gerätneigung: beta = Kippen um die Querachse, 0 = flach, 90 = aufrecht. */
        emitTilt(beta, gamma = 0) {
            const event = new Event('deviceorientation');
            event.beta = beta;
            event.gamma = gamma;
            window.dispatchEvent(event);
        }
    };
    Object.defineProperty(navigator, 'geolocation', {
        configurable: true,
        value: {
            watchPosition(success) { successCallbacks.push(success); return 1; },
            clearWatch() {},
            // Die App holt vor dem Kartenbau einen groben Fix, um gleich am
            // richtigen Ort zu laden. Hier fest auf die Testposition, damit die
            // Kamera dort startet, wo die Fahrprofile spielen.
            getCurrentPosition(success) {
                success({coords: {longitude: 7.909, latitude: 46.588, accuracy: 500}, timestamp: Date.now()});
            }
        }
    });
    // Bildschirmlage steuerbar machen: die eigene Property verdeckt den
    // Getter auf ScreenOrientation.prototype.
    Object.defineProperty(window.screen.orientation, 'angle', {
        configurable: true,
        get: () => window.__harness.screenAngle
    });
    // iOS-Pfad erzwingen: nur so wird requestPermission() überhaupt ausgeführt.
    window.DeviceOrientationEvent = function DeviceOrientationEvent() {};
    window.DeviceOrientationEvent.requestPermission = async () => 'granted';
}

/** Zieht Layer-ID und Zoomstufe aus einer geo.admin-WMTS-URL. */
function wmtsRequestOf(url) {
    const match = url.match(/\/1\.0\.0\/([^/]+)\/.*\/(\d+)\/\d+\/\d+/);
    return match ? {layer: match[1], zoom: Number(match[2])} : {layer: null, zoom: null};
}

/**
 * Dasselbe für WMS: die Layer-ID steckt im `LAYERS`-Parameter, und statt einer
 * Zoomstufe identifiziert die BBOX die Prüfanfrage aus `probeOverlayLayers()`.
 */
function wmsRequestOf(url) {
    const params = new URL(url).searchParams;
    return {layer: params.get('LAYERS'), isProbe: params.get('BBOX') === tileBbox(PROBE_TILE)};
}

async function openPage({layerJsonStatus = 200, withSensorHarness = false, failingWmtsLayer = null, configPatch = null} = {}) {
    const browser = await chromium.launch({
        executablePath: process.env.CHROMIUM_PATH ?? undefined,
        args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox']
    });
    // Service-Worker blocken: sonst beantwortet er Anfragen aus seinem Cache
    // und die Routen dieses Tests greifen nicht mehr. Für die PWA gibt es einen
    // eigenen Test, der ihn zulässt.
    const page = await browser.newPage({
        viewport: {width: 430, height: 900}, deviceScaleFactor: 2, hasTouch: true,
        serviceWorkers: 'block'
    });
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    // Bildschirmsperre: der Testbrowser verweigert sie, ein echtes Gerät
    // gewährt sie. Ohne diesen Ersatz meldete das Cockpit zu Recht einen
    // Fehler — und liesse jeden Test scheitern, der ein leeres Fehlerbanner
    // erwartet.
    // Zählt zugleich mit, damit `testKeepsScreenAwake` prüfen kann, wie oft
    // und mit welchem Typ angefordert wurde.
    await page.addInitScript(() => {
        window.__wakeCount = 0;
        window.__wakeRelease = [];
        Object.defineProperty(navigator, 'wakeLock', {configurable: true, value: {
            request: async (typ) => {
                window.__wakeCount++;
                window.__wakeType = typ;
                return {
                    addEventListener: (name, cb) => { if (name === 'release') window.__wakeRelease.push(cb); },
                    release: async () => {}
                };
            }
        }});
    });
    if (withSensorHarness) await page.addInitScript(installSensorHarness);
    // Erlaubt einem Test, die Konfiguration zu verbiegen, ohne die echte
    // anzufassen — z.B. um einen Layer künstlich als nicht abfragbar zu
    // markieren.
    if (configPatch) {
        // Aus der Datei lesen statt über `route.fetch()`: der Umweg übers Netz
        // läuft in dieselbe Route zurück und blockiert den Seitenaufbau.
        const {readFileSync} = await import('node:fs');
        const {fileURLToPath} = await import('node:url');
        const quelle = readFileSync(fileURLToPath(new URL('../src/config.js', import.meta.url)), 'utf8');
        await page.route('**/src/config.js', (route) => route.fulfill({
            contentType: 'text/javascript', body: configPatch(quelle)
        }));
    }

    await page.route('**/3d.geo.admin.ch/**/layer.json', (route) => (layerJsonStatus === 200
        ? route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify(STUB_LAYER_JSON)})
        : route.fulfill({status: layerJsonStatus, body: ''})));
    // Der echte Endpunkt antwortet ausserhalb der Abdeckung mit 403; das Plugin
    // behandelt das als "keine Kachel" und legt eine flache Ersatzfläche.
    await page.route('**/3d.geo.admin.ch/**/*.terrain*', (route) => route.fulfill({status: 403, body: ''}));
    // Kachelanfragen je Layer, ohne die Verfügbarkeitsprüfung beim Start.
    const wmtsRequests = new Map();
    const serveTile = (route, layer, isProbe) => {
        if (!isProbe) wmtsRequests.set(layer, (wmtsRequests.get(layer) ?? 0) + 1);
        return layer === failingWmtsLayer
            ? route.fulfill({status: 404, body: ''})
            : route.fulfill({status: 200, contentType: 'image/png', body: STUB_TILE});
    };
    await page.route('**/wmts.geo.admin.ch/**', (route) => {
        const {layer, zoom} = wmtsRequestOf(route.request().url());
        return serveTile(route, layer, zoom === PROBE_TILE.z);
    });
    // Nicht jeder Layer hat einen WMTS-Kachelsatz — ohne diese Route liefen die
    // WMS-Overlays im Test gegen das echte Netz.
    await page.route('**/wms.geo.admin.ch/**', (route) => {
        const {layer, isProbe} = wmsRequestOf(route.request().url());
        return serveTile(route, layer, isProbe);
    });

    // Hindernisse kommen als Vektor über api3 — ohne Route liefe der Test
    // gegen das echte Netz. Ein Punkt und eine Linie, damit beide Layer greifen.
    let identifyCalls = 0;
    const OBSTACLE_RESULTS = [
        {type: 'Feature', id: 1, properties: {obstacletype: 'CRANE', maxheightagl: 63.3},
            geometry: {type: 'Point', coordinates: [7.909, 46.588]}},
        {type: 'Feature', id: 2, properties: {obstacletype: 'TRANSMISSION_LINE', maxheightagl: 25},
            geometry: {type: 'LineString', coordinates: [[7.905, 46.585], [7.915, 46.592]]}}
    ];
    // Zwei Verbraucher am selben Dienst: die Hindernisse fragen ein Rechteck ab,
    // die Antippen-Info einen Punkt. Ohne die Unterscheidung bekäme das
    // Info-Panel Hindernisse statt Regeltexte.
    // Dreimal dasselbe: der Dienst liefert eine Zone in Teilstücken.
    const INFO_ZONE = {
        zone_name_de: 'CTR TEST',
        zone_restriction_de: 'Der Betrieb von unbemannten Luftfahrzeugen mit einem Gewicht von mehr als 250 g ist ab einer Höhe von 120 m über Grund verboten.',
        air_vol_lower_limit: '120', air_vol_lower_vref: 'AGL', air_vol_upper_limit: null,
        auth_name_de: ['Skyguide']
    };
    const INFO_LAYER = 'ch.bazl.einschraenkungen-drohnen';
    const INFO_RESULTS = [
        {type: 'Feature', id: 9, layerBodId: INFO_LAYER, layerName: 'Geografische UAS-Gebiete der Schweiz', properties: INFO_ZONE},
        {type: 'Feature', id: 10, layerBodId: INFO_LAYER, layerName: 'Geografische UAS-Gebiete der Schweiz', properties: {...INFO_ZONE}},
        {type: 'Feature', id: 11, layerBodId: INFO_LAYER, layerName: 'Geografische UAS-Gebiete der Schweiz', properties: {...INFO_ZONE}}
    ];

    /*
     * Die amtlichen Sachdaten kommen aus einem zweiten Aufruf und als HTML,
     * nicht als JSON. Ohne diesen Stub liefe der Test in den Rückfallpfad und
     * prüfte die Darstellung nie, die er prüfen soll.
     */
    const INFO_HTML = `<div class="htmlpopup-container">
      <div class="htmlpopup-header"><span>Geografische UAS-Gebiete der Schweiz</span> (BAZL)</div>
      <div class="htmlpopup-content"><table>
        <tr><td class="cell-left">Bezeichnung</td><td>CTR TEST</td></tr>
        <tr><td class="cell-left">Einschr\u00e4nkung</td><td>${INFO_ZONE.zone_restriction_de}</td></tr>
        <tr><td class="cell-left">Untergrenze</td><td>120 m \u00fcber Grund</td></tr>
        <tr><td class="cell-left">Zusatzinformationen</td><td> </td></tr>
        <tr><td class="cell-left">Weitere Informationen</td><td><a href="https://www.bazl.admin.ch/">Bewilligung</a></td></tr>
      </table></div></div>`;
    await page.route('**/api3.geo.admin.ch/**', (route) => {
        if (route.request().url().includes('/htmlPopup')) {
            return route.fulfill({status: 200, contentType: 'text/html', body: INFO_HTML});
        }
        identifyCalls += 1;
        const point = route.request().url().includes('esriGeometryPoint');
        return route.fulfill({status: 200, contentType: 'application/json',
            body: JSON.stringify({results: point ? INFO_RESULTS : OBSTACLE_RESULTS})});
    });

    await page.goto(BASE_URL, {waitUntil: 'load'});
    return {browser, page, pageErrors, wmtsRequests, identifyCalls: () => identifyCalls};
}

/**
 * Echte Zwei-Finger-Geste über das DevTools-Protokoll. `page.touchscreen` kann
 * nur einen Finger — Zoom und Neigung brauchen zwei, und genau die kamen am
 * Gerät nicht an.
 */
async function twoFingerGesture(page, startPoints, endPoints, steps = 12) {
    const cdp = await page.context().newCDPSession(page);
    const at = (i) => startPoints.map((p, n) => ({
        x: p.x + ((endPoints[n].x - p.x) * i) / steps,
        y: p.y + ((endPoints[n].y - p.y) * i) / steps
    }));
    await cdp.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: at(0)});
    for (let i = 1; i <= steps; i++) {
        await cdp.send('Input.dispatchTouchEvent', {type: 'touchMove', touchPoints: at(i)});
        await page.waitForTimeout(16);
    }
    await cdp.send('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []});
    await page.waitForTimeout(300);
}

const results = [];
const BEGONNEN = Date.now();

/**
 * Standardmässig knapp: bestandene Tests erscheinen als Punkt, ausführlich wird
 * nur, was fehlschlägt. Die vollständige Liste kostet bei jedem Lauf drei
 * Dutzend Zeilen, und gelesen werden davon fast immer nur die Fehlschläge.
 * `SMOKE_VERBOSE=1` schaltet die alte Ausgabe wieder ein.
 */
const AUSFUEHRLICH = process.env.SMOKE_VERBOSE === '1';

function report(name, failures, detail) {
    const bestanden = failures.length === 0;
    results.push({name, bestanden, detail});
    if (bestanden && !AUSFUEHRLICH) {
        process.stdout.write('.');
        return;
    }
    if (!bestanden) process.stdout.write('\n');
    console.log(`${bestanden ? 'PASS' : 'FAIL'}  ${name}`);
    if (detail) console.log(`      ${detail}`);
    failures.forEach((failure) => console.log(`      → ${failure}`));
}

/** Startet den Live-Modus über den Button (echte Nutzergeste). */
async function enterLiveMode(page) {
    await page.waitForFunction(() => window.cockpit !== undefined, null, {timeout: 30000});
    // Grosszügiger Timeout: unter Last brauchte der erste Anstrich gelegentlich
    // länger als die 30-Sekunden-Vorgabe, was als Fehlschlag durchschlug.
    await page.waitForSelector('#start-button', {state: 'visible', timeout: 60000});
    await page.click('#start-button', {timeout: 60000});
    await page.waitForSelector('#start', {state: 'hidden', timeout: 10000});

    /*
     * HUD und Kameralage starten seit dem 5.9.2026 eingeklappt, und ein
     * eingeklapptes HUD wird bewusst nicht mehr befüllt. Für die Tests ist es
     * aber die Diagnosequelle — also aufklappen, so wie es ein Nutzer täte,
     * der die Werte sehen will.
     */
    await page.evaluate(() => {
        if (document.getElementById('hud').hidden) document.getElementById('hud-toggle').click();
        const lage = document.getElementById('anchor-toggle');
        if (!lage.hidden && document.getElementById('anchor-control').hidden) lage.click();
    });

    /*
     * Die Overlays werden erst zugeschaltet, wenn Luftbild und Gelände stehen.
     * Wer sie prüfen will, muss das abwarten — sonst misst der Test den
     * Zustand von vor einer Sekunde.
     */
    await page.waitForFunction(
        () => window.cockpit?.overlays?.isVisible('drohnen'), null, {timeout: 20000}
    ).catch(() => {});
}

// --- Phase 1 ---------------------------------------------------------------

async function testMapBoot({name, layerJsonStatus, expectStatus, expectBannerVisible}) {
    const {browser, page, pageErrors} = await openPage({layerJsonStatus});
    await page.waitForFunction(
        (expected) => document.getElementById('hud-status')?.textContent === expected,
        expectStatus,
        {timeout: 30000}
    );
    const state = await page.evaluate(() => ({
        status: document.getElementById('hud-status').textContent,
        attribution: document.getElementById('disclaimer').textContent,
        disclaimer: document.getElementById('disclaimer').textContent,
        startDisclaimer: document.getElementById('start-disclaimer').textContent,
        bannerHidden: document.getElementById('banner').hidden,
        hasCanvas: !!document.querySelector('#map canvas'),
        sky: window.cockpit?.map?.getSky?.() ?? null
    }));
    await browser.close();

    const failures = [];
    if (!state.hasCanvas) failures.push('kein Karten-Canvas');
    // Ohne Himmel steht über dem Horizont die Hintergrundfarbe — bei Pitch 84°
    // ist das die halbe Fläche, und sie war schwarz.
    if (state.sky?.['sky-color'] !== SKY['sky-color']) failures.push(`kein Himmel gesetzt: ${JSON.stringify(state.sky)}`);
    /*
     * Hinweis, Quellen und Kartenvermerk stehen seit dem 7.9.2026 in einer
     * einzigen Zeile — geprüft wird deshalb, dass der Quellenhinweis *enthalten*
     * ist, nicht dass er allein dasteht.
     */
    if (!state.attribution.includes(ATTRIBUTION_TEXT)) {
        failures.push(`Quellenhinweis fehlt: "${state.attribution}"`);
    }
    // Der rechtliche Hinweis ist freigabepflichtig: beide Plätze müssen ihn
    // tragen, der Dauerhinweis auch nach dem Start.
    // Seit dem 7.9.2026 steht er in derselben Zeile wie Quellen und
    // Kartenvermerk — geprüft wird, dass er enthalten ist.
    if (!state.disclaimer.includes(DISCLAIMER.short)) {
        failures.push(`Dauerhinweis fehlt: "${state.disclaimer}"`);
    }
    if (state.startDisclaimer !== DISCLAIMER.full) failures.push(`Hinweis vor dem Start fehlt: "${state.startDisclaimer}"`);
    if (state.bannerHidden !== !expectBannerVisible) failures.push(`Fehlerbanner sichtbar=${!state.bannerHidden}, erwartet ${expectBannerVisible}`);
    if (pageErrors.length > 0) failures.push(`JS-Fehler: ${pageErrors.join(' | ')}`);
    report(name, failures, `status="${state.status}"`);
}

/**
 * Der Bildschirm darf während der Fahrt nicht sperren.
 *
 * Geprüft wird nicht nur, dass die Sperre einmal angefordert wird, sondern
 * auch, dass sie **nach dem Wegschalten neu** angefordert wird: das System
 * gibt sie beim Wechsel in den Hintergrund von sich aus frei, und ohne
 * Neuanforderung wäre sie für den Rest der Fahrt verloren — ein Ausfall, der
 * erst am dunklen Gerät auffiele.
 */
async function testKeepsScreenAwake() {
    const {browser, page, pageErrors} = await openPage();
    await enterLiveMode(page);
    const nachStart = await page.evaluate(() => ({anzahl: window.__wakeCount, typ: window.__wakeType}));
    // Systemfreigabe beim Wegschalten und Rückkehr in den Vordergrund.
    await page.evaluate(() => {
        window.__wakeRelease.splice(0).forEach((cb) => cb());
        document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForFunction(() => window.__wakeCount >= 2, null, {timeout: 5000})
        .catch(() => {});
    const nachWechsel = await page.evaluate(() => window.__wakeCount);
    await browser.close();

    const failures = [];
    if (nachStart.anzahl < 1) failures.push('Bildschirmsperre wurde beim Start nie angefordert');
    if (nachStart.typ !== 'screen') failures.push(`Sperrtyp "${nachStart.typ}", erwartet "screen"`);
    if (nachWechsel < 2) failures.push('nach Systemfreigabe nicht neu angefordert — Sperre wäre verloren');
    if (pageErrors.length > 0) failures.push(`JS-Fehler: ${pageErrors.join(' | ')}`);
    report('Phase 5 — Bildschirm bleibt wach', failures, `angefordert ${nachWechsel}x`);
}

/**
 * Ein Fehlerbanner darf die Karte nicht dauerhaft verdecken: Antippen blendet
 * es aus. Geprüft am Terrain-Ausfall, weil der deterministisch auslösbar ist;
 * transiente Kartenfehler blenden sich zusätzlich nach `UI.transientBannerMs`
 * selbst aus.
 */
async function testBannerDismiss() {
    const {browser, page, pageErrors} = await openPage({layerJsonStatus: 500});
    await page.waitForFunction(
        () => document.getElementById('banner')?.hidden === false, null, {timeout: 30000});
    await page.click('#banner');
    const dismissed = await page.waitForFunction(
        () => document.getElementById('banner')?.hidden === true, null, {timeout: 5000})
        .then(() => true).catch(() => false);
    await browser.close();

    const failures = [];
    if (!dismissed) failures.push('Banner liess sich nicht wegtippen');
    if (pageErrors.length > 0) failures.push(`JS-Fehler: ${pageErrors.join(' | ')}`);
    report('Phase 1 — Fehlerbanner lässt sich wegtippen', failures);
}

/**
 * Luftfahrthindernisse liegen als Vektor vor, nicht als Raster: der WMS-Layer
 * stempelt „Last update" in jede Kachel. Geprüft wird, dass Punkte und Linien
 * ankommen, der Panel-Schalter greift — und dass der gestempelte Raster-Layer
 * nicht heimlich zurückkommt.
 */
async function testObstacles() {
    const {browser, page, pageErrors, wmtsRequests} = await openPage({withSensorHarness: true});
    await enterLiveMode(page);

    const state = await page.evaluate(new Function(`return (async () => {
        ${WAIT_UNTIL}
        window.__harness.emitFix({latitude: 46.588, longitude: 7.909, speed: 0});
        const loaded = await waitUntil(
            () => window.cockpit.map.querySourceFeatures('overlay-hindernisse').length > 0);
        const before = window.cockpit.obstacles.isVisible();
        window.cockpit.obstacles.setVisible(false);
        return {
            loaded,
            before,
            after: window.cockpit.obstacles.isVisible(),
            types: [...new Set(window.cockpit.map.querySourceFeatures('overlay-hindernisse')
                .map((f) => f.geometry.type))].sort(),
            hasLayers: ['overlay-hindernisse-point', 'overlay-hindernisse-line']
                .every((id) => !!window.cockpit.map.getLayer(id))
        };
    })()`));
    await browser.close();

    const failures = [];
    if (!state.loaded) failures.push('keine Hindernisse geladen');
    if (!state.hasLayers) failures.push('Punkt- oder Linienlayer fehlt');
    if (state.types.join() !== 'LineString,Point') failures.push(`Geometrietypen: ${state.types.join()}`);
    if (state.before !== true || state.after !== false) failures.push('Schalter greift nicht');
    if (wmtsRequests.has('ch.bazl.luftfahrthindernis')) {
        failures.push('der gestempelte WMS-Rasterlayer wird wieder angefragt');
    }
    if (pageErrors.length > 0) failures.push(`JS-Fehler: ${pageErrors.join(' | ')}`);
    report('Phase 4a — Luftfahrthindernisse als Vektor, ohne Kachelstempel', failures,
        `Geometrien: ${state.types.join(' + ')}`);
}

/**
 * Am iPad kam das Pinch-Zoom nicht an. Zwei Voraussetzungen: der Kartencontainer
 * muss `touch-action: none` tragen (sonst frisst Safari die Zwei-Finger-Geste als
 * Seiten-Zoom), und der Frame-Loop darf den Zoom nicht zurückstellen.
 */
async function testZoomStaysPinchable() {
    const {browser, page, pageErrors} = await openPage({withSensorHarness: true});
    await enterLiveMode(page);

    const state = await page.evaluate(new Function(`return (async () => {
        ${WAIT_UNTIL}
        window.__harness.emitFix({latitude: 46.588, longitude: 7.909, speed: 0});
        await waitUntil(() => Math.abs(window.cockpit.map.getCenter().lat - 46.588) < 1e-4);
        window.cockpit.map.setZoom(13.2);
        const start = performance.now();
        while (performance.now() - start < 1200) {
            window.__harness.emitFix({latitude: 46.588, longitude: 7.909, speed: 0});
            await new Promise((resolve) => requestAnimationFrame(resolve));
        }
        return {
            zoom: window.cockpit.map.getZoom(),
            touchAction: getComputedStyle(document.getElementById('map')).touchAction,
            pinchEnabled: window.cockpit.map.touchZoomRotate.isEnabled(),
            pitchEnabled: window.cockpit.map.touchPitch.isEnabled(),
            dragDisabled: !window.cockpit.map.dragPan.isEnabled()
        };
    })()`));
    await browser.close();

    const failures = [];
    if (state.touchAction !== 'none') failures.push(`#map hat touch-action: ${state.touchAction}`);
    if (!state.pinchEnabled) failures.push('touchZoomRotate ist im Folgen-Modus abgeschaltet');
    if (!state.pitchEnabled) failures.push('touchPitch ist im Folgen-Modus abgeschaltet — Neigung nicht bedienbar');
    if (!state.dragDisabled) failures.push('dragPan läuft im Folgen-Modus gegen die Kamera');
    if (Math.abs(state.zoom - 13.2) > 0.01) failures.push(`Frame-Loop hat den Zoom auf ${state.zoom.toFixed(2)} zurückgestellt`);
    if (pageErrors.length > 0) failures.push(`JS-Fehler: ${pageErrors.join(' | ')}`);
    report('Zoom bleibt dem Nutzer überlassen (Pinch am Gerät)', failures,
        `zoom=${state.zoom.toFixed(2)} touch-action=${state.touchAction}`);
}

/**
 * Ein rauschender Kompass darf die Karte nicht zittern lassen.
 *
 * Weil die Kamera vor dem eigenen Punkt steht, wird aus wenigen Grad Rauschen
 * ein sichtbarer Schwenk. Gemessen wird — wie beim Positionsrauschen — das
 * Verhältnis: wie viel vom Ausschlag des Sensors kommt am Kartenkurs an.
 */
async function testCompassNoiseDamped() {
    const {browser, page, pageErrors} = await openPage({withSensorHarness: true});
    await enterLiveMode(page);

    const messung = await page.evaluate(new Function(`return (async () => {
        ${WAIT_UNTIL}
        const map = window.cockpit.map;
        window.__harness.emitFix({latitude: 46.588, longitude: 7.909, speed: 0});
        window.__harness.emitCompass(90);
        await waitUntil(() => angleDelta(map.getBearing(), 90) < 3, 8000);

        // ±6° Rauschen um 90°, wie ein Magnetometer im Fahrzeug.
        const roh = [], kurs = [];
        for (let i = 0; i < 24; i++) {
            const wert = 90 + (i % 2 === 0 ? 6 : -6);
            roh.push(wert);
            window.__harness.emitCompass(wert);
            await new Promise((r) => setTimeout(r, 120));
            kurs.push(map.getBearing());
        }
        const spanne = (v) => Math.max(...v) - Math.min(...v);
        return {rohSpanne: spanne(roh), kursSpanne: spanne(kurs)};
    })()`));

    /*
     * Eine echte Drehung muss trotzdem ankommen — die Frist folgt der
     * Zeitkonstante, nicht einem festen Wert. Die Annäherung ist exponentiell:
     * nach 5 τ ist sie zu über 99 % durch. Mit fest verdrahteten 2,4 s schlug
     * der Test fehl, sobald `headingTauCompassSeconds` erhöht wurde — er hätte
     * dann die Dämpfung gemessen statt der Frage, ob die Drehung ankommt.
     */
    const drehFristMs = Math.round(5 * FOLLOW.headingTauCompassSeconds * 1000);
    const gedreht = await page.evaluate(new Function('frist', `return (async () => {
        ${WAIT_UNTIL}
        const map = window.cockpit.map;
        const bis = performance.now() + frist;
        while (performance.now() < bis) {
            window.__harness.emitCompass(180);
            await new Promise((r) => setTimeout(r, 60));
        }
        return map.getBearing();
    })()`), drehFristMs);
    await browser.close();

    const failures = [];
    const anteil = messung.kursSpanne / messung.rohSpanne;
    if (anteil > 0.35) failures.push(`Kurs folgt dem Rauschen zu ${(anteil * 100).toFixed(0)} % (erlaubt 35 %)`);
    const delta = Math.abs(((gedreht - 180 + 540) % 360) - 180);
    if (delta > 15) failures.push(`echte Drehung kam nicht an: ${gedreht.toFixed(0)}° statt 180°`);
    if (pageErrors.length > 0) failures.push(`JS-Fehler: ${pageErrors.join(' | ')}`);
    report('Kompassrauschen wird gedämpft, echte Drehung nicht', failures,
        `Rauschen ${messung.rohSpanne.toFixed(0)}° → Kurs ${messung.kursSpanne.toFixed(1)}° (${(anteil * 100).toFixed(0)} %)`);
}

/**
 * Die Kameraneigung darf der Gerätelage **nicht** folgen. Im Fahrzeug wackelt
 * das iPad, und die Ansicht wackelte mit; eingestellt wird sie mit zwei
 * Fingern und bleibt dann stehen. Dieser Test hält das fest.
 */
async function testTiltDoesNotMovePitch() {
    const {browser, page, pageErrors} = await openPage({withSensorHarness: true});
    await enterLiveMode(page);

    const state = await page.evaluate(new Function(`return (async () => {
        ${WAIT_UNTIL}
        const map = window.cockpit.map;
        window.__harness.emitFix({latitude: 46.588, longitude: 7.909, speed: 0});
        await new Promise((r) => setTimeout(r, 800));
        const vorher = map.getPitch();

        // Gerät kräftig kippen — von flach bis aufrecht.
        for (const beta of [10, 30, 60, 89, 45, 15]) {
            window.__harness.emitTilt(beta);
            await new Promise((r) => setTimeout(r, 250));
        }
        const nachKippen = map.getPitch();

        // Zwei-Finger-Geste dagegen muss wirken und danach stehen bleiben.
        map.setPitch(70);
        map.fire('pitch', {originalEvent: new Event('touchmove')});
        await new Promise((r) => setTimeout(r, 800));
        const nachGeste = map.getPitch();
        for (const beta of [20, 88]) {
            window.__harness.emitTilt(beta);
            await new Promise((r) => setTimeout(r, 400));
        }
        return {vorher, nachKippen, nachGeste, amEnde: map.getPitch()};
    })()`));
    await browser.close();

    const failures = [];
    if (Math.abs(state.nachKippen - state.vorher) > 1) {
        failures.push(`Kippen hat die Kamera bewegt: ${state.vorher.toFixed(1)}° → ${state.nachKippen.toFixed(1)}°`);
    }
    if (Math.abs(state.nachGeste - 70) > 2) {
        failures.push(`die Geste wirkte nicht: ${state.nachGeste.toFixed(1)}°, erwartet 70°`);
    }
    if (Math.abs(state.amEnde - state.nachGeste) > 1) {
        failures.push(`nach der Geste doch noch verrutscht: ${state.amEnde.toFixed(1)}°`);
    }
    if (pageErrors.length > 0) failures.push(`JS-Fehler: ${pageErrors.join(' | ')}`);
    report('Kameraneigung folgt nicht dem Gerät, nur der Fingergeste', failures,
        `${state.vorher.toFixed(0)}° trotz Kippen · Geste → ${state.nachGeste.toFixed(0)}° · bleibt ${state.amEnde.toFixed(0)}°`);
}

/**
 * Kamerahöhe über dem eigenen Punkt als eigener Regler — in Metern, weil das
 * im Cockpit die verständlichere Grösse ist als eine Zoomstufe.
 */
async function testHeightSlider() {
    const {browser, page, pageErrors} = await openPage({withSensorHarness: true});
    await enterLiveMode(page);
    await page.evaluate(() => window.__harness.emitFix({latitude: 46.588, longitude: 7.909, speed: 0}));
    await page.waitForTimeout(700);

    const lesen = () => page.evaluate(() => ({
        hoehe: window.cockpit.follow.cameraHeight(),
        zoom: window.cockpit.map.getZoom(),
        anzeige: document.getElementById('height-value').textContent
    }));
    const stellen = async (value) => {
        await page.evaluate((v) => {
            const el = document.getElementById('height');
            el.value = String(v);
            el.dispatchEvent(new Event('input', {bubbles: true}));
        }, value);
        await page.waitForTimeout(700);
        return lesen();
    };

    const tief = await stellen(10);
    const hoch = await stellen(90);
    // Der Regler muss dem Kneifen folgen, sonst zeigt er nach dem Zoomen Unsinn.
    // Hineinzoomen, damit die Höhe im Reglerbereich bleibt (hinaus liefe über
    // die Obergrenze und der Regler stünde berechtigt am Anschlag).
    await page.evaluate(() => window.cockpit.map.setZoom(window.cockpit.map.getZoom() + 1));
    await page.waitForTimeout(700);
    const nachZoom = await page.evaluate(() => Number(document.getElementById('height').value));
    const nachZoomHoehe = (await lesen()).hoehe;
    await browser.close();

    const failures = [];
    if (!(hoch.hoehe > tief.hoehe * 3)) {
        failures.push(`Regler wirkt kaum: ${Math.round(tief.hoehe)} m → ${Math.round(hoch.hoehe)} m`);
    }
    if (!(hoch.zoom < tief.zoom)) failures.push('höhere Kamera hat den Zoom nicht verkleinert');
    if (!/^\d+ m$/.test((tief.anzeige ?? '').trim())) failures.push(`Anzeige "${tief.anzeige}"`);
    // Nach dem Zoomen muss die Reglerstellung wieder zur Höhe passen.
    const erwartet = 100 * Math.log(nachZoomHoehe / FOLLOW.heightMinMeters)
        / Math.log(FOLLOW.heightMaxMeters / FOLLOW.heightMinMeters);
    if (Math.abs(nachZoom - erwartet) > 6) {
        failures.push(`Regler folgt dem Kneifen nicht: Stellung ${nachZoom}, erwartet ${erwartet.toFixed(0)}`);
    }
    if (pageErrors.length > 0) failures.push(`JS-Fehler: ${pageErrors.join(' | ')}`);
    report('Kamerahöhe als Regler in Metern, folgt auch dem Kneifen', failures,
        `${Math.round(tief.hoehe)} m → ${Math.round(hoch.hoehe)} m`);
}

/**
 * Der Kern der Sache: im Tracking-Modus müssen Kneifen und Zwei-Finger-Neigen
 * ankommen. Am Gerät taten sie es nicht — hier mit echten Touch-Ereignissen
 * nachgestellt statt über `setZoom`/`setPitch`, die den Gestenpfad umgehen.
 */
async function testFingerGesturesInTracking() {
    const {browser, page, pageErrors} = await openPage({withSensorHarness: true});
    await enterLiveMode(page);
    await page.evaluate(() => window.__harness.emitFix({latitude: 46.588, longitude: 7.909, speed: 0}));
    await page.waitForTimeout(600);

    // Von einer mittleren Neigung aus, sonst steht die Geste schon am Anschlag.
    // Über den Nutzerpfad (Pitch-Ereignis mit originalEvent), sonst schreibt
    // der Frame-Loop den Wert im nächsten Bild zurück.
    await page.evaluate(() => {
        const map = window.cockpit.map;
        map.setPitch(70);
        map.fire('pitch', {originalEvent: new Event('touchmove')});
    });
    await page.waitForTimeout(600);
    const before = await page.evaluate(() => ({zoom: window.cockpit.map.getZoom(), pitch: window.cockpit.map.getPitch()}));
    // Kneifen: beide Finger auseinander → hineinzoomen
    await twoFingerGesture(page, [{x: 200, y: 430}, {x: 230, y: 470}], [{x: 120, y: 330}, {x: 310, y: 570}]);
    const afterPinch = await page.evaluate(() => window.cockpit.map.getZoom());
    // Zwei Finger parallel nach oben → flacher stellen
    await twoFingerGesture(page, [{x: 190, y: 560}, {x: 250, y: 560}], [{x: 190, y: 360}, {x: 250, y: 360}]);
    const afterPitch = await page.evaluate(() => window.cockpit.map.getPitch());
    await browser.close();

    const failures = [];
    if (Math.abs(afterPinch - before.zoom) < 0.3) {
        failures.push(`Kneifen wirkungslos: Zoom ${before.zoom.toFixed(2)} → ${afterPinch.toFixed(2)}`);
    }
    if (Math.abs(afterPitch - before.pitch) < 3) {
        failures.push(`Zwei-Finger-Neigen wirkungslos: Pitch ${before.pitch.toFixed(1)}° → ${afterPitch.toFixed(1)}°`);
    }
    if (pageErrors.length > 0) failures.push(`JS-Fehler: ${pageErrors.join(' | ')}`);
    report('Finger-Gesten wirken im Tracking-Modus', failures,
        `Zoom ${before.zoom.toFixed(2)} → ${afterPinch.toFixed(2)} · Pitch ${before.pitch.toFixed(0)}° → ${afterPitch.toFixed(0)}°`);
}

/**
 * Im Manuell-Modus gehört die Kamera dem Finger: auch Verschieben muss gehen,
 * und der Frame-Loop darf die Karte nicht zurückziehen. Zurück auf Tracking
 * holt die Kamera wieder an die Position.
 */
async function testManualMode() {
    const {browser, page, pageErrors} = await openPage({withSensorHarness: true});
    await enterLiveMode(page);
    await page.evaluate(() => {
        window.cockpit.follow.setAnchor(0);
        window.__harness.emitFix({latitude: 46.588, longitude: 7.909, speed: 0});
    });
    await page.waitForTimeout(600);

    await page.click('#mode-manual');
    const handlers = await page.evaluate(() => ({
        dragPan: window.cockpit.map.dragPan.isEnabled(),
        rotate: window.cockpit.map.dragRotate.isEnabled(),
        following: window.cockpit.follow.isActive
    }));

    // Einfinger-Wisch: im Tracking gesperrt, hier muss er verschieben.
    const startCenter = await page.evaluate(() => window.cockpit.map.getCenter().lat);
    // Rechts der Info-Tafel wischen: der Tipp davor öffnet sie, und sie fängt
    // Zeigereignisse ab — im Test genau so aufgefallen.
    await page.touchscreen.tap(215, 450);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [{x: 360, y: 600}]});
    for (let i = 1; i <= 12; i++) {
        await cdp.send('Input.dispatchTouchEvent', {type: 'touchMove', touchPoints: [{x: 360, y: 600 - i * 15}]});
        await page.waitForTimeout(16);
    }
    await cdp.send('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []});
    await page.waitForTimeout(1200);
    const panned = await page.evaluate(() => window.cockpit.map.getCenter().lat);

    // Zurück auf Tracking: die Kamera kehrt zur Position zurück.
    await page.click('#mode-tracking');
    const returned = await page.evaluate(new Function(`return (async () => {
        ${WAIT_UNTIL}
        window.__harness.emitFix({latitude: 46.588, longitude: 7.909, speed: 0});
        const back = await waitUntil(() => Math.abs(window.cockpit.map.getCenter().lat - 46.588) < 1e-3);
        return {back, pressed: document.getElementById('mode-tracking').getAttribute('aria-pressed')};
    })()`));
    await browser.close();

    const failures = [];
    if (!handlers.dragPan) failures.push('Manuell: Verschieben ist gesperrt');
    if (!handlers.rotate) failures.push('Manuell: Drehen ist gesperrt');
    if (handlers.following) failures.push('Manuell: der Frame-Loop läuft weiter');
    if (Math.abs(panned - startCenter) < 1e-4) failures.push(`Manuell: Wischen hat nichts verschoben (${startCenter.toFixed(5)} → ${panned.toFixed(5)})`);
    if (!returned.back) failures.push('Tracking: Kamera kehrt nicht zur Position zurück');
    if (returned.pressed !== 'true') failures.push('Modusanzeige stimmt nicht');
    if (pageErrors.length > 0) failures.push(`JS-Fehler: ${pageErrors.join(' | ')}`);
    report('Manuell-Modus: Finger führt, Tracking holt zurück', failures,
        `verschoben ${startCenter.toFixed(4)} → ${panned.toFixed(4)}`);
}

/**
 * Geländeschatten (12.9.2026): nur im Manuell-Modus bedienbar — im Tracking
 * bräuchte er eine Neuberechnung im Frame-Takt statt einmal je Kamerastillstand
 * (siehe SHADOW in config.js). Prüft die Verdrahtung, nicht die Verdeckung an
 * echtem Gelände — das gestubbte Terrain ist überall gleich hoch.
 */
async function testShadowModeGating() {
    const {browser, page, pageErrors} = await openPage({withSensorHarness: true});
    await enterLiveMode(page);

    const trackingHidden = await page.evaluate(() => document.getElementById('shadow-toggle').hidden);

    await page.click('#mode-manual');
    const manualVisible = await page.evaluate(() => !document.getElementById('shadow-toggle').hidden);

    await page.evaluate(async () => {
        window.cockpit.shadow.setEnabled(true);
        await window.cockpit.shadow.waitForIdle();
    });
    const layerWhileManual = await page.evaluate(() => !!window.cockpit.map.getLayer('shadow'));

    await page.click('#mode-tracking');
    const layerAfterTracking = await page.evaluate(() => !!window.cockpit.map.getLayer('shadow'));
    const toggleHiddenAgain = await page.evaluate(() => document.getElementById('shadow-toggle').hidden);
    const enabledAfterTracking = await page.evaluate(() => window.cockpit.shadow.isEnabled);

    await browser.close();

    const failures = [];
    if (!trackingHidden) failures.push('Schalter im Tracking sichtbar');
    if (!manualVisible) failures.push('Schalter im Manuell-Modus nicht sichtbar');
    if (!layerWhileManual) failures.push('Schattenlayer erscheint im Manuell-Modus nicht');
    if (layerAfterTracking) failures.push('Schattenlayer bleibt nach Rückkehr ins Tracking stehen');
    if (!toggleHiddenAgain) failures.push('Schalter nach Rückkehr ins Tracking noch sichtbar');
    if (enabledAfterTracking) failures.push('Schatten gilt nach Rückkehr ins Tracking noch als eingeschaltet');
    if (pageErrors.length > 0) failures.push(`JS-Fehler: ${pageErrors.join(' | ')}`);
    report('Geländeschatten: nur im Manuell-Modus, geht beim Wechsel wieder aus', failures);
}

/**
 * Mit dem gestubbten Terrain (durchweg HTTP 403, siehe openPage) liegt überall
 * dieselbe flache Ersatzhöhe — ein Sonnenstrahl kann dort nirgends verdeckt
 * werden. Nachts (Sonne unter dem Horizont) muss dagegen die ganze Fläche
 * verschattet sein. Beides ist mit gestubbten Daten ehrlich prüfbar; echte
 * Verdeckung an echtem Gelände braucht den Gerätetest.
 */
async function testShadowFlatTerrain() {
    const {browser, page, pageErrors} = await openPage({withSensorHarness: true});
    await enterLiveMode(page);
    await page.click('#mode-manual');

    async function alphaSum(iso) {
        return page.evaluate(async (isoInner) => {
            // Immer über den Aus-Ein-Weg, nicht über `setDate()` allein: der
            // ist debounced (siehe SHADOW.debounceMs), `setEnabled(true)`
            // rechnet sofort — nur dafür wartet `waitForIdle()` zuverlässig.
            window.cockpit.shadow.setEnabled(false);
            window.cockpit.shadow.setDate(new Date(isoInner));
            window.cockpit.shadow.setEnabled(true);
            await window.cockpit.shadow.waitForIdle();
            const url = window.cockpit.shadow.lastImageUrl;
            const img = await new Promise((resolve, reject) => {
                const image = new Image();
                image.onload = () => resolve(image);
                image.onerror = reject;
                image.src = url;
            });
            const canvas = document.createElement('canvas');
            canvas.width = img.width;
            canvas.height = img.height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0);
            const {data} = ctx.getImageData(0, 0, canvas.width, canvas.height);
            let sum = 0;
            for (let i = 3; i < data.length; i += 4) sum += data[i];
            return sum;
        }, iso);
    }

    // Sommersonnenwende, Mittag bzw. tiefe Nacht am Ort der Testposition
    // (46,588° N/7,909° O, Lauterbrunnental) — beides eindeutig, kein
    // Dämmerungsgrenzfall.
    const dayAlpha = await alphaSum('2026-06-21T12:00');
    const nightAlpha = await alphaSum('2026-06-21T00:30');
    await browser.close();

    const failures = [];
    if (dayAlpha !== 0) failures.push(`Mittags über flachem Ersatzgelände dennoch Schatten (Alpha-Summe ${dayAlpha})`);
    if (nightAlpha === 0) failures.push('Nachts kein Schatten — Sonnenhöhe müsste negativ sein');
    if (pageErrors.length > 0) failures.push(`JS-Fehler: ${pageErrors.join(' | ')}`);
    report('Geländeschatten: flaches Ersatzgelände bleibt tagsüber frei, nachts ganz verschattet', failures,
        `Alpha-Summe Tag ${dayAlpha} · Nacht ${nightAlpha}`);
}

/**
 * Blauer Punkt mit Richtungspfeil und der Weg zurück: im Manuell-Modus zeigt
 * der Marker, wo man steht, und „Zu mir" holt die Karte dorthin, ohne den
 * Modus zu wechseln.
 */
async function testPositionMarker() {
    const {browser, page, pageErrors} = await openPage({withSensorHarness: true});
    await enterLiveMode(page);
    await page.evaluate(() => {
        window.cockpit.follow.setAnchor(0);
        window.__harness.emitCompass(120);
        window.__harness.emitFix({latitude: 46.588, longitude: 7.909, speed: 0});
    });
    await page.waitForTimeout(800);

    /*
     * Der eigene Standort ist seit dem 7.9.2026 ein DOM-Marker, keine
     * Symbolebene: mit `padding` zeichnet MapLibre Symbole nicht mehr sichtbar.
     * Geprüft wird deshalb das Element und die Bildstelle, an der es sitzt —
     * und die muss unabhängig von der Blickrichtung dieselbe sein.
     */
    const marker = await page.evaluate(async () => {
        const {map} = window.cockpit;
        const el = document.getElementById('me-marker');
        const W = map.getCanvas().clientWidth;
        const lagen = [];
        for (const kurs of [30, 120, 210, 300]) {
            window.__harness.emitCompass(kurs);
            await new Promise((r) => setTimeout(r, 700));
            const b = el.getBoundingClientRect();
            lagen.push({x: (b.left + b.right) / 2 / W * 100,
                        y: (b.top + b.bottom) / 2 / map.getCanvas().clientHeight * 100});
        }
        const xs = lagen.map((l) => l.x), ys = lagen.map((l) => l.y);
        return {
            vorhanden: !!el,
            xSpanne: Math.max(...xs) - Math.min(...xs),
            ySpanne: Math.max(...ys) - Math.min(...ys),
            xMittel: xs.reduce((a, b) => a + b, 0) / xs.length,
            buttonHiddenImTracking: document.getElementById('recenter').hidden
        };
    });

    // Im Manuell-Modus wegschauen, dann „Zu mir" drücken.
    await page.click('#mode-manual');
    await page.evaluate(() => window.cockpit.map.jumpTo({center: [7.95, 46.62]}));
    await page.click('#recenter');
    /*
     * Auf das Ende der Bewegung warten, nicht auf die Uhr. `recenter` fährt mit
     * `easeTo` über 600 ms; unter Last startet das später, und mit einer festen
     * Wartezeit wurde mitten in der Fahrt gemessen — der Test fiel dann mit
     * rund 86 % des Weges aus, ohne dass etwas kaputt war.
     */
    await page.waitForFunction(() => !window.cockpit.map.isMoving(), null, {timeout: 10000})
        .catch(() => {});
    await page.waitForTimeout(300);
    const back = await page.evaluate(() => ({
        center: window.cockpit.map.getCenter(),
        stillManual: !window.cockpit.follow.isActive
    }));
    await browser.close();

    const failures = [];
    if (!marker.vorhanden) failures.push('kein Positionsmarker im Dokument');
    /*
     * **Der Kern der Zusage:** der eigene Punkt ist der Drehpunkt. Über vier
     * Blickrichtungen darf sich seine Bildstelle nicht verschieben — vor dem
     * Umbau auf `padding` wanderte er dabei bis zu 20 % der Bildbreite.
     */
    if (marker.xSpanne > 1.5) failures.push(`wandert waagrecht um ${marker.xSpanne.toFixed(1)} % beim Drehen`);
    if (marker.ySpanne > 1.5) failures.push(`wandert senkrecht um ${marker.ySpanne.toFixed(1)} % beim Drehen`);
    if (Math.abs(marker.xMittel - 50) > 2) {
        failures.push(`sitzt bei ${marker.xMittel.toFixed(1)} % der Breite statt mittig`);
    }
    // Umgekehrte Erwartung seit dem 5.9.2026: im Tracking ist der Knopf
    // gewollt verborgen, im Manuell-Modus muss er erscheinen.
    if (!marker.buttonHiddenImTracking) failures.push('„Zu mir" erscheint schon im Tracking');
    if (Math.abs(back.center.lat - 46.588) > 1e-3 || Math.abs(back.center.lng - 7.909) > 1e-3) {
        failures.push(`„Zu mir" hat nicht zentriert: ${back.center.lat.toFixed(4)}/${back.center.lng.toFixed(4)}`);
    }
    if (!back.stillManual) failures.push('„Zu mir" hat den Modus gewechselt');
    if (pageErrors.length > 0) failures.push(`JS-Fehler: ${pageErrors.join(' | ')}`);
    report('Eigene Position: Punkt, Richtungspfeil und „Zu mir"', failures,
        `waagrecht ${marker.xMittel.toFixed(1)} %, Wanderung ${marker.xSpanne.toFixed(1)}/${marker.ySpanne.toFixed(1)} %`);
}

/**
 * Kameralage: der Regler schiebt den eigenen Standort im Bild nach unten, bis
 * die Kamera praktisch auf ihm steht. Der Zoom darf dabei unberührt bleiben —
 * genau darum geht es: von der gewählten Lage aus weiterzoomen können.
 */
async function testCameraAnchor() {
    const {browser, page, pageErrors} = await openPage({withSensorHarness: true});
    await enterLiveMode(page);
    await page.evaluate(() => {
        // Von der Übersicht aus messen; Vorgabe der App ist 0,6.
        window.cockpit.follow.setAnchor(0);
        document.getElementById('anchor').value = '0';
        window.__harness.emitCompass(0);
        window.__harness.emitFix({latitude: 46.588, longitude: 7.909, speed: 0});
    });
    await page.waitForTimeout(700);

    const measure = () => page.evaluate(() => {
        const map = window.cockpit.map;
        const p = map.project([7.909, 46.588]);
        return {y: p.y / map.getCanvas().clientHeight, zoom: map.getZoom()};
    });
    const uebersicht = await measure();

    await page.evaluate(() => {
        const el = document.getElementById('anchor');
        el.value = '100';
        el.dispatchEvent(new Event('input', {bubbles: true}));
    });
    // Die Bildlage wird gemessen nachgeführt (Gelände) — das braucht ein paar
    // Takte, nicht nur einen Frame.
    await page.waitForTimeout(2500);
    const amStandort = await measure();
    const label = await page.textContent('#anchor-value');

    /*
     * Von dort aus zoomen: die Lage muss bleiben — aber nur, solange der
     * Ankerversatz unter `anchorMaxOffsetMeters` bleibt. Zoom 16 hält die
     * Kamera niedrig genug; bei 14 greift der Deckel und der Punkt wandert
     * absichtlich zur Bildmitte (dafür gibt es die eigene Prüfung unten).
     */
    await page.evaluate(() => window.cockpit.map.setZoom(16));
    await page.waitForTimeout(2500);
    const nachZoom = await measure();

    /*
     * Und der Deckel selbst: weit heraus muss der eigene Punkt spürbar zur
     * Bildmitte rücken. Ohne diese Grenze wuchs der Hebel mit der Kamerahöhe,
     * und jede Kompassstufe schwenkte das Bild um Hunderte Meter zur Seite.
     */
    const beiGrosserHoehe = await page.evaluate(async () => {
        window.cockpit.map.setZoom(13);
        await new Promise((r) => setTimeout(r, 2500));
        const map = window.cockpit.map;
        return (map.project([7.909, 46.588]).y / map.getCanvas().clientHeight) * 100;
    });

    // Der Versatz steckt in einer Formel mit gemessenem Faktor. Dieser Durchlauf
    // hält fest, dass sie über Neigung und Zoom trägt — driftet der Faktor,
    // wandert der Standort aus seiner Bildlage.
    const matrix = await page.evaluate(new Function(`return (async () => {
        ${WAIT_UNTIL}
        const map = window.cockpit.map;
        const follow = window.cockpit.follow;
        const H = map.getCanvas().clientHeight;
        const out = [];
        /*
         * Betriebsbereich, alle drei unter dem Ankerdeckel — hier wird die
         * Formel geprüft, nicht die Begrenzung.
         *
         * 85 Grad ist bewusst nicht mehr dabei: die Rechnung arbeitet auf der
         * Kartenebene, project() dagegen auf dem Gelände. Bei fast
         * waagrechtem Blick laufen beide auseinander — gemessen über Talboden
         * 80 % bei 60° und 70°, 79 % bei 74°, 77 % bei 80°, aber nur 68 % bei
         * 85°. Der Betriebswert ist 80°.
         */
        for (const [pitch, zoom] of [[60, 14], [74, 16.5], [80, 15.5]]) {
            follow.setAnchor(0.6);
            map.jumpTo({zoom});
            // Neigung als Nutzergeste setzen: so übernimmt der Controller sie
            // als Zielwert, statt sie im nächsten Bild zu überschreiben.
            map.setPitch(pitch);
            map.fire('pitch', {originalEvent: new Event('touchmove')});
            await waitUntil(() => Math.abs(map.getPitch() - pitch) < 1.5, 6000);
            await new Promise((r) => setTimeout(r, 2500));
            out.push({pitch, zoom, ist: (map.project([7.909, 46.588]).y / H) * 100});
        }
        return out;
    })()`));
    await browser.close();

    const failures = [];
    if (Math.abs(uebersicht.y - 0.5) > 0.05) failures.push(`Übersicht: Standort bei ${(uebersicht.y * 100).toFixed(0)} % statt 50 %`);
    /*
     * Anker 1 heisst nicht mehr „unterer Bildrand", sondern die sichtbare
     * Unterkante über den Hinweisleisten — sonst steht der Pfeil hinter ihnen
     * oder ganz ausserhalb (siehe FOLLOW.anchorMaxAnteil). Erwartung aus der
     * Konstanten abgeleitet statt fest verdrahtet, damit sie mitwandert.
     */
    const anchorSoll = FOLLOW.anchorMaxAnteil * 100;
    if (Math.abs(amStandort.y * 100 - anchorSoll) > 4) {
        failures.push(`Am Standort: ${(amStandort.y * 100).toFixed(0)} % statt ${anchorSoll.toFixed(0)} %`);
    }
    // Der Hinweisbalken steht seit dem 7.9.2026 oben; unten ist frei, und der
    // Pfeil soll dort auch hin. Nur ganz aus dem Bild darf er nicht.
    if (amStandort.y * 100 > 99) {
        failures.push(`Am Standort bei ${(amStandort.y * 100).toFixed(0)} % — ausserhalb des Bildes`);
    }
    if (Math.abs(amStandort.zoom - uebersicht.zoom) > 0.01) failures.push('der Regler hat den Zoom verändert');
    if (Math.abs(nachZoom.y - amStandort.y) > 0.05) failures.push(`nach dem Zoomen verrutscht: ${(nachZoom.y * 100).toFixed(0)} %`);
    /*
     * **Der Deckel soll seit dem 7.9.2026 gerade nicht mehr greifen.** Er hielt
     * den eigenen Punkt bei steiler Neigung von seiner Sollposition ab und
     * schob dafür die Kamera kilometerweit zurück. Geprüft wird jetzt das
     * Gegenteil: der Punkt bleibt auch weit herausgezoomt unten im Bild.
     */
    if (beiGrosserHoehe < 60) {
        failures.push(`Bei z13 nur ${beiGrosserHoehe.toFixed(0)} % — der Punkt sollte unten bleiben`);
    }
    if (beiGrosserHoehe > 99) {
        failures.push(`Bei z13 ${beiGrosserHoehe.toFixed(0)} % — ausserhalb des Bildes`);
    }
    if (label !== 'Standort') failures.push(`Beschriftung "${label}"`);
    // Bildmitte plus der halbe wirksame Ankerwert; wirksam ist der Regler mal
    // der Spanne bis zur sichtbaren Unterkante. Toleranz grosszügig, weil
    // Neigung und Zoom im Testfenster noch einlaufen.
    const matrixSoll = (0.5 + 0.6 * (2 * FOLLOW.anchorMaxAnteil - 1) * 0.5) * 100;
    for (const row of matrix) {
        if (Math.abs(row.ist - matrixSoll) > 6) {
            failures.push(`Anker 0,6 bei P${row.pitch}°/z${row.zoom}: ${row.ist.toFixed(0)} % statt ${matrixSoll.toFixed(0)} %`);
        }
    }
    if (pageErrors.length > 0) failures.push(`JS-Fehler: ${pageErrors.join(' | ')}`);
    report('Kameralage: Übersicht bis zum eigenen Punkt, Deckel greift in der Höhe', failures,
        `${(uebersicht.y * 100).toFixed(0)} % → ${(amStandort.y * 100).toFixed(0)} % → nach Zoom ${(nachZoom.y * 100).toFixed(0)} %`);
}

/**
 * Antippen beantwortet „was gilt hier?": die Regel steht in den Sachdaten der
 * Layer, nicht im Rasterbild. Geprüft wird, dass der Text ankommt und dass ein
 * Leertreffer ausdrücklich nicht als Freigabe erscheint.
 */
async function testTapInfo() {
    const {browser, page, pageErrors} = await openPage({withSensorHarness: true});
    await enterLiveMode(page);
    await page.evaluate(() => window.__harness.emitFix({latitude: 46.588, longitude: 7.909, speed: 0}));
    await page.waitForTimeout(500);

    await page.evaluate(() => window.cockpit.map.fire('click', {
        lngLat: {lng: 7.909, lat: 46.588},
        /*
         * MapLibres `Marker` hängt einen eigenen Klick-Handler ein und liest
         * `originalEvent.target`. Seit der eigene Standort ein Marker ist
         * (7.9.2026), braucht ein synthetischer Klick dieses Feld — sonst
         * stirbt der Handler und mit ihm der Test.
         */
        originalEvent: {target: window.cockpit.map.getCanvas()}
    }));
    await page.waitForFunction(
        () => document.getElementById('info')?.hidden === false
            && !document.getElementById('info-body').textContent.includes('Wird geprüft'),
        null, {timeout: 15000});
    const text = (await page.textContent('#info-body')).replace(/\s+/g, ' ');
    await page.click('#info-close');
    const closed = await page.evaluate(() => document.getElementById('info').hidden);
    await browser.close();

    const failures = [];
    if (!text.includes('CTR TEST')) failures.push(`kein Zonenname: "${text.slice(0, 90)}"`);
    // Der Dienst liefert die Zone dreifach — das Panel darf sie einmal zeigen.
    const nennungen = (text.match(/CTR TEST/g) ?? []).length;
    if (nennungen !== 1) failures.push(`Zone ${nennungen}× gelistet statt einmal`);
    if (!text.includes('250 g')) failures.push('der Regeltext mit Gewicht und Höhe fehlt');
    if (!text.includes('120')) failures.push('die Höhenangabe fehlt');
    // Zuoberst muss stehen, worum es sich handelt — ein Name allein sagt nicht,
    // ob es eine Drohnenzone, eine Wildruhezone oder ein Mast ist.
    if (!text.includes('Geografische UAS-Gebiete')) failures.push('die Layer-Bezeichnung fehlt über dem Treffer');
    // Die amtlichen Beschriftungen, nicht nur der Freitext.
    ['Einschränkung', 'Untergrenze', 'Weitere Informationen'].forEach((label) => {
        if (!text.includes(label)) failures.push(`Beschriftung „${label}" fehlt`);
    });
    // Leere Felder gehören nicht ins Cockpit.
    if (text.includes('Zusatzinformationen')) failures.push('leeres Feld wird trotzdem angezeigt');
    if (!closed) failures.push('Panel liess sich nicht schliessen');
    if (pageErrors.length > 0) failures.push(`JS-Fehler: ${pageErrors.join(' | ')}`);
    report('Antippen zeigt die Regel am Ort (Gewicht, Höhe, Zuständigkeit)', failures,
        text.slice(0, 96));
}

/**
 * Ein Layer ohne Sachdatentabelle darf die Antippen-Info nicht mitreissen.
 *
 * Der Dienst beantwortet alle sichtbaren Layer in *einer* Anfrage. Steht darin
 * ein Layer ohne Tabelle (der Nationalpark ist so einer), antwortet er mit
 * „No GeoTable was found" und HTTP 400 — dann fiele das Antippen für *jeden*
 * Layer aus. Am echten Dienst nachgemessen, deshalb dieser Test: er hält fest,
 * dass solche Layer gar nicht erst mitgeschickt werden.
 */
async function testUnqueryableLayerStaysOutOfIdentify() {
    // Einen echten Layer künstlich als nicht abfragbar markieren, statt auf
    // einen solchen in der Konfiguration zu hoffen: der Mechanismus muss auch
    // dann geprüft sein, wenn gerade kein Layer dieser Art eingetragen ist.
    const OPFER = 'ch.swisstopo.swisstlm3d-uebrigerverkehr';
    const {browser, page} = await openPage({
        withSensorHarness: true,
        // Robust gegen weitere Felder im Eintrag (etwa `opacity`): an der
        // schliessenden Klammer des Layers ansetzen, nicht an einem festen
        // Wortlaut.
        configPatch: (source) => source.replace(
            new RegExp(`(layer: '${OPFER}'[^}]*)\\}`),
            '$1, queryable: false}')
    });
    const identifyUrls = [];
    page.on('request', (request) => {
        if (request.url().includes('/identify')) identifyUrls.push(decodeURIComponent(request.url()));
    });
    await enterLiveMode(page);
    await page.evaluate(() => window.__harness.emitFix({latitude: 46.588, longitude: 7.909, speed: 0}));
    await page.waitForTimeout(500);
    await page.evaluate(() => window.cockpit.map.fire('click', {
        lngLat: {lng: 7.909, lat: 46.588},
        /*
         * MapLibres `Marker` hängt einen eigenen Klick-Handler ein und liest
         * `originalEvent.target`. Seit der eigene Standort ein Marker ist
         * (7.9.2026), braucht ein synthetischer Klick dieses Feld — sonst
         * stirbt der Handler und mit ihm der Test.
         */
        originalEvent: {target: window.cockpit.map.getCanvas()}
    }));
    await page.waitForFunction(
        () => document.getElementById('info')?.hidden === false
            && !document.getElementById('info-body').textContent.includes('Wird geprüft'),
        null, {timeout: 15000});
    const text = (await page.textContent('#info-body')).replace(/\s+/g, ' ');
    await browser.close();

    const tapQueries = identifyUrls.filter((url) => url.includes('esriGeometryPoint'));
    const failures = [];
    if (tapQueries.length === 0) failures.push('keine Antippen-Abfrage abgesetzt');
    if (tapQueries.some((url) => url.includes(OPFER))) {
        failures.push(`${OPFER} wurde trotz queryable:false mitgeschickt`);
    }
    // Die übrigen Layer müssen weiterhin abgefragt werden — sonst wäre der
    // Filter zu scharf und das Panel bliebe leer.
    if (!tapQueries.some((url) => url.includes('ch.bazl.einschraenkungen-drohnen'))) {
        failures.push('die abfragbaren Layer fehlen in der Anfrage');
    }
    if (!text.includes('CTR TEST')) failures.push(`Antippen lieferte nichts: "${text.slice(0, 80)}"`);
    report('Layer ohne Sachdaten reisst die Antippen-Info nicht mit', failures,
        `${OPFER.split('.').pop()} ausgeschlossen, ${tapQueries.length} Abfrage(n)`);
}

/**
 * Phase 5: als PWA installierbar und ohne Netz startfähig. Der Service-Worker
 * wird hier ausdrücklich zugelassen — in allen anderen Tests ist er blockiert,
 * weil er sonst deren Routen aus seinem Cache beantwortet.
 */
async function testProgressiveWebApp() {
    const browser = await chromium.launch({
        args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox']
    });
    const page = await browser.newPage({viewport: {width: 430, height: 900}, serviceWorkers: 'allow'});
    await page.goto(BASE_URL, {waitUntil: 'load'});
    const registered = await page.evaluate(async () => {
        const registration = await navigator.serviceWorker.ready;
        return !!registration.active;
    }).catch(() => false);

    const manifest = await page.evaluate(async () => {
        const href = document.querySelector('link[rel=manifest]')?.getAttribute('href');
        if (!href) return null;
        const response = await fetch(href);
        return response.ok ? response.json() : null;
    });

    // Netz kappen und neu laden: die Hülle muss aus dem Cache kommen.
    await page.context().setOffline(true);
    let offlineOk = false;
    try {
        await page.reload({waitUntil: 'domcontentloaded', timeout: 20000});
        offlineOk = await page.evaluate(() => !!document.getElementById('start-button'));
    } catch {
        offlineOk = false;
    }
    await page.context().setOffline(false);
    await browser.close();

    const failures = [];
    if (!registered) failures.push('Service-Worker nicht aktiv');
    if (!manifest) failures.push('Manifest nicht abrufbar');
    else {
        if (manifest.display !== 'standalone') failures.push(`display: ${manifest.display}`);
        if (!(manifest.icons ?? []).some((i) => i.sizes === '512x512')) failures.push('512er-Icon fehlt');
        if (!manifest.start_url) failures.push('start_url fehlt');
    }
    if (!offlineOk) failures.push('ohne Netz kommt die App-Hülle nicht');
    report('Phase 5 — installierbar und ohne Netz startfähig', failures,
        manifest ? `${manifest.short_name}, ${manifest.icons.length} Icons` : '—');
}

/**
 * Ohne Build-Schritt zählt der Service-Worker seine Dateien von Hand auf. Ein
 * neues Modul fiele also stillschweigend aus dem Offline-Vorrat — und das
 * merkte man erst im Funkloch. Dieser Test vergleicht die Liste mit dem
 * Verzeichnis; er braucht keinen Browser.
 */
async function testShellListComplete() {
    const {readFileSync, readdirSync} = await import('node:fs');
    const {fileURLToPath} = await import('node:url');
    const root = fileURLToPath(new URL('..', import.meta.url));
    const sw = readFileSync(`${root}sw.js`, 'utf8');
    const shell = [...sw.matchAll(/'(\.\/[^']+)'/g)].map((m) => m[1]);
    const missing = readdirSync(`${root}src`)
        .filter((name) => name.endsWith('.js'))
        .map((name) => `./src/${name}`)
        .filter((path) => !shell.includes(path));

    const failures = missing.map((path) => `${path} fehlt in der Service-Worker-Liste`);
    report('Offline-Vorrat deckt alle Module ab', failures, `${shell.length} Einträge`);
}

/**
 * Vorladen in Fahrtrichtung.
 *
 * Die Schwierigkeit beim Prüfen: an der eigenen Position fordert MapLibre
 * ohnehin Kacheln an, vorgeladene wären davon nicht zu unterscheiden. Deshalb
 * wird die Karte hier weit weggeschoben (Manuell-Modus, 120 km östlich) und
 * die Fahrt läuft weiter: was danach noch an der *Fahrposition* angefordert
 * wird, kann nur vom Vorladen kommen.
 */
async function testPrefetchAhead() {
    const {browser, page} = await openPage({withSensorHarness: true});
    const requested = [];
    page.on('request', (request) => requested.push(request.url()));
    await enterLiveMode(page);

    const START = {lat: 46.588, lng: 7.909};
    await page.evaluate((start) => window.__harness.emitFix(
        {latitude: start.lat, longitude: start.lng, speed: 30, heading: 0}), START);
    await page.waitForTimeout(500);

    // Karte weg von der Fahrt — ab hier lädt MapLibre nur noch dort, wo es
    // hinschaut, nicht mehr dort, wo gefahren wird.
    await page.evaluate(() => {
        window.cockpit.follow.stop();
        window.cockpit.map.jumpTo({center: [9.5, 47.4], zoom: 15, pitch: 0});
    });
    await page.waitForTimeout(2000);
    requested.length = 0;

    // Weiterfahren nach Norden: über der Drosselschwelle in Zeit und Strecke.
    for (let step = 1; step <= 3; step++) {
        await page.evaluate(([start, n]) => window.__harness.emitFix({
            latitude: start.lat + (n * 400) / 110540, longitude: start.lng, speed: 30, heading: 0
        }), [START, step]);
        await page.waitForTimeout(1600);
    }
    await page.waitForTimeout(1000);
    await browser.close();

    // Kachelkoordinaten zurückrechnen: liegt eine angeforderte Kachel auf der
    // Fahrtlinie statt beim Kartenausschnitt, war es das Vorladen.
    const ahead = requested
        .map((url) => url.match(/\/3857\/(\d+)\/(\d+)\/(\d+)\.jpeg/))
        .filter(Boolean)
        .map(([, z, x, y]) => {
            const n = 2 ** Number(z);
            return {
                lng: (Number(x) / n) * 360 - 180,
                lat: (180 / Math.PI) * Math.atan(Math.sinh(Math.PI * (1 - (2 * Number(y)) / n)))
            };
        })
        .filter((tile) => Math.abs(tile.lng - START.lng) < 0.2 && tile.lat > START.lat);

    const failures = [];
    if (ahead.length === 0) {
        failures.push('keine Kachel in Fahrtrichtung geholt, während die Karte anderswo stand');
    }
    // Der Vorlauf soll vorausliegen, nicht irgendwo: grob die konfigurierte
    // Strecke, mit Luft für Kachelraster und zurückgelegten Weg.
    const maxAheadDegrees = (3 * PREFETCH.aheadMeters) / 110540;
    if (ahead.some((tile) => tile.lat - START.lat > maxAheadDegrees)) {
        failures.push('Vorladen greift viel zu weit voraus');
    }
    report('Vorladen holt die Kacheln in Fahrtrichtung', failures,
        `${ahead.length} Kacheln voraus, max ${(Math.max(0, ...ahead.map((t) => (t.lat - START.lat) * 110540))).toFixed(0)} m`);
}

/**
 * Referenztempo 120 km/h: die Hindernisse müssen nachkommen, ohne dass im
 * Stand Dauerfeuer entsteht. Geprüft werden beide Enden — eine Strecke von
 * gut einer Bildbreite löst prompt neue Daten aus, Stillstand nicht.
 */
async function testRefreshKeepsUpAtSpeed() {
    const {browser, page, pageErrors, identifyCalls} = await openPage({withSensorHarness: true});
    await enterLiveMode(page);
    await page.evaluate(() => window.__harness.emitFix({latitude: 46.588, longitude: 7.909, speed: 0}));
    await page.waitForTimeout(1500);
    const afterStart = identifyCalls();

    // Stillstand: fünf Sekunden lang Fixes auf derselben Stelle.
    for (let i = 0; i < 5; i++) {
        await page.evaluate(() => window.__harness.emitFix({latitude: 46.588, longitude: 7.909, speed: 0}));
        await page.waitForTimeout(1000);
    }
    const afterIdle = identifyCalls();

    // 120 km/h = 33 m/s, zehn Sekunden Fahrt nach Norden: gut 330 m.
    for (let i = 1; i <= 10; i++) {
        await page.evaluate((step) => window.__harness.emitFix({
            latitude: 46.588 + (step * 33) / 110540, longitude: 7.909, speed: 33.3, heading: 0
        }), i);
        await page.waitForTimeout(1000);
    }
    await page.waitForTimeout(1000);
    const afterDrive = identifyCalls();
    await browser.close();

    const failures = [];
    if (afterIdle - afterStart > 1) failures.push(`im Stand ${afterIdle - afterStart} Abfragen in 5 s — Dauerfeuer`);
    if (afterDrive - afterIdle < 1) failures.push('bei 120 km/h wurde über 330 m nichts nachgeladen');
    if (afterDrive - afterIdle > 8) failures.push(`bei 120 km/h ${afterDrive - afterIdle} Abfragen in 10 s — zu viel`);
    if (pageErrors.length > 0) failures.push(`JS-Fehler: ${pageErrors.join(' | ')}`);
    report('Nachladen hält bei 120 km/h Schritt, ohne im Stand zu feuern', failures,
        `Stand +${afterIdle - afterStart} · Fahrt +${afterDrive - afterIdle}`);
}

// --- Phase 2 ---------------------------------------------------------------

/**
 * Wartet im Seitenkontext auf eine Bedingung, getaktet über echte Frames.
 * Feste Wartezeiten taugen hier nicht: der Software-Renderer schafft nur
 * wenige fps, auf dem Gerät sind es 60.
 */
const WAIT_UNTIL = `
    const waitUntil = async (predicate, timeoutMs = 15000) => {
        const start = performance.now();
        while (performance.now() - start < timeoutMs) {
            if (predicate()) return true;
            await new Promise((resolve) => requestAnimationFrame(resolve));
        }
        return false;
    };
    const angleDelta = (a, b) => Math.abs(((b - a + 540) % 360) - 180);
    /*
     * Erlaubte Restabweichung: das Totband lässt bauartbedingt bis zu
     * headingDeadbandDegrees stehen, Änderungen darunter werden bewusst
     * verworfen. Eine feste 2-Grad-Schranke war deshalb unerfüllbar, sobald das
     * Totband darüber lag; geprüft wird die Lagekorrektur, nicht das Totband.
     *
     * Der Wert wird hier in Node eingesetzt, nicht im Browser gelesen: dieser
     * Block ist ein Textbaustein, der drüben per new Function ausgeführt wird,
     * und dort gibt es kein FOLLOW.
     */
    const erlaubteAbweichung = ${FOLLOW.headingDeadbandDegrees + 1};
`;

/** Die Karte übernimmt Position und Blickrichtung aus den Sensordaten. */
async function testFollowsPosition() {
    const {browser, page, pageErrors} = await openPage({withSensorHarness: true});
    await enterLiveMode(page);

    const destination = {latitude: 46.6000, longitude: 7.9300};
    const state = await page.evaluate(new Function('destination', `return (async () => {
        ${WAIT_UNTIL}
        // Kameralage aus: dieser Test prüft, ob die Karte der Position folgt,
        // und dafür muss der Mittelpunkt die Position sein. Die Lage selbst
        // prüft testCameraAnchor.
        window.cockpit.follow.setAnchor(0);
        window.__harness.emitCompass(90);
        // Fahrt mit 15 m/s auf Kurs 45°; wiederholte Fixes auf demselben Punkt
        // lassen die EMA auf den Endwert einlaufen.
        for (let i = 0; i < 12; i++) {
            window.__harness.emitFix({...destination, speed: 15, heading: 45});
            await new Promise((resolve) => setTimeout(resolve, 80));
        }
        /*
         * **Toleranz mit Vorhaltestrecke.**
         *
         * Die Koppelnavigation rechnet vom letzten Fix aus weiter — bei 15 m/s
         * und FOLLOW.koppelMaxSeconds von zwei Sekunden bis zu 30 m, also rund
         * 2,7e-4 Grad. Seit der Kartenmittelpunkt die eigene Position *ist*
         * (7.9.2026) landet das unmittelbar im Vergleich; mit den alten 1e-4
         * fiel der Test in einem von drei Läufen aus, ohne dass etwas kaputt
         * war. Ein Fix mit Tempo null als Abschluss wäre der andere Weg, wechselt
         * aber die Kursquelle zurück auf den Kompass und nimmt dem Test seinen
         * eigentlichen Gegenstand.
         *
         * 4e-4 sind rund 44 m — eng genug: eine Kamera, die der Position nicht
         * folgt, liegt um Hunderte Meter daneben.
         */
        const settled = await waitUntil(() => {
            const c = window.cockpit.map.getCenter();
            return Math.abs(c.lat - destination.latitude) < 4e-4
                && Math.abs(c.lng - destination.longitude) < 4e-4
                && angleDelta(window.cockpit.map.getBearing(), 45) < 1;
        });
        return {
            settled,
            center: window.cockpit.map.getCenter(),
            bearing: window.cockpit.map.getBearing(),
            pitch: window.cockpit.map.getPitch(),
            zoom: window.cockpit.map.getZoom(),
            hoehe: window.cockpit.follow.cameraHeight(),
            heading: document.getElementById('hud-heading').textContent,
            speed: document.getElementById('hud-speed').textContent
        };
    })()`), destination);
    await browser.close();

    const failures = [];
    if (!state.settled) failures.push('Kamera hat Position/Kurs nicht erreicht');
    // Die Neigung darf die Bodenfreiheits-Sicherung zurücknehmen, deshalb ein
    // Band statt eines Punktwerts; der Zoom ist der Startwert aus der Konfiguration.
    if (state.pitch < FOLLOW.pitchMin || state.pitch > FOLLOW.pitchMax) {
        failures.push(`Pitch ${state.pitch.toFixed(1)}° ausserhalb ${FOLLOW.pitchMin}–${FOLLOW.pitchMax}°`);
    }
    // Der Startzustand ist als Höhe gesetzt, nicht als Zoomstufe.
    if (Math.abs(state.hoehe - FOLLOW.heightMeters) > FOLLOW.heightMeters * 0.25) {
        failures.push(`Kamerahöhe ${Math.round(state.hoehe)} m, erwartet ~${FOLLOW.heightMeters} m`);
    }
    if (!state.heading.includes('GPS')) failures.push(`Heading-Quelle "${state.heading}", erwartet GPS`);
    if (pageErrors.length > 0) failures.push(`JS-Fehler: ${pageErrors.join(' | ')}`);
    report('Phase 2 — Karte folgt Position, Kurs aus GPS bei Fahrt', failures,
        `center=${state.center.lat.toFixed(5)}/${state.center.lng.toFixed(5)} bearing=${state.bearing.toFixed(1)}° z${state.zoom.toFixed(1)} ${state.heading} ${state.speed}`);
}

/** Im Stand darf GPS-Rauschen die Kamera nicht mitzittern lassen. */
async function testNoJitterAtStandstill() {
    const {browser, page, pageErrors} = await openPage({withSensorHarness: true});
    await enterLiveMode(page);

    // ±0,00012° ≈ ±13 m Rauschen — realistisch für Stadtempfang im Stand.
    const measurement = await page.evaluate(new Function(`return (async () => {
        ${WAIT_UNTIL}
        window.cockpit.follow.setAnchor(0);
        window.__harness.emitCompass(0);
        window.__harness.emitFix({latitude: 46.588, longitude: 7.909, speed: 0});
        await waitUntil(() => Math.abs(window.cockpit.map.getCenter().lat - 46.588) < 1e-5);

        const rawLats = [], cameraLats = [];
        for (let i = 0; i < 24; i++) {
            const latitude = 46.588 + (i % 2 === 0 ? 0.00012 : -0.00012);
            rawLats.push(latitude);
            window.__harness.emitFix({latitude, longitude: 7.909, speed: 0});
            await new Promise((resolve) => setTimeout(resolve, 100));
            cameraLats.push(window.cockpit.map.getCenter().lat);
        }
        const spread = (values) => Math.max(...values) - Math.min(...values);
        return {rawSpread: spread(rawLats), cameraSpread: spread(cameraLats)};
    })()`));
    await browser.close();

    const failures = [];
    const ratio = measurement.cameraSpread / measurement.rawSpread;
    if (ratio > 0.4) failures.push(`Kamera folgt dem Rauschen zu ${(ratio * 100).toFixed(0)} % (erlaubt: 40 %)`);
    if (pageErrors.length > 0) failures.push(`JS-Fehler: ${pageErrors.join(' | ')}`);
    report('Phase 2 — kein Nachzittern im Stand', failures,
        `Rauschen ${(measurement.rawSpread * 111320).toFixed(1)} m → Kamera ${(measurement.cameraSpread * 111320).toFixed(1)} m (${(ratio * 100).toFixed(0)} %)`);
}

/**
 * Der Wechsel Magnetometer → GPS darf nicht als Sprung sichtbar werden.
 *
 * Gemessen wird die Dauer des Übergangs, nicht der Schritt pro Frame: absolute
 * Grad-pro-Frame hängen an der Bildrate, die Dauer nicht. Ein ungeglätteter
 * Wechsel wäre nach einem einzigen Frame fertig (< 0,1 s).
 */
async function testSmoothSourceSwitch() {
    const {browser, page, pageErrors} = await openPage({withSensorHarness: true});
    await enterLiveMode(page);

    const measurement = await page.evaluate(new Function(`return (async () => {
        ${WAIT_UNTIL}
        // Stillstand: Kurs kommt vom Magnetometer. Wiederholt senden, weil der
        // Kompass geglättet wird.
        window.__harness.emitFix({latitude: 46.588, longitude: 7.909, speed: 0});
        const bisStand = performance.now() + 3000;
        while (performance.now() < bisStand) {
            window.__harness.emitCompass(90);
            await new Promise((r) => setTimeout(r, 60));
        }
        const reachedCompass = await waitUntil(() => angleDelta(window.cockpit.map.getBearing(), 90) < 2);
        const bearingBefore = window.cockpit.map.getBearing();

        // Losfahren mit 8 m/s auf Kurs 200° — 110° entfernt vom Kompasskurs.
        const switchedAt = performance.now();
        let reachedAt = null;
        const driving = (async () => {
            for (let i = 0; i < 20; i++) {
                window.__harness.emitFix({latitude: 46.588, longitude: 7.909, speed: 8, heading: 200});
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
        })();
        await waitUntil(() => {
            if (reachedAt === null && angleDelta(window.cockpit.map.getBearing(), 200) < 5) {
                reachedAt = performance.now();
            }
            return reachedAt !== null;
        });
        await driving;

        return {
            reachedCompass,
            bearingBefore,
            bearingAfter: window.cockpit.map.getBearing(),
            transitionSeconds: reachedAt === null ? null : (reachedAt - switchedAt) / 1000,
            source: document.getElementById('hud-heading').textContent
        };
    })()`));
    await browser.close();

    const failures = [];
    if (!measurement.reachedCompass) failures.push(`Kurs im Stand ${measurement.bearingBefore.toFixed(1)}°, erwartet 90° (Kompass)`);
    if (measurement.transitionSeconds === null) {
        failures.push('Übergang hat den Zielkurs nie erreicht');
    } else if (measurement.transitionSeconds < 0.5) {
        failures.push(`Übergang dauerte nur ${measurement.transitionSeconds.toFixed(2)} s — das ist der Sprung, den die Interpolation verhindern soll`);
    } else if (measurement.transitionSeconds > 4) {
        failures.push(`Übergang dauerte ${measurement.transitionSeconds.toFixed(2)} s — zu träge`);
    }
    if (!measurement.source.includes('GPS')) failures.push(`Heading-Quelle "${measurement.source}", erwartet GPS`);
    if (pageErrors.length > 0) failures.push(`JS-Fehler: ${pageErrors.join(' | ')}`);
    report('Phase 2 — Quellenwechsel Kompass → GPS ohne Ruckler', failures,
        `${measurement.bearingBefore.toFixed(1)}° → ${measurement.bearingAfter.toFixed(1)}° in ${measurement.transitionSeconds?.toFixed(2)} s`);
}

/**
 * Der Kompasskurs muss um die Bildschirmlage korrigiert werden, sonst zeigt
 * die Karte bei querformatiger Halterung 90° daneben.
 */
async function testCompassScreenAngle() {
    const {browser, page, pageErrors} = await openPage({withSensorHarness: true});
    await enterLiveMode(page);

    const measurement = await page.evaluate(new Function(`return (async () => {
        ${WAIT_UNTIL}
        window.__harness.emitFix({latitude: 46.588, longitude: 7.909, speed: 0});

        // Der Kompass wird geglättet: ein einzelner Wert bewegt den Kurs nur um
        // einen Bruchteil. Wie ein echter Sensor also wiederholt senden.
        const halten = async (kurs, ms) => {
            const start = performance.now();
            while (performance.now() - start < ms) {
                window.__harness.emitCompass(kurs);
                await new Promise((r) => setTimeout(r, 60));
            }
        };
        // Querformat: Rohkurs 300° + 90° Lage = 30°.
        window.__harness.screenAngle = 90;
        await halten(300, 2500);
        const landscapeOk = await waitUntil(() => angleDelta(window.cockpit.map.getBearing(), 30) < erlaubteAbweichung);
        // Das HUD läuft in einem eigenen 200-ms-Takt, nicht im Frame-Takt.
        await waitUntil(() => document.getElementById('hud-compass').textContent.includes('roh'));
        const hudText = document.getElementById('hud-compass').textContent;

        // Zurück ins Hochformat: derselbe Rohkurs muss jetzt 300° ergeben.
        window.__harness.screenAngle = 0;
        await halten(300, 3500);
        const portraitOk = await waitUntil(() => angleDelta(window.cockpit.map.getBearing(), 300) < erlaubteAbweichung);

        return {landscapeOk, portraitOk, hudText, bearing: window.cockpit.map.getBearing()};
    })()`));
    await browser.close();

    const failures = [];
    if (!measurement.landscapeOk) failures.push('Querformat: Kurs wurde nicht um 90° korrigiert');
    if (!measurement.portraitOk) failures.push(`Hochformat: Kurs ${measurement.bearing.toFixed(1)}°, erwartet 300°`);
    if (!measurement.hudText.includes('300° roh + 90° Lage = 30°')) {
        failures.push(`HUD-Diagnose zeigt "${measurement.hudText}"`);
    }
    if (pageErrors.length > 0) failures.push(`JS-Fehler: ${pageErrors.join(' | ')}`);
    report('Phase 2 — Kompasskurs folgt der Bildschirmlage (Halterung hoch/quer)', failures,
        measurement.hudText);
}

/**
 * Phase 4a: die Sperrflächen liegen als WMTS-Raster über dem Terrain, das Panel
 * schaltet sie, und ein Layer, der keine Kacheln liefert, wird als solcher
 * ausgewiesen (die Layer-IDs sind unverifiziert — genau dafür ist die Anzeige da).
 */
async function testOverlays() {
    const failingLayer = 'ch.bfe.elektrische-anlagen_ueber_36';
    // Live-Modus starten: das Start-Overlay liegt sonst über dem Layer-Panel.
    const {browser, page, pageErrors, wmtsRequests} = await openPage({
        withSensorHarness: true,
        failingWmtsLayer: failingLayer
    });
    await page.waitForFunction(
        () => document.getElementById('hud-status')?.textContent === 'Terrain aktiv',
        null, {timeout: 30000});
    await enterLiveMode(page);

    const layerState = await page.evaluate(() => {
        const ids = ['drohnen', 'wildruhezonen', 'uas-aktivitaet', 'schiessanzeigen',
            'seilbahnen', 'hochspannung', 'moorlandschaften', 'gewaesser'];
        return ids.map((id) => ({
            id,
            hasSource: !!window.cockpit.map.getSource(`overlay-${id}`),
            visible: window.cockpit.overlays.isVisible(id)
        }));
    });

    // Der Warnhinweis kommt aus probeOverlayLayers (eigene Kachelanfrage beim
    // Start) — MapLibre selbst meldet fehlgeschlagene Raster-Kacheln nicht.
    const warned = await page.waitForFunction(
        () => document.getElementById('layers-panel').textContent.includes('⚠︎'),
        null, {timeout: 20000}).then(() => true).catch(() => false);
    const panelText = await page.evaluate(() => document.getElementById('layers-panel').textContent.trim());

    // Abgeschalteten Layer einschalten: erst danach dürfen Kacheln kommen.
    const zuschaltbarLayer = 'ch.bafu.bundesinventare-moorlandschaften';
    const zuschaltbarBefore = wmtsRequests.get(zuschaltbarLayer) ?? 0;
    await page.click('#layers-toggle');
    await page.evaluate(() => {
        const rows = [...document.querySelectorAll('.layer-row')];
        rows.find((row) => row.textContent.includes('Moorlandschaften')).querySelector('input').click();
    });
    const zuschaltbarLoaded = await page.waitForFunction(
        () => window.cockpit.overlays.isVisible('moorlandschaften'), null, {timeout: 5000})
        .then(() => true).catch(() => false);
    await page.waitForTimeout(2500);
    await browser.close();

    const failures = [];
    const expectedVisible = {drohnen: true, wildruhezonen: true, 'uas-aktivitaet': true,
        schiessanzeigen: true, seilbahnen: true, hochspannung: true,
        moorlandschaften: false, gewaesser: false};
    layerState.forEach((layer) => {
        if (!layer.hasSource) failures.push(`Source overlay-${layer.id} fehlt`);
        if (layer.visible !== expectedVisible[layer.id]) {
            failures.push(`${layer.id}: sichtbar=${layer.visible}, erwartet ${expectedVisible[layer.id]}`);
        }
    });
    // Der WMS-Layer ist bewusst dabei: als WMTS eingebunden lieferte er nichts.
    ['ch.bazl.einschraenkungen-drohnen', 'ch.bafu.wrz-wildruhezonen_portal',
        'ch.vbs.schiessanzeigen', 'ch.swisstopo.swisstlm3d-uebrigerverkehr',
        'ch.bfe.elektrische-anlagen_ueber_36']
        .forEach((layer) => {
            if (!wmtsRequests.has(layer)) failures.push(`keine Kachelanfragen für ${layer}`);
        });
    if (zuschaltbarBefore > 0) failures.push('abgeschalteter Layer hat trotzdem Kacheln geladen');
    if (!zuschaltbarLoaded) failures.push('Panel-Schalter hat den Layer nicht eingeschaltet');
    if ((wmtsRequests.get(zuschaltbarLayer) ?? 0) === 0) {
        failures.push('nach dem Einschalten wurden keine Kacheln geladen');
    }
    if (!warned) failures.push(`fehlender Warnhinweis für ${failingLayer} — Panel zeigt "${panelText}"`);
    if (pageErrors.length > 0) failures.push(`JS-Fehler: ${pageErrors.join(' | ')}`);

    report('Phase 4a — WMTS-Sperrflächen, Panel-Schalter, Fehlerdiagnose', failures,
        `Kachelanfragen: ${[...wmtsRequests.entries()].map(([k, v]) => `${k.split('.').pop()}=${v}`).join(' ')}`);
}

await testMapBoot({
    name: 'Phase 1 — Terrain lädt im Worker, Karte steht auf der Startansicht',
    layerJsonStatus: 200,
    expectStatus: 'Terrain aktiv',
    expectBannerVisible: false
});
await testMapBoot({
    name: 'Phase 1 — Terrain-Ausfall degradiert auf flache Karte statt weisser Seite',
    layerJsonStatus: 500,
    expectStatus: 'Terrain nicht verfügbar — flache Karte',
    expectBannerVisible: true
});
await testBannerDismiss();
await testObstacles();
await testZoomStaysPinchable();
await testTiltDoesNotMovePitch();
await testCompassNoiseDamped();
await testHeightSlider();
await testFingerGesturesInTracking();
await testManualMode();
await testShadowModeGating();
await testShadowFlatTerrain();
await testPositionMarker();
await testCameraAnchor();
await testTapInfo();
await testUnqueryableLayerStaysOutOfIdentify();
await testProgressiveWebApp();
await testShellListComplete();
await testRefreshKeepsUpAtSpeed();
await testPrefetchAhead();
await testFollowsPosition();
await testNoJitterAtStandstill();
await testSmoothSourceSwitch();
await testCompassScreenAngle();
await testOverlays();
await testKeepsScreenAwake();

const gescheitert = results.filter((r) => !r.bestanden);
const dauer = Math.round((Date.now() - BEGONNEN) / 1000);
console.log(`\n${results.length - gescheitert.length}/${results.length} grün`
    + (gescheitert.length ? ` — FEHLGESCHLAGEN: ${gescheitert.map((r) => r.name).join(' | ')}` : '')
    + ` · ${Math.floor(dauer / 60)}m ${dauer % 60}s`);

process.exit(gescheitert.length === 0 ? 0 : 1);

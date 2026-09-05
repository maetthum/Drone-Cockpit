/**
 * Bootstrap: verdrahtet Karte, Sensoren und HUD. Enthält weder Karten- noch
 * Kameralogik.
 */
// maplibre-gl 6 liefert nur Named Exports (kein Default) — Namespace-Import nötig.
import * as maplibregl from '../vendor/maplibre-gl/maplibre-gl.mjs';
import {createMap} from './map.js';
import {cockpitZoom, createFollowController} from './follow.js';
import {getStartPosition, watchPosition} from './geolocation.js';
import {isCompassAvailable, requestCompassPermission, watchOrientation} from './compass.js';
import {createOverlays, probeOverlayLayers, SOURCE_PREFIX as OVERLAY_SOURCE_PREFIX} from './overlays.js';
import {createObstacles} from './obstacles.js';
import {createMe} from './me.js';
import {createInfo} from './info.js';
import {createPrefetch} from './prefetch.js';
import {createRadar} from './radar.js';
import {ATTRIBUTION_TEXT, CAMERA_STORE, DISCLAIMER, FOLLOW, OBSTACLES, OVERLAYS, RADAR, START_VIEW, UI} from './config.js';

const els = {
    status: document.getElementById('hud-status'),
    position: document.getElementById('hud-position'),
    speed: document.getElementById('hud-speed'),
    heading: document.getElementById('hud-heading'),
    compass: document.getElementById('hud-compass'),
    tilt: document.getElementById('hud-tilt'),
    camera: document.getElementById('hud-camera'),
    hud: document.getElementById('hud'),
    banner: document.getElementById('banner'),
    attribution: document.getElementById('attribution'),
    disclaimer: document.getElementById('disclaimer'),
    start: document.getElementById('start'),
    startButton: document.getElementById('start-button'),
    startDisclaimer: document.getElementById('start-disclaimer'),
    startHint: document.getElementById('start-hint'),
    installHint: document.getElementById('install-hint'),
    fullscreen: document.getElementById('fullscreen'),
    recenter: document.getElementById('recenter'),
    compassButton: document.getElementById('compass'),
    infoPanel: document.getElementById('info'),
    infoBody: document.getElementById('info-body'),
    infoClose: document.getElementById('info-close'),
    anchorControl: document.getElementById('anchor-control'),
    anchor: document.getElementById('anchor'),
    anchorValue: document.getElementById('anchor-value'),
    height: document.getElementById('height'),
    heightValue: document.getElementById('height-value'),
    modes: document.getElementById('modes'),
    modeTracking: document.getElementById('mode-tracking'),
    modeManual: document.getElementById('mode-manual'),
    hudToggle: document.getElementById('hud-toggle'),
    anchorToggle: document.getElementById('anchor-toggle'),
    layersToggle: document.getElementById('layers-toggle'),
    layersPanel: document.getElementById('layers-panel')
};

const STATUS_TEXT = {
    basemap: 'Basemap geladen, Terrain lädt …',
    terrain: 'Terrain aktiv',
    'terrain-failed': 'Terrain nicht verfügbar — flache Karte'
};

const HEADING_SOURCE_TEXT = {gps: 'GPS', compass: 'Kompass'};

let bannerTimer = null;

/**
 * Blendet eine Meldung ein.
 *
 * `transient` ist für Fehler, die sich von selbst erledigen — ein einzelner
 * Kachel- oder Netzaussetzer während der Fahrt liesse sonst ein rotes Banner
 * für den Rest der Fahrt über der Karte stehen. Dauerzustände (Terrain fehlt,
 * Standort verweigert, Kompass gesperrt) bleiben stehen; wegtippen lässt sich
 * beides.
 */
function showBanner(message, {transient = false} = {}) {
    els.banner.textContent = message;
    els.banner.hidden = false;
    clearTimeout(bannerTimer);
    bannerTimer = transient ? setTimeout(hideBanner, UI.transientBannerMs) : null;
}

function hideBanner() {
    clearTimeout(bannerTimer);
    bannerTimer = null;
    els.banner.hidden = true;
}

function formatFix(fix) {
    if (!fix) return '–';
    const accuracy = `±${Math.round(fix.accuracy)} m`;
    const marker = fix.accuracy > FOLLOW.poorAccuracyMeters ? ' ⚠︎' : '';
    return `${fix.lat.toFixed(5)} ${fix.lng.toFixed(5)} · ${accuracy}${marker}`;
}

function formatSpeed(fix) {
    if (!fix || fix.speed === null) return '–';
    return `${(fix.speed * 3.6).toFixed(1)} km/h`;
}

function formatHeading(state) {
    if (state.heading === null || state.headingSource === null) return '–';
    return `${Math.round(state.heading)}° (${HEADING_SOURCE_TEXT[state.headingSource]})`;
}

/**
 * Letzter Kompass-Rohwert samt Bildschirmlage. Steht im HUD, damit die
 * Lagekorrektur am Gerät überprüfbar ist (siehe compass.js).
 */
let lastCompassDetail = null;

function formatCompass() {
    if (lastCompassDetail === null) return '–';
    const {raw, screenAngle, corrected} = lastCompassDetail;
    return `${Math.round(raw)}° roh + ${screenAngle}° Lage = ${Math.round(corrected)}°`;
}

/**
 * Kameraneigung und, falls die Bodenfreiheits-Sicherung greift, deren
 * Obergrenze — damit am Gerät sichtbar wird, warum die Ansicht flacher steht
 * als eingestellt.
 */
function formatTilt(state) {
    const pitch = Math.round(state.pitch);
    const ceiling = Math.round(state.pitchCeiling);
    return pitch >= ceiling - 0.5 && ceiling < FOLLOW.pitchMax
        ? `${pitch}° (Gelände begrenzt auf ${ceiling}°)`
        : `${pitch}°`;
}

function updateHud(map, follow) {
    // Die Höhe gehört zum Kameralage-Panel, nicht zum HUD — sie wird auch
    // gebraucht, wenn das HUD eingeklappt ist.
    if (!els.anchorControl.hidden) {
        els.heightValue.textContent = `${Math.round(follow.cameraHeight())} m`;
    }
    /*
     * Eingeklapptes HUD gar nicht erst füllen. Der Takt läuft fünfmal je
     * Sekunde und liest dabei Kameraposition, Zoom, Neigung und Kurs aus —
     * Arbeit, die niemand sieht, solange nur das Eck sichtbar ist.
     */
    if (els.hud.hidden) return;

    const state = follow.getState();
    els.position.textContent = formatFix(state.fix);
    els.speed.textContent = formatSpeed(state.fix);
    els.heading.textContent = formatHeading(state);
    els.compass.textContent = formatCompass();
    els.tilt.textContent = formatTilt(state);

    const {lng, lat} = map.getCenter();
    els.camera.textContent =
        `${lat.toFixed(4)} ${lng.toFixed(4)} · z${map.getZoom().toFixed(1)} · ` +
        `P${Math.round(map.getPitch())}° B${Math.round(map.getBearing())}°`;
}

/**
 * Baut das Layer-Panel aus der Konfiguration — die Liste steht nur in
 * config.js, nicht zusätzlich im Markup.
 */
function buildLayerPanel(overlays, obstacles, radar) {
    const labels = new Map();

    // Hindernisse (Vektor) und Radar (zeitabhängiges Raster) hängen an eigenen
    // Quellen, bekommen im Panel aber dieselbe Zeile wie alles andere.
    const rows = [
        ...OVERLAYS.map((overlay) => ({...overlay, toggle: (on) => overlays.setVisible(overlay.id, on)})),
        {...OBSTACLES, toggle: (on) => obstacles.setVisible(on)},
        {...RADAR, toggle: (on) => radar.setVisible(on)}
    ];

    rows.forEach((overlay) => {
        const row = document.createElement('label');
        row.className = 'layer-row';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = overlay.enabled;
        checkbox.addEventListener('change', () => overlay.toggle(checkbox.checked));

        const text = document.createElement('span');
        text.textContent = overlay.label;

        row.append(checkbox, text);
        els.layersPanel.append(row);
        labels.set(overlay.id, text);
    });

    els.layersToggle.addEventListener('click', () => {
        const open = els.layersPanel.hidden;
        els.layersPanel.hidden = !open;
        els.layersToggle.setAttribute('aria-expanded', String(open));
    });

    /** Markiert einen Layer, der keine Kacheln liefert — meist eine falsche ID. */
    return (overlayId, reason) => {
        const label = labels.get(overlayId);
        const overlay = OVERLAYS.find((candidate) => candidate.id === overlayId);
        if (!label || label.dataset.failed === 'true') return;
        label.dataset.failed = 'true';
        label.textContent = `${overlay.label} ⚠︎`;
        label.title = `${overlay.layer} liefert keine Kachel (${reason}) — Layer-ID, Zeitstempel oder CORS-Freigabe prüfen.`;
    };
}

/**
 * Zuletzt bekannte Position. Fehlschläge werden verschluckt: im privaten Modus
 * wirft `localStorage` schon beim Lesen, und daran darf der Start nicht
 * scheitern — ohne gespeicherte Position wird eben eine geholt.
 */
function readLastPosition() {
    try {
        const stored = JSON.parse(localStorage.getItem(START_VIEW.storageKey) ?? 'null');
        if (!stored || Date.now() - stored.t > START_VIEW.maxAgeMs) return null;
        return {lng: stored.lng, lat: stored.lat};
    } catch {
        return null;
    }
}

let lastStoredAt = 0;

function storeLastPosition({lng, lat}) {
    const now = Date.now();
    if (now - lastStoredAt < START_VIEW.storeIntervalMs) return;
    lastStoredAt = now;
    try {
        localStorage.setItem(START_VIEW.storageKey, JSON.stringify({lng, lat, t: now}));
    } catch {
        // Kein Speicher (privater Modus, volles Kontingent): dann startet die
        // App beim nächsten Mal eben wieder über den Standortabruf.
    }
}

/**
 * Kameralage (Vor-Regler und Höhe) über Sitzungen hinweg merken.
 *
 * Wie bei der Position werden Fehlschläge verschluckt: im privaten Modus wirft
 * `localStorage`, und eine nicht gemerkte Einstellung ist kein Grund, den Start
 * scheitern zu lassen.
 */
function readCameraSettings() {
    try {
        const stored = JSON.parse(localStorage.getItem(CAMERA_STORE.storageKey) ?? 'null');
        if (!stored) return null;
        return {
            anchor: Number.isFinite(stored.anchor) ? stored.anchor : null,
            heightMeters: Number.isFinite(stored.heightMeters) ? stored.heightMeters : null
        };
    } catch {
        return null;
    }
}

function storeCameraSettings({anchor, heightMeters}) {
    try {
        localStorage.setItem(CAMERA_STORE.storageKey, JSON.stringify({anchor, heightMeters}));
    } catch {
        // Kein Speicher: dann eben beim nächsten Start wieder die Vorgabe.
    }
}

/**
 * Kameraeinstellung für den allerersten Anstrich.
 *
 * Der Reihe nach: zuletzt bekannte Position (kostet nichts und ist im Regelfall
 * da), sonst ein grober Fix, sonst die Übersicht. Entscheidend ist, dass hier
 * schon der *richtige* Ort steht — der erste Satz Kacheln ist damit der, den
 * der Nutzer auch zu sehen bekommt. Zur Vorgeschichte siehe START_VIEW.
 */
async function resolveStartView() {
    const known = readLastPosition() ?? await getStartPosition(START_VIEW.fixOptions);
    if (!known) return START_VIEW.overview;
    return {
        center: [known.lng, known.lat],
        // Gleich im Cockpit-Blick: ein späterer Sprung von der Übersicht dorthin
        // würde die eben geladenen Kacheln wegwerfen.
        zoom: cockpitZoom(known.lat, FOLLOW.pitch, FOLLOW.heightMeters, window.innerHeight),
        pitch: FOLLOW.pitch,
        bearing: 0
    };
}

const GEOLOCATION_ERROR_TEXT = {
    1: 'Standortfreigabe verweigert — die Karte kann nicht folgen.',
    2: 'Kein Standort verfügbar (kein GPS-Empfang?).',
    3: 'Standortabfrage hat zu lange gedauert.'
};

/**
 * Startet Sensorik und Kameraführung. Muss aus einer Nutzergeste heraus laufen,
 * sonst verweigert iOS die Kompassfreigabe.
 */
async function startLiveMode({follow, me, prefetch, meldePosition}, freigabe) {
    // Die Kompassfreigabe läuft schon: sie wurde beim Tippen gestartet, weil
    // iOS `requestPermission()` nur aus einer Nutzergeste heraus zulässt.
    // Stünde sie hier hinter dem Warten auf die Karte, wäre die Geste
    // verbraucht und die Freigabe würde verworfen (siehe compass.js).
    const permission = await freigabe;
    if (permission === 'granted') {
        watchOrientation((state) => {
            // Den korrigierten Kurs mitführen statt ihn im HUD nachzurechnen:
            // die Korrektur steht ausschliesslich in compass.js. Ihr Vorzeichen
            // ist noch unbestätigt (offener Punkt) — HUD und Kamera müssen dann
            // an einer einzigen Stelle mitdrehen.
            if (state.heading !== null) {
                lastCompassDetail = {raw: state.raw, screenAngle: state.screenAngle, corrected: state.heading};
                follow.pushCompassHeading(state.heading);
            }
        });
    } else {
        const reason = permission === 'denied'
            ? 'Kompass nicht freigegeben'
            : 'Gerät ohne Kompass';
        // Kein Abbruch: ohne Kompass fehlt nur die Blickrichtung im Stillstand.
        showBanner(`${reason} — Blickrichtung nur während der Fahrt (GPS).`);
    }

    watchPosition(
        (fix) => {
            follow.pushFix(fix);
            // Auch im Manuell-Modus nachführen: dort steht der Frame-Loop, der
            // Marker soll aber weiterhin zeigen, wo man ist.
            const {position, heading} = follow.getState();
            if (position) {
                me.update({...position, heading});
                // Damit der nächste Start sofort hier lädt, statt erst auf
                // einen Standort zu warten.
                storeLastPosition(position);
                // Was gleich ins Bild kommt, schon jetzt in den Kachelspeicher.
                prefetch.update({...position, heading});
            }
            meldePosition();
        },
        (error) => showBanner(GEOLOCATION_ERROR_TEXT[error?.code] ?? `Standortfehler: ${error?.message ?? error}`)
    );

    follow.start();
    els.modes.hidden = false;
    // Nur der Anfasser erscheint; das Panel selbst bleibt eingeklappt, bis es
    // gebraucht wird.
    els.anchorToggle.hidden = false;
    els.start.hidden = true;
}

async function main() {
    els.attribution.textContent = ATTRIBUTION_TEXT;
    // Rechtlicher Hinweis aus der Konfiguration, nicht aus dem Markup: er ist
    // freigabepflichtig und darf nur an einer Stelle stehen.
    els.startDisclaimer.textContent = DISCLAIMER.full;
    els.disclaimer.textContent = DISCLAIMER.short;

    /*
     * Den Startknopf **sofort** verdrahten — vor Standortabfrage und
     * Kartenaufbau.
     *
     * Der Knopf steht im Markup und ist damit ab der ersten Sekunde sichtbar.
     * Verdrahtet wurde er bisher erst am Ende von `main()`, also nach dem
     * Standortabruf und nach `createMap()`, das auf das vollständige erste
     * Rendering wartet. Bis dahin blieb jedes Tippen wirkungslos: am iPad
     * mehrere Sekunden, in denen der Nutzer mehrfach tippt und nichts
     * geschieht. Lokal nachgemessen waren schon 373 ms und zwei Tipps nötig.
     *
     * Jetzt nimmt der Knopf den ersten Tipp entgegen, startet sofort die
     * Kompassfreigabe (die braucht die Geste) und wartet den Rest ab.
     */
    let appBereit;
    const bereit = new Promise((aufloesen) => {
        appBereit = aufloesen;
    });

    if (!isCompassAvailable()) {
        els.startHint.textContent = 'Dieses Gerät meldet keinen Kompass — Blickrichtung kommt dann nur aus der Fahrtrichtung.';
    }

    els.startButton.addEventListener('click', () => {
        els.startButton.disabled = true;
        // Muss synchron aus der Geste heraus starten, nicht erst nach `await`.
        const freigabe = requestCompassPermission();
        // Rückmeldung, solange die Karte noch lädt: sonst sieht der Tipp
        // wieder aus, als wäre er ins Leere gegangen.
        els.startHint.textContent = 'Karte wird vorbereitet …';
        bereit
            .then((teile) => startLiveMode(teile, freigabe))
            .catch((error) => {
                els.startButton.disabled = false;
                els.startHint.textContent = '';
                showBanner(`Start fehlgeschlagen: ${error?.message ?? error}`);
            });
    }, {once: true});

    // Erst die Position, dann die Karte: sie soll gleich am richtigen Ort
    // aufgebaut werden, statt einen ganzen Kachelsatz für einen Ort zu laden,
    // den niemand zu sehen bekommt (siehe resolveStartView).
    const startView = await resolveStartView();

    let map;
    try {
        map = await createMap(maplibregl, 'map', (state, detail) => {
            els.status.textContent = STATUS_TEXT[state];
            if (state === 'terrain-failed') {
                showBanner(`Terrain konnte nicht geladen werden: ${detail?.message ?? 'unbekannter Fehler'}`);
            }
        }, startView);
    } catch (error) {
        els.status.textContent = 'Karte konnte nicht starten';
        showBanner(`Kartenfehler: ${error?.message ?? error}`);
        // Ein bereits wartender Tipp darf nicht ins Leere laufen.
        appBereit(Promise.reject(error));
        return;
    }

    // Kachel-/Netzfehler sind das wahrscheinlichste Problem (falsche WMTS-
    // Layer-ID, blockierte Domain) — sichtbar machen statt stumm in der Konsole.
    // Overlay-Fehler ausgenommen: die weist das Layer-Panel gezielt aus, mit
    // Layernamen statt einer anonymen Kartenfehlermeldung.
    map.on('error', (event) => {
        if (event?.sourceId?.startsWith(OVERLAY_SOURCE_PREFIX)) return;
        showBanner(`Kartenfehler: ${event?.error?.message ?? 'unbekannt'}`, {transient: true});
    });

    const overlays = createOverlays(map);
    const obstacles = createObstacles(map);
    const radar = createRadar(map);
    const markOverlayUnavailable = buildLayerPanel(overlays, obstacles, radar);
    // Antippen beantwortet „was gilt hier?" aus den Sachdaten der Layer.
    createInfo(map, {overlays, obstacles},
        {panel: els.infoPanel, body: els.infoBody, close: els.infoClose});
    /*
     * Die Sperrflächen kommen erst, wenn Luftbild und Gelände stehen.
     *
     * Sie kosten fast die Hälfte der Ladezeit (gemessen: 2856 ms mit, 1483 ms
     * ohne). Gleichzeitig geladen kämpfen sie mit dem Luftbild um dieselben
     * Verbindungen und verzögern das, was die Karte überhaupt erst lesbar
     * macht. Nacheinander ist die Karte rund eine Sekunde früher brauchbar —
     * die Gesamtdauer bleibt gleich, die Wartezeit bis zum ersten nutzbaren
     * Bild nicht.
     *
     * `once('idle')` feuert, sobald nichts mehr nachzuladen ist; der Zeitgeber
     * ist das Sicherheitsnetz für den Fall, dass die Karte nie zur Ruhe kommt
     * (bei laufender Kameraführung feuert `idle` unter Umständen gar nicht).
     */
    let overlaysNachgezogen = false;
    const overlaysNachziehen = () => {
        if (overlaysNachgezogen) return;
        overlaysNachgezogen = true;
        overlays.applyDefaults();
    };
    map.once('idle', overlaysNachziehen);
    setTimeout(overlaysNachziehen, UI.overlayDelayMaxMs);

    // Läuft im Hintergrund: die Karte soll nicht auf die Prüfung warten.
    probeOverlayLayers(markOverlayUnavailable);
    // Der Aufruf bremst sich selbst (Zeit und Strecke) — im Folgen-Modus feuert
    // `moveend` mit dem Frame-Takt.
    map.on('moveend', () => obstacles.refresh());
    obstacles.refresh();

    const me = createMe(map);
    const follow = createFollowController(map, {onFrame: (state) => me.update(state)});
    const prefetch = createPrefetch(map, overlays);

    // Ab hier ist alles da, was der Startknopf braucht. Wer schon getippt hat,
    // wird jetzt bedient; wer noch nicht, bekommt die Reaktion sofort.
    appBereit({follow, me, prefetch, meldePosition});

    /**
     * HUD und Kameralage sind einklappbar und starten eingeklappt.
     *
     * Beide verdecken im Fahrbetrieb Karte, werden aber selten gebraucht:
     * sichtbar bleibt nur ein kleines Eck, dessen Pfeil zur Bildschirmmitte
     * zeigt. Der Zustand steckt in `aria-expanded`, damit Darstellung und
     * Vorlesbarkeit nicht auseinanderlaufen.
     */
    function verbindePanel(toggle, panel, nameAuf, nameZu) {
        const setzen = (offen) => {
            panel.hidden = !offen;
            toggle.setAttribute('aria-expanded', String(offen));
            toggle.setAttribute('aria-label', offen ? nameZu : nameAuf);
            toggle.title = offen ? nameZu : nameAuf;
        };
        setzen(false);
        toggle.addEventListener('click', () => setzen(panel.hidden));
    }

    verbindePanel(els.hudToggle, els.hud, 'Positionsdaten einblenden', 'Positionsdaten ausblenden');
    verbindePanel(els.anchorToggle, els.anchorControl, 'Kameralage einblenden', 'Kameralage ausblenden');

    /*
     * Vollbild — vor allem im Querformat, wo Safaris Leisten die knappe Höhe
     * fressen.
     *
     * Zwei Wege, je nach Browser:
     *  - **Fullscreen-API**, wo es sie gibt (iPad, Android, Rechner): ein Knopf
     *    im Stapel schaltet um.
     *  - **Home-Bildschirm** auf dem iPhone: dort bietet Safari die API für
     *    normale Elemente **nicht** an, nur für Video. Die App ist aber als PWA
     *    eingerichtet (`display: standalone`, `orientation: any`) und läuft vom
     *    Home-Bildschirm aus ohne jede Browserleiste. Der Hinweis auf dem
     *    Startbildschirm sagt das — bislang wusste es niemand.
     *
     * Läuft die App bereits ohne Browserleisten, ist beides überflüssig.
     */
    const wurzel = document.documentElement;
    const vollbildRein = wurzel.requestFullscreen ?? wurzel.webkitRequestFullscreen;
    const vollbildRaus = document.exitFullscreen ?? document.webkitExitFullscreen;
    const imVollbildModus = () => !!(document.fullscreenElement ?? document.webkitFullscreenElement);
    const ohneBrowserleisten = window.navigator.standalone === true
        || window.matchMedia('(display-mode: standalone)').matches
        || window.matchMedia('(display-mode: fullscreen)').matches;

    if (typeof vollbildRein === 'function' && !ohneBrowserleisten) {
        els.fullscreen.hidden = false;
        const zeigeStand = () => {
            const an = imVollbildModus();
            els.fullscreen.setAttribute('aria-pressed', String(an));
            const text = an ? 'Vollbild verlassen' : 'Vollbild einschalten';
            els.fullscreen.setAttribute('aria-label', text);
            els.fullscreen.title = text;
        };
        els.fullscreen.addEventListener('click', () => {
            // Der Aufruf kann abgelehnt werden (fehlende Geste, Richtlinie des
            // Browsers) — das ist kein Grund für ein Fehlerbanner.
            const versuch = imVollbildModus()
                ? vollbildRaus.call(document)
                : vollbildRein.call(wurzel);
            Promise.resolve(versuch).catch(() => {});
        });
        document.addEventListener('fullscreenchange', zeigeStand);
        document.addEventListener('webkitfullscreenchange', zeigeStand);
        zeigeStand();
    } else if (!ohneBrowserleisten) {
        els.installHint.hidden = false;
        els.installHint.textContent =
            'Für Vollbild ohne Safari-Leisten: Teilen → „Zum Home-Bildschirm". '
            + 'Das Cockpit startet dann als eigene App, quer wie hoch.';
    }

    /*
     * Beim Drehen des Geräts die Kartengrösse nachziehen.
     *
     * MapLibre beobachtet den Container selbst, aber iOS meldet die neue
     * Viewport-Höhe beim Orientierungswechsel verzögert — der Canvas behielt
     * dann kurzzeitig die alten Masse und liess unten einen schwarzen Streifen
     * stehen. Der zweite Aufruf nach kurzer Frist fängt genau diesen Nachlauf.
     */
    const groesseNachziehen = () => {
        map.resize();
        setTimeout(() => map.resize(), 300);
    };
    window.addEventListener('orientationchange', groesseNachziehen);
    screen.orientation?.addEventListener?.('change', groesseNachziehen);

    // Wegtippen: auch eine Dauermeldung soll die Karte nicht endlos verdecken.
    els.banner.addEventListener('click', hideBanner);

    /**
     * Ob überhaupt schon ein Standort vorliegt. Erst dann kann „Zu mir"
     * irgendwohin springen.
     */
    let hatPosition = false;

    function meldePosition() {
        if (hatPosition) return;
        hatPosition = true;
        // Im Tracking bleibt der Knopf trotzdem weg — dort steht die Kamera
        // schon auf der eigenen Position.
        els.recenter.hidden = follow.isActive;
    }

    /**
     * Zwei Modi, kein Zwischending:
     *
     * **Tracking** — die Karte führt selbst: Position, Blickrichtung und
     * Neigung kommen von den Sensoren. Kneifen und Zwei-Finger-Neigen greifen
     * trotzdem, solange Finger auf der Karte liegen schweigt der Frame-Loop.
     * Verschieben und Drehen bleiben gesperrt: die Karte zöge sofort zurück.
     *
     * **Manuell** — die Kamera gehört dem Finger. Verschieben, Kneifen, Drehen
     * und Neigen sind frei, der Frame-Loop steht still.
     */
    function setMode(tracking) {
        if (tracking) follow.start();
        else follow.stop();
        els.modeTracking.setAttribute('aria-pressed', String(tracking));
        els.modeManual.setAttribute('aria-pressed', String(!tracking));
        /*
         * Der Kompass gehört zum Manuell-Modus. Im Tracking setzt der
         * Frame-Loop die Ausrichtung in jedem Bild aus der Fahrtrichtung — ein
         * Ausrichten nach Norden wäre im nächsten Bild wieder überschrieben und
         * der Knopf damit eine Lüge.
         */
        els.compassButton.hidden = tracking;
        /*
         * „Zu mir" ist im Tracking sinnlos: dort steht die Kamera ohnehin auf
         * der eigenen Position, der Knopf könnte nichts bewirken. Er erscheint
         * erst im Manuell-Modus — und auch dort nur, wenn überhaupt schon eine
         * Position bekannt ist (siehe watchPosition).
         */
        els.recenter.hidden = tracking || !hatPosition;
    }

    /**
     * Nadel dreht gegen die Kartenausrichtung, das Zifferblatt steht still —
     * die rote Spitze zeigt damit immer dorthin, wo Norden liegt.
     */
    function updateCompass() {
        els.compassButton.firstElementChild.style.transform = `rotate(${-map.getBearing()}deg)`;
    }

    map.on('rotate', updateCompass);
    updateCompass();

    // Antippen dreht die Karte nach Norden. `easeTo` statt `jumpTo`: der
    // Übergang zeigt, wie weit gedreht wurde, statt das Bild springen zu lassen.
    els.compassButton.addEventListener('click', () => map.easeTo({bearing: 0, duration: 400}));

    // Zurück zur eigenen Position, ohne den Modus zu wechseln: wer im
    // Manuell-Modus etwas anschaut, will oft nur den Ausgangspunkt zurück.
    els.recenter.addEventListener('click', () => follow.recenter());

    /** Beschriftung der Kameralage: die beiden Enden sind das, was zählt. */
    function anchorText(value) {
        if (value <= 0.02) return 'Übersicht';
        if (value >= 0.98) return 'Standort';
        return `${Math.round(value * 100)} %`;
    }

    /*
     * Gemerkte Kameralage anwenden, bevor die Regler ihren Stand ablesen.
     * `setCameraHeight` setzt nur die Zielhöhe — angewendet wird sie beim
     * ersten `follow.start()`, das ohnehin noch aussteht.
     */
    const gemerkt = readCameraSettings();
    if (gemerkt?.anchor !== null && gemerkt?.anchor !== undefined) follow.setAnchor(gemerkt.anchor);
    if (gemerkt?.heightMeters) follow.setCameraHeight(gemerkt.heightMeters);

    /** Beide Werte zusammen sichern — sie beschreiben eine Kameralage. */
    function sichereKameralage() {
        storeCameraSettings({anchor: follow.anchor, heightMeters: follow.cameraHeight()});
    }

    els.anchor.value = String(Math.round(follow.anchor * 100));
    els.anchorValue.textContent = anchorText(follow.anchor);
    els.anchor.addEventListener('input', () => {
        const value = Number(els.anchor.value) / 100;
        follow.setAnchor(value);
        els.anchorValue.textContent = anchorText(value);
    });
    // Beim Loslassen sichern, nicht bei jedem Pixel: `input` feuert dutzendfach
    // je Schiebebewegung, `change` einmal am Ende.
    els.anchor.addEventListener('change', sichereKameralage);

    /**
     * Höhenregler: logarithmisch abgegriffen, damit unten fein und oben grob
     * eingestellt werden kann. Die Anzeige zieht der HUD-Takt nach — so stimmt
     * sie auch, wenn die Höhe per Kneifen verändert wurde.
     */
    const heightFromSlider = (value) => FOLLOW.heightMinMeters
        * (FOLLOW.heightMaxMeters / FOLLOW.heightMinMeters) ** (Number(value) / 100);
    const sliderFromHeight = (meters) => 100 * Math.log(
        Math.min(FOLLOW.heightMaxMeters, Math.max(FOLLOW.heightMinMeters, meters))
        / FOLLOW.heightMinMeters) / Math.log(FOLLOW.heightMaxMeters / FOLLOW.heightMinMeters);

    els.height.value = String(Math.round(sliderFromHeight(follow.cameraHeight())));
    els.height.addEventListener('input', () => {
        follow.setCameraHeight(heightFromSlider(els.height.value));
    });
    els.height.addEventListener('change', sichereKameralage);
    // Kneifen verstellt die Höhe ebenfalls — dann wandert der Regler mit.
    map.on('zoom', () => {
        if (document.activeElement !== els.height) {
            els.height.value = String(Math.round(sliderFromHeight(follow.cameraHeight())));
        }
    });
    // Kneifen ist die andere Art, die Höhe zu setzen — auch die soll den
    // nächsten Start überleben. `zoomend` statt `zoom`: einmal am Ende der
    // Geste, nicht bei jedem Zwischenbild.
    map.on('zoomend', (event) => {
        if (event?.originalEvent) sichereKameralage();
    });

    els.modeTracking.addEventListener('click', () => setMode(true));
    els.modeManual.addEventListener('click', () => setMode(false));

    // Diagnose-Handle: erlaubt Inspektion per Safari-Webinspector im Fahrzeug
    // und ist der Zugriffspunkt für test/smoke.mjs.
    window.cockpit = {map, follow, overlays, obstacles, me, prefetch, radar};

    updateHud(map, follow);
    // Ein Intervall statt eines zweiten rAF-Loops: das HUD muss nicht mit
    // Bildwiederholrate aktualisiert werden, die Kamera schon.
    setInterval(() => updateHud(map, follow), 200);
}

/**
 * Service-Worker anmelden (Phase 5). Nur im sicheren Kontext — über eine
 * LAN-Adresse ohne HTTPS gibt es keinen, und ein Fehlschlag darf das Cockpit
 * nie aufhalten: ohne ihn läuft alles, nur eben ohne Offline-Vorrat.
 */
if ('serviceWorker' in navigator && window.isSecureContext) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js', {scope: './'}).catch(() => {});
    });
}

main();

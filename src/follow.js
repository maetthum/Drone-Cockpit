/**
 * Kameraführung: nimmt rohe Sensordaten entgegen, wählt die Heading-Quelle,
 * glättet beides und schiebt die Kamera im Frame-Takt nach.
 *
 * Warum die Blickrichtung nicht einfach vom Magnetometer kommt: im Fahrzeug
 * verzieht die Karosserie und die Motorelektronik das Magnetfeld. Sobald das
 * Fahrzeug fährt, ist der GPS-Bewegungsvektor die ehrlichere Quelle; im
 * Stillstand liefert er gar nichts, dann bleibt nur das Magnetometer.
 */
import {FOLLOW} from './config.js';

/**
 * Bodenauflösung in Metern pro Bildschirmpixel.
 *
 * **Mit 2^(zoom+1), nicht 2^zoom.** MapLibre rechnet Zoomstufen auf 512er-
 * Kacheln, die verbreitete Formel `156543,034 / 2^zoom` gilt für 256er. Wer
 * sie ungeprüft übernimmt, erhält durchweg doppelte Meterwerte — was hier
 * lange unbemerkt blieb: die angezeigte Kamerahöhe war doppelt so gross wie
 * die tatsächliche, und eine Näherungsformel für die Kameralage brauchte einen
 * „gemessenen" Faktor 0,5, der in Wahrheit genau dieser Fehler war.
 *
 * Nachgemessen durch Rückprojektion mehrerer Bildpunkte auf die Ebene: der
 * Kamerabstand beträgt 1,50 Bildhöhen (wie im Modell), die Höhe aber exakt die
 * Hälfte des zuvor gerechneten Werts — bei jeder Neigung.
 */
function metersPerPixel(zoom, lat) {
    return 156543.03392804097 * Math.cos((lat * Math.PI) / 180) / 2 ** (zoom + 1);
}

/**
 * Zoomstufe, bei der die Kamera bei gegebener Neigung `heightMeters` über der
 * Kartenebene steht — dieselbe Rechnung wie `applyHeight()`, nur ohne Karte.
 *
 * Exportiert, damit die Karte gleich im Cockpit-Blick gebaut werden kann statt
 * nachträglich dorthin zu springen: ein Sprung wirft einen kompletten Satz
 * geladener Kacheln weg.
 */
export function cockpitZoom(lat, pitchDegrees, heightMeters, viewportHeightPx) {
    const rad = Math.PI / 180;
    const perPixel = heightMeters / (1.5 * viewportHeightPx * Math.cos(pitchDegrees * rad));
    return Math.log2(156543.03392804097 * Math.cos(lat * rad) / perPixel) - 1;
}

/** Grobe Distanz in Metern — reicht, um einen Sprung von Rauschen zu trennen. */
function distanceMeters(a, b) {
    const dx = (a.lng - b.lng) * 111320 * Math.cos((a.lat * Math.PI) / 180);
    const dy = (a.lat - b.lat) * 110540;
    return Math.hypot(dx, dy);
}

/** Normalisiert auf [0, 360). */
function normalizeAngle(degrees) {
    return ((degrees % 360) + 360) % 360;
}

/** Kürzeste Winkeldifferenz in [-180, 180] — verhindert den 359°→1°-Umweg. */
function shortestAngleDelta(from, to) {
    return ((to - from + 540) % 360) - 180;
}

/** Exponentielle Annäherung, framerate-unabhängig über die Zeitkonstante tau. */
function approach(current, target, dt, tau) {
    return current + (target - current) * (1 - Math.exp(-dt / tau));
}

function approachAngle(current, target, dt, tau) {
    return normalizeAngle(approach(0, shortestAngleDelta(current, target), dt, tau) + current);
}

/**
 * @param {import('maplibre-gl').Map} map
 * @param {{onFrame?: (state: {lng: number, lat: number, heading: number|null}) => void}} [hooks]
 *        `onFrame` läuft im Frame-Takt mit der tatsächlich dargestellten
 *        Kameraposition — dort hängt der Positionsmarker dran, statt an einem
 *        zweiten rAF-Loop.
 * @returns {object} Controller
 */
export function createFollowController(map, {onFrame} = {}) {
    /** Geglättetes Ziel aus den GPS-Fixes (EMA). */
    let target = null;
    /** Tatsächlich dargestellte Kameraposition; läuft dem Ziel weich nach. */
    let camera = null;

    let lastFix = null;
    let compassHeading = null;
    /** Zielneigung der Kamera — Startwert, danach nur noch per Fingergeste. */
    let targetPitch = FOLLOW.pitch;
    let cameraPitch = FOLLOW.pitch;

    /** @type {'gps'|'compass'|null} */
    let headingSource = null;
    let targetHeading = null;
    /** Zeitstempel, bis zu dem nach einem Quellenwechsel träger geführt wird. */
    let switchEasingUntil = 0;

    /**
     * Anzahl Finger auf der Karte.
     *
     * Der Grund für diese Buchhaltung: `map.jumpTo()` ruft intern `stop()` und
     * bricht damit eine laufende Geste ab — bei einem Aufruf pro Frame kommt
     * kein Kneifen und kein Zwei-Finger-Neigen je durch. Solange Finger auf der
     * Karte liegen, schweigt der Loop; danach zieht er die Kamera weich zurück
     * auf die Position (Zoom und Neigung bleiben, wie der Nutzer sie gesetzt hat).
     */
    let touchCount = 0;
    /** Von der Bodenfreiheits-Sicherung gesetzte Obergrenze der Neigung. */
    let pitchCeiling = FOLLOW.pitchMax;
    let lastGuardAt = 0;
    /**
     * Gewünschte Kamerahöhe in Metern — die geführte Grösse.
     *
     * MapLibre kennt nur Zoom, und die Höhe hängt an Zoom *und* Neigung. Nimmt
     * die Bodenfreiheits-Sicherung die Neigung zurück, wanderte die Höhe mit
     * (bei 88° → 87° von 80 auf 150 m). Deshalb wird der Zoom nachgezogen:
     * eingestellt ist die Höhe, der Zoom ist Rechengrösse.
     */
    let targetHeight = FOLLOW.heightMeters;
    let heightAppliedAtPitch = null;
    /**
     * Geglätteter Geländeunterschied zwischen eigenem Standort und Blickpunkt,
     * in Metern (positiv, wenn man selbst höher steht). Er wird auf die
     * Zielhöhe aufgeschlagen, damit die eingestellte Höhe über der **eigenen**
     * Position gilt — siehe FOLLOW.heightTerrainEmaAlpha.
     */
    let gelaendeVersatz = 0;
    let versatzAngewendet = 0;
    /** Bildlage des eigenen Standorts, siehe FOLLOW.anchor. */
    let anchor = FOLLOW.anchor;

    let active = false;
    let frameHandle = null;
    let lastFrameTime = 0;
    /** Der Cockpit-Zoom wird nur beim ersten Start gesetzt (siehe start()). */
    let initialZoomSet = false;

    function isMoving(fix) {
        return fix.speed !== null && fix.speed >= FOLLOW.gpsHeadingMinSpeedMps;
    }

    /**
     * Quellenwahl mit Totbereich: erst über der GPS-Schwelle wird auf den
     * Bewegungsvektor umgeschaltet, erst unter der Kompass-Schwelle zurück.
     * Dazwischen bleibt die bisherige Quelle stehen.
     */
    function selectHeading(fix) {
        const speed = fix?.speed ?? null;
        const gpsHeading = fix?.heading ?? null;
        const gpsUsable = gpsHeading !== null && speed !== null && speed >= FOLLOW.gpsHeadingMinSpeedMps;
        const compassUsable = compassHeading !== null;

        if (gpsUsable) return {source: 'gps', heading: gpsHeading};
        if (compassUsable && (speed === null || speed <= FOLLOW.compassHeadingMaxSpeedMps)) {
            return {source: 'compass', heading: compassHeading};
        }
        // Totbereich: bisherige Quelle beibehalten, solange sie noch liefert.
        if (headingSource === 'gps' && gpsHeading !== null) return {source: 'gps', heading: gpsHeading};
        if (headingSource === 'compass' && compassUsable) return {source: 'compass', heading: compassHeading};
        if (compassUsable) return {source: 'compass', heading: compassHeading};
        return {source: headingSource, heading: targetHeading};
    }

    function updateHeadingTarget(now) {
        const selection = selectHeading(lastFix);
        if (selection.heading === null) return;
        if (selection.source !== headingSource) {
            // Erster Wechsel (noch keine Quelle) braucht keine Überblendung.
            if (headingSource !== null) switchEasingUntil = now + FOLLOW.headingSwitchDurationSeconds * 1000;
            headingSource = selection.source;
        }
        targetHeading = normalizeAngle(selection.heading);
    }

    /** Neuer GPS-Fix: EMA aktualisieren, Heading-Quelle neu bewerten. */
    function pushFix(fix) {
        lastFix = fix;
        const alpha = isMoving(fix) ? FOLLOW.positionEmaAlphaMoving : FOLLOW.positionEmaAlphaStatic;

        // Grosser Sprung (Tunnelausfahrt, Empfangssprung): nicht glätten,
        // sondern übernehmen — sonst kröche die Karte mit 15 % pro Fix nach.
        const jumped = target !== null
            && distanceMeters(fix, target) > FOLLOW.jumpDistanceMeters;
        if (target === null || jumped) {
            target = {lng: fix.lng, lat: fix.lat};
            camera = {lng: fix.lng, lat: fix.lat};
        } else {
            target = {
                lng: target.lng + alpha * (fix.lng - target.lng),
                lat: target.lat + alpha * (fix.lat - target.lat)
            };
        }
        updateHeadingTarget(performance.now());
    }

    /**
     * Neuer Kompasswert — geglättet und mit Totband.
     *
     * Zwei Stufen, weil eine nicht reicht: die exponentielle Glättung nimmt dem
     * Magnetometer das Rauschen, das Totband hält die Kamera bei Kleinstwerten
     * ganz still. Über die kürzeste Winkeldifferenz gerechnet, sonst dreht die
     * Glättung bei 359° → 1° einmal um die ganze Rose.
     */
    function pushCompassHeading(heading) {
        const raw = normalizeAngle(heading);
        if (compassHeading === null) {
            compassHeading = raw;
        } else {
            const delta = shortestAngleDelta(compassHeading, raw);
            if (Math.abs(delta) < FOLLOW.headingDeadbandDegrees) return;
            // Grosser Sprung = echte Drehung, kleiner = Rauschen. Nur Letzteres
            // muss gedämpft werden (siehe FOLLOW.compassFastDeltaDegrees).
            // Nur ein wirklich grosser Sprung darf die Glättung überspringen.
            // Einzelne Stufen des Magnetometers (bis etwa 16°) gehören nicht
            // dazu — siehe FOLLOW.compassJumpDeltaDegrees.
            const alpha = Math.abs(delta) >= FOLLOW.compassJumpDeltaDegrees
                ? FOLLOW.compassEmaAlphaFast
                : FOLLOW.compassEmaAlpha;
            compassHeading = normalizeAngle(compassHeading + alpha * delta);
        }
        updateHeadingTarget(performance.now());
    }

    /**
     * Kartenmittelpunkt so verschieben, dass die eigene Position bei
     * `anchor` = 0 in der Bildmitte und bei 1 am unteren Bildrand sitzt.
     *
     * **Gerechnet, nicht rückprojiziert.** Bis zum 5.9.2026 kamen die beiden
     * Bodenpunkte aus `map.unproject()`. Das ist bei aktivem Terrain kein
     * stabiles Rechenmittel: MapLibre hebt die Kamera um die Geländehöhe am
     * Kartenmittelpunkt — und genau den verschiebt diese Rechnung. Solange die
     * Kamera stillstand, fiel das kaum auf; sobald sie drehte, wanderte der
     * Ankerpunkt über wechselndes Gelände und der Versatz sprang mit.
     *
     * Am Gerät nachgemessen (Zürichberg, Kurs stabil bei 176°, Neigung und
     * Zoom konstant): der Kartenmittelpunkt sprang um **100 bis 200 Meter vor
     * und zurück**. Dass die Bewegung *oszillierte* statt zu rauschen, war der
     * entscheidende Hinweis — Sensorrauschen schwingt nicht.
     *
     * **Grenze:** gerechnet wird auf der Kartenebene, während `project()` auf
     * dem Gelände arbeitet. Bei fast waagrechtem Blick laufen beide
     * auseinander — über Talboden gemessen trifft der Anker bis 74° auf den
     * Prozentpunkt, bei 80° auf drei, bei 85° nur noch auf zwölf. Das ist der
     * Preis für die Stabilität und im Betriebsbereich (80°) nicht sichtbar.
     *
     * Die Geometrie steht ohnehin fest und braucht die Karte nicht: die Kamera
     * sitzt 1,5 Bildhöhen vom Mittelpunkt entfernt (nachgemessen, siehe
     * `metersPerPixel`), ihre Höhe über der Kartenebene ist der senkrechte
     * Anteil davon. Aus dem halben Gesichtsfeld — `atan(0,5 / 1,5)` = 18,435°,
     * derselbe Wert wie in der Herleitung zu `FOLLOW.pitch` — folgt der Winkel
     * zum gewünschten Bildpunkt und daraus die Strecke auf dem Boden.
     */
    function anchoredCenter(lng, lat) {
        if (anchor <= 0.001) return [lng, lat];
        const rad = Math.PI / 180;
        const hoehePx = map.getCanvas().clientHeight;
        const proPixel = metersPerPixel(map.getZoom(), lat);
        const neigung = cameraPitch * rad;
        // Halbes Gesichtsfeld aus dem Kameramodell: halbe Bildhöhe auf 1,5
        // Bildhöhen Abstand.
        const halbesFeld = Math.atan(0.5 / 1.5);
        const winkel = Math.atan(anchor * Math.tan(halbesFeld));
        const kameraHoehe = 1.5 * hoehePx * Math.cos(neigung) * proPixel;
        const roh = kameraHoehe * (Math.tan(neigung) - Math.tan(neigung - winkel));
        // Gedeckelt: sonst wächst mit der Kamerahöhe auch der Hebel, mit dem
        // jede Kursänderung das Bild seitlich schwenkt (siehe
        // FOLLOW.anchorMaxOffsetMeters).
        const versatz = Math.min(roh, FOLLOW.anchorMaxOffsetMeters);

        const kurs = map.getBearing() * rad;
        return [
            lng + (versatz * Math.sin(kurs)) / (111320 * Math.cos(lat * rad)),
            lat + (versatz * Math.cos(kurs)) / 110540
        ];
    }

    /** Zoom so setzen, dass die Kamera bei der aktuellen Neigung auf `targetHeight` steht. */
    function applyHeight() {
        // `targetHeight` ist die Höhe über dem eigenen Standort; das Modell
        // rechnet über der Kartenebene am Blickpunkt. Der Geländeunterschied
        // liegt dazwischen.
        const zoom = cockpitZoom(map.getCenter().lat, cameraPitch,
            targetHeight + gelaendeVersatz, map.getCanvas().clientHeight);
        versatzAngewendet = gelaendeVersatz;
        heightAppliedAtPitch = cameraPitch;
        map.jumpTo({zoom: Math.min(map.getMaxZoom(), Math.max(map.getMinZoom(), zoom))});
    }

    // Kneifen ist die andere Art, die Höhe zu verstellen — dann übernimmt der
    // Controller den neuen Wert, statt ihn im nächsten Bild zu überschreiben.
    map.on('zoom', (event) => {
        if (event?.originalEvent) {
            targetHeight = cameraHeightMeters(cameraPitch, map.getCenter().lat) - gelaendeVersatz;
            versatzAngewendet = gelaendeVersatz;
            heightAppliedAtPitch = cameraPitch;
        }
    });

    function clampPitch(pitch) {
        return Math.min(FOLLOW.pitchMax, Math.max(FOLLOW.pitchMin, pitch));
    }

    /**
     * Höhe der Kamera über der Ebene des Kartenmittelpunkts, in Metern.
     * Gleiches Modell wie beim Anker: Abstand 1,5 · Bildhöhe, davon der
     * senkrechte Anteil.
     */
    function cameraHeightMeters(pitchDegrees, lat) {
        const rad = Math.PI / 180;
        return 1.5 * map.getCanvas().clientHeight * Math.cos(pitchDegrees * rad)
            * metersPerPixel(map.getZoom(), lat);
    }

    /**
     * Sucht die steilste Neigung, bei der die Kamera noch über dem Gelände
     * steht. Die Kamera liegt hinter dem Mittelpunkt — dort wird gemessen,
     * nicht in der Bildmitte, denn dort sitzt sie ja nicht.
     */
    function updatePitchCeiling(now, center) {
        if (now - lastGuardAt < FOLLOW.terrainGuardIntervalMs) return;
        lastGuardAt = now;
        if (typeof map.queryTerrainElevation !== 'function') return;

        const rad = Math.PI / 180;
        const groundAtCenter = map.queryTerrainElevation(center);
        if (!Number.isFinite(groundAtCenter)) return;

        /*
         * Geländeunterschied zum eigenen Standort nachführen. Geglättet, damit
         * eine einzelne Geländekante den Zoom nicht springen lässt, und erst ab
         * `heightTerrainStepMeters` angewendet — jede Korrektur ist eine
         * sichtbare Bewegung.
         */
        if (target !== null) {
            const groundAtMe = map.queryTerrainElevation([target.lng, target.lat]);
            if (Number.isFinite(groundAtMe)) {
                gelaendeVersatz += (groundAtMe - groundAtCenter - gelaendeVersatz)
                    * FOLLOW.heightTerrainEmaAlpha;
                if (Math.abs(gelaendeVersatz - versatzAngewendet) > FOLLOW.heightTerrainStepMeters) {
                    applyHeight();
                }
            }
        }
        const bearing = map.getBearing() * rad;
        const scale = metersPerPixel(map.getZoom(), center.lat);

        for (let pitch = FOLLOW.pitchMax; pitch >= FOLLOW.pitchMin; pitch -= 2) {
            const back = 1.5 * map.getCanvas().clientHeight * Math.sin(pitch * rad) * scale;
            const cameraPoint = {
                lng: center.lng - (back * Math.sin(bearing)) / (111320 * Math.cos(center.lat * rad)),
                lat: center.lat - (back * Math.cos(bearing)) / 110540
            };
            const groundAtCamera = map.queryTerrainElevation(cameraPoint);
            const altitude = groundAtCenter + cameraHeightMeters(pitch, center.lat);
            if (!Number.isFinite(groundAtCamera)
                || altitude - groundAtCamera >= FOLLOW.terrainClearanceMeters) {
                pitchCeiling = pitch;
                return;
            }
        }
        pitchCeiling = FOLLOW.pitchMin;
    }

    /**
     * Der Nutzer hat die Neigung selbst gesetzt (zwei Finger parallel nach oben
     * oder unten). Das gilt ab sofort — die Kamera bleibt dort stehen, bis er
     * sie wieder verstellt. Die Lage des Geräts spielt keine Rolle.
     */
    function adoptManualPitch(pitch) {
        cameraPitch = pitch;
        targetPitch = pitch;
    }

    // Nur benutzergetriebene Pitch-Ereignisse tragen ein `originalEvent`; die
    // `jumpTo`-Aufrufe des Frame-Loops nicht. Sonst würde sich der Controller
    // im Kreis selbst eichen.
    map.on('pitch', (event) => {
        if (event?.originalEvent) adoptManualPitch(map.getPitch());
    });


    const canvas = map.getCanvasContainer();
    ['touchstart', 'touchmove', 'touchend', 'touchcancel'].forEach((type) => {
        canvas.addEventListener(type, (event) => {
            touchCount = event.touches.length;
        }, {passive: true});
    });

    function renderFrame(now) {
        frameHandle = requestAnimationFrame(renderFrame);
        // Finger auf der Karte: die Kamera gehört dem Nutzer. Ein `jumpTo`
        // während der Geste würde sie abbrechen (siehe touchCount).
        if (!active || target === null || touchCount > 0) {
            lastFrameTime = now;
            return;
        }
        /*
         * Fester Takt statt „so schnell wie möglich": alles unter
         * `frameIntervalMs` wird übersprungen, ohne `lastFrameTime` zu
         * verschieben. Der nächste Durchlauf rechnet damit mit dem echten
         * verstrichenen dt weiter — die Bewegung bleibt gleich schnell, nur der
         * Bildabstand wird gleichmässig (siehe FOLLOW.frameIntervalMs).
         */
        if (now - lastFrameTime < FOLLOW.frameIntervalMs) return;

        const dt = (now - lastFrameTime) / 1000;
        lastFrameTime = now;

        // War die App im Hintergrund, ist der alte Kamerastand veraltet: direkt
        // setzen statt hin animieren. dt selbst wird nicht gedeckelt, sonst
        // liefe die Interpolation bei niedriger Bildrate langsamer als
        // konfiguriert.
        const resuming = dt <= 0 || dt > FOLLOW.resumeSnapSeconds;
        camera = resuming ? {...target} : {
            lng: approach(camera.lng, target.lng, dt, FOLLOW.positionTauSeconds),
            lat: approach(camera.lat, target.lat, dt, FOLLOW.positionTauSeconds)
        };

        updatePitchCeiling(now, map.getCenter());
        if (targetPitch !== null) {
            const wanted = Math.min(targetPitch, pitchCeiling);
            cameraPitch = resuming
                ? wanted
                : approach(cameraPitch, wanted, dt, FOLLOW.pitchTauSeconds);
        } else {
            cameraPitch = Math.min(cameraPitch, pitchCeiling);
        }
        // Neigung geändert (Geste oder Bodenfreiheit)? Zoom nachziehen, damit
        // die eingestellte Höhe erhalten bleibt.
        if (heightAppliedAtPitch !== null && Math.abs(cameraPitch - heightAppliedAtPitch) > 0.5) {
            applyHeight();
        }
        const jumpOptions = {pitch: cameraPitch};

        if (targetHeading !== null) {
            /*
             * Dieselbe Unterscheidung noch einmal auf der Kameraseite: liegt
             * die Kamera weit vom Ziel, wird sie zügig nachgezogen; bei kleinen
             * Abweichungen bleibt sie träge und schluckt das Rauschen.
             */
            const kompassTau = Math.abs(shortestAngleDelta(map.getBearing(), targetHeading))
                >= FOLLOW.compassFastDeltaDegrees
                ? FOLLOW.headingTauCompassFastSeconds
                : FOLLOW.headingTauCompassSeconds;
            const tau = now < switchEasingUntil
                ? FOLLOW.headingSwitchTauSeconds
                : (headingSource === 'compass' ? kompassTau : FOLLOW.headingTauSeconds);
            jumpOptions.bearing = resuming
                ? targetHeading
                : approachAngle(map.getBearing(), targetHeading, dt, tau);
        }
        jumpOptions.center = anchoredCenter(camera.lng, camera.lat);
        map.jumpTo(jumpOptions);
        onFrame?.({lng: camera.lng, lat: camera.lat, heading: targetHeading});
    }

    /**
     * Verschieben und Drehen würden gegen den Frame-Takt anlaufen, solange
     * gefolgt wird. Zoom bleibt immer bedienbar — der Frame-Loop setzt den
     * Zoom nie, nur `start()` tut das einmalig.
     */
    function lockGesturesForFollowing(locked) {
        [map.dragPan, map.dragRotate, map.keyboard]
            .forEach((handler) => (locked ? handler?.disable() : handler?.enable()));
        map.scrollZoom?.enable();
        map.touchZoomRotate?.enable();
        // Zoom (kneifen) und Neigung (zwei Finger parallel) bleiben immer
        // bedienbar: der Frame-Loop setzt den Zoom nie, und eine von Hand
        // gesetzte Neigung eicht den Versatz, statt dagegen zu laufen.
        map.touchPitch?.enable();
        if (locked) map.touchZoomRotate?.disableRotation();
        else map.touchZoomRotate?.enableRotation();
    }

    return {
        pushFix,
        pushCompassHeading,

        /**
         * Kameralage relativ zum eigenen Standort, 0 (Übersicht) bis 1 (Kamera
         * auf dem eigenen Punkt). Wirkt sofort und in beiden Modi — der
         * Frame-Loop fasst die Polsterung nicht an, sie bleibt also stehen,
         * auch wenn danach gezoomt wird.
         */
        setAnchor(value) {
            anchor = Math.min(1, Math.max(0, value));
            // Im Tracking zieht der Frame-Loop im nächsten Bild nach; steht er
            // (Manuell-Modus), bleibt der Wert einfach gespeichert.
        },

        get anchor() {
            return anchor;
        },

        /**
         * Kamerahöhe über Grund in Metern. MapLibre kennt nur Zoom, also wird
         * er aus der gewünschten Höhe zurückgerechnet — bei der aktuellen
         * Neigung, denn flacher blicken hebt die Kamera bei gleichem Zoom.
         */
        setCameraHeight(meters) {
            targetHeight = Math.min(FOLLOW.heightMaxMeters,
                Math.max(FOLLOW.heightMinMeters, meters));
            applyHeight();
        },

        /** Aktuelle Kamerahöhe über der Ebene des Mittelpunkts, in Metern. */
        cameraHeight() {
            // Über dem eigenen Standort, nicht über dem Blickpunkt — sonst
            // zeigte das HUD eine andere Zahl, als der Regler einstellt.
            return cameraHeightMeters(cameraPitch, map.getCenter().lat) - gelaendeVersatz;
        },

        /** Zurück auf die eigene Position — mit der eingestellten Kameralage. */
        recenter() {
            if (target === null) return;
            map.easeTo({center: anchoredCenter(target.lng, target.lat), duration: 600});
        },

        start() {
            if (frameHandle === null) {
                lastFrameTime = performance.now();
                frameHandle = requestAnimationFrame(renderFrame);
            }
            active = true;
            lockGesturesForFollowing(true);
            // Cockpit-Zoom nur beim ersten Start setzen; danach bleibt er dem
            // Nutzer überlassen, weil der Frame-Loop ihn nicht anfasst. Ein
            // Folgen-aus/ein darf den selbst gewählten Zoom nicht zurückwerfen.
            const startPitch = targetPitch ?? FOLLOW.pitch;
            map.jumpTo({pitch: startPitch});
            if (!initialZoomSet) {
                // Startzustand als Höhe über Grund, nicht als Zoomstufe.
                applyHeight();
                initialZoomSet = true;
            }
        },

        stop() {
            active = false;
            if (frameHandle !== null) {
                cancelAnimationFrame(frameHandle);
                frameHandle = null;
            }
            lockGesturesForFollowing(false);
        },

        get isActive() {
            return active;
        },

        /** Momentaufnahme für das HUD. */
        getState() {
            return {
                fix: lastFix,
                position: target === null ? null : {...target},
                headingSource,
                heading: targetHeading,
                pitchCeiling,
                pitch: cameraPitch,
                hasPosition: target !== null
            };
        }
    };
}

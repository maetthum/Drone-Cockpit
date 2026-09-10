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
export function createFollowController(map, {onFrame, onHoeheUebernommen} = {}) {
    /** Geglättetes Ziel aus den GPS-Fixes (EMA). */
    let target = null;
    /**
     * Grundlage der Koppelnavigation: wann der letzte Fix kam, und mit welchem
     * Tempo und Kurs er unterwegs war. `target` ist die Positionsschätzung zu
     * genau diesem Zeitpunkt; alles danach wird gerechnet (siehe `koppelZiel`).
     */
    let letzterFixZeit = 0;
    let fahrtTempo = 0;
    let fahrtKurs = null;
    /** Tatsächlich dargestellte Kameraposition; läuft dem Ziel weich nach. */
    let camera = null;

    let lastFix = null;
    let compassHeading = null;
    /**
     * Geschätzte Drehrate in Grad pro Sekunde, geglättet — Grundlage des
     * Vorhalts gegen den Nachlauf beim Drehen (siehe `vorhalt`). Gemessen am
     * **Rohwert**, nicht am geglätteten Kurs: der geglättete hinkt ja gerade um
     * das nach, was hier ausgeglichen werden soll.
     */
    let drehrate = 0;
    let letzterRohKurs = null;
    let letzterRohZeit = 0;
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
     * Zoomstufe, auf die die Kamera zuläuft. Der Frame-Loop interpoliert
     * dorthin, statt sie in einem Bild zu setzen (siehe FOLLOW.zoomTauSeconds).
     */
    /** Zuletzt gerechneter Ankerversatz in Metern — nur fürs HUD/Messen. */
    let letzterAnkerVersatz = 0;
    /** Tracking-Lage über einen Ausflug in den Manuell-Modus hinweg. */
    let gemerkteLage = null;
    let zielZoom = null;
    /**
     * Läuft gerade ein `jumpTo` aus dem Frame-Loop? Dann stammt das
     * `zoom`-Ereignis von uns selbst und darf nicht als neue Vorgabe gelten —
     * sonst übernähme die Kamera ihren eigenen Zwischenwert und die
     * Interpolation bliebe stehen.
     */
    let eigeneKamerabewegung = false;
    /**
     * Geglätteter Geländeunterschied zwischen eigenem Standort und Blickpunkt,
     * in Metern (positiv, wenn man selbst höher steht). Er wird auf die
     * Zielhöhe aufgeschlagen, damit die eingestellte Höhe über der **eigenen**
     * Position gilt. Geglättet wird im Frame-Loop (FOLLOW.zoomTauSeconds).
     */
    let gelaendeVersatz = 0;
    /**
     * Zielwerte der beiden Versätze. Die Sicherung schreibt sie im 300-ms-Takt
     * fort, der Frame-Loop läuft weich darauf zu.
     *
     * **Sie gehen in jedes Bild ein** — über die Ankerrechnung in den
     * Mittelpunkt und über `applyHeight()` in den Zoom. Wurden sie nur im Takt
     * der Sicherung gesetzt, sprang der Mittelpunkt dreimal je Sekunde:
     * gemessen bei 130 km/h bis zu 6,2 m in einem Bild, wo 1,2 m anfallen.
     */
    let gelaendeVersatzZiel = 0;
    let hindernisVersatzZiel = 0;
    /**
     * Geglättete Anhebung in Metern, mit der die Kamera aus dem Gelände
     * freikommt (siehe FOLLOW.hindernisLiftMaxMeters). Null, sobald der
     * Kamerapunkt ohnehin frei liegt — im Flachland also immer.
     */
    let hindernisVersatz = 0;
    let versatzAngewendet = 0;

    /** Was zusätzlich zur eingestellten Höhe auf die Kamera kommt. */
    function gesamtVersatz() {
        return gelaendeVersatz + hindernisVersatz;
    }
    /** Bildlage des eigenen Standorts, siehe FOLLOW.anchor. */
    let anchor = FOLLOW.anchor;

    let active = false;
    let frameHandle = null;
    let lastFrameTime = 0;
    /** Ausgeführte Durchläufe der Kameraschleife, siehe getState. */
    let kameraTakte = 0;
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
        targetHeading = normalizeAngle(selection.heading + vorhalt());
    }

    /** Neuer GPS-Fix: EMA aktualisieren, Heading-Quelle neu bewerten. */
    function pushFix(fix) {
        lastFix = fix;
        const jetzt = performance.now();
        const alpha = isMoving(fix) ? FOLLOW.positionEmaAlphaMoving : FOLLOW.positionEmaAlphaStatic;

        /*
         * Erst die Fahrt bis jetzt weiterrechnen, dann den neuen Fix
         * einmischen. Die Reihenfolge ist der ganze Trick: geglättet wird
         * gegen die **vorhergesagte** Position, nicht gegen die eine Sekunde
         * alte. Sonst fiele die Karte bei jedem Fix um die Strecke zurück, die
         * die Vorhersage gerade zurückgelegt hat — aus dem Rucken nach vorn
         * würde ein Rucken nach hinten.
         */
        const vorhergesagt = koppelZiel(jetzt);

        // Grosser Sprung (Tunnelausfahrt, Empfangssprung): nicht glätten,
        // sondern übernehmen — sonst kröche die Karte mit 15 % pro Fix nach.
        const jumped = vorhergesagt !== null
            && distanceMeters(fix, vorhergesagt) > FOLLOW.jumpDistanceMeters;
        if (vorhergesagt === null || jumped) {
            target = {lng: fix.lng, lat: fix.lat};
            camera = {lng: fix.lng, lat: fix.lat};
        } else {
            target = {
                lng: vorhergesagt.lng + alpha * (fix.lng - vorhergesagt.lng),
                lat: vorhergesagt.lat + alpha * (fix.lat - vorhergesagt.lat)
            };
        }
        // Erst nach dem Einmischen: ab hier zählt die Zeit für die nächste
        // Vorhersage, und `target` ist die Schätzung für genau diesen Moment.
        letzterFixZeit = jetzt;
        fahrtTempo = fix.speed ?? 0;
        fahrtKurs = fix.heading ?? null;
        updateHeadingTarget(jetzt);
    }

    /**
     * Wo man jetzt sein dürfte — die letzte Schätzung um die seither gefahrene
     * Strecke weitergerechnet (Koppelnavigation).
     *
     * Gerechnet wird über den **GPS-Kurs**, nicht über den Kompass: gefragt ist,
     * wohin man sich bewegt, nicht wohin das Gerät zeigt. Im Stand und im
     * Schritttempo ist der GPS-Kurs unbrauchbar, dort wird nicht vorhergesagt —
     * dann gibt es auch nichts zu überbrücken.
     */
    function koppelZiel(now) {
        if (target === null) return null;
        if (fahrtKurs === null || fahrtTempo < FOLLOW.gpsHeadingMinSpeedMps) return target;
        const sekunden = Math.min((now - letzterFixZeit) / 1000, FOLLOW.koppelMaxSeconds);
        if (!(sekunden > 0)) return target;
        const strecke = fahrtTempo * sekunden;
        const rad = Math.PI / 180;
        const kurs = fahrtKurs * rad;
        return {
            lng: target.lng + (strecke * Math.sin(kurs)) / (111320 * Math.cos(target.lat * rad)),
            lat: target.lat + (strecke * Math.cos(kurs)) / 110540
        };
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
        const jetzt = performance.now();

        if (compassHeading === null) {
            compassHeading = raw;
        } else {
            const delta = shortestAngleDelta(compassHeading, raw);
            /*
             * **Kein `return` mehr im Totband.** Es sollte verhindern, dass
             * Kleinstwerte das Bild bewegen — es verhinderte aber zugleich, dass
             * `updateHeadingTarget` je wieder lief. Nach einer Drehung liegen
             * alle Folgewerte im Totband, der Zielkurs blieb also auf dem
             * Nachlauf stehen, den er im Moment des Anhaltens hatte, und die
             * Karte lief sekundenlang auf ein falsches Ziel zu. Sie kam nie an,
             * weil ihr niemand mehr sagte, wo „an" ist.
             *
             * Stattdessen wird der Rohwert im Totband nur nicht mehr
             * eingemischt: `compassHeading` bleibt stehen, der Zielkurs wird
             * aber weiterhin gesetzt — inklusive des abklingenden Vorhalts.
             */
            const imTotband = Math.abs(delta) < FOLLOW.headingDeadbandDegrees;
            // Grosser Sprung = echte Drehung, kleiner = Rauschen. Nur Letzteres
            // muss gedämpft werden (siehe FOLLOW.compassFastDeltaDegrees).
            // Nur ein wirklich grosser Sprung darf die Glättung überspringen.
            // Einzelne Stufen des Magnetometers (bis etwa 16°) gehören nicht
            // dazu — siehe FOLLOW.compassJumpDeltaDegrees.
            /*
             * Drei Fälle: ein echter Sprung wird fast übernommen, eine laufende
             * Drehung zügig nachgeführt, und nur der Stillstand bleibt so träge
             * wie bisher — dort ist die Trägheit die Rauschbekämpfung, überall
             * sonst ist sie der Nachlauf.
             */
            const dreht = Math.abs(drehrate) >= FOLLOW.kompassVorhalteTotDegrees;
            const alpha = Math.abs(delta) >= FOLLOW.compassJumpDeltaDegrees
                ? FOLLOW.compassEmaAlphaFast
                : (dreht ? FOLLOW.compassEmaAlphaDrehend : FOLLOW.compassEmaAlpha);
            /*
             * Im Totband wird mit dem trägen Alpha eingemischt statt gar nicht.
             * Gar nicht hiess: `compassHeading` blieb auf dem Nachlauf stehen,
             * den die Drehung hinterlassen hat, und die Karte konnte den Rest
             * nie mehr aufholen. Mit dem trägen Alpha bewegt ein Rauschwert von
             * 3° das Ergebnis um 0,18° — unsichtbar —, ein anliegender echter
             * Fehler wird aber abgebaut.
             */
            const wirksam = imTotband ? FOLLOW.compassEmaAlpha : alpha;
            compassHeading = normalizeAngle(compassHeading + wirksam * delta);
        }

        /*
         * Drehrate am **geglätteten** Kurs, nicht am Rohwert.
         *
         * Am Rohwert gemessen sah Rauschen wie eine Drehung aus: ±5° zwischen
         * zwei Werten sind rechnerisch über 100 °/s, die Totzone griff nicht
         * mehr, und der Vorhalt zappelte. Über den Ankerhebel wurden daraus im
         * Stand 30 Pixel Bildwandern statt 5.
         *
         * Der geglättete Kurs hinkt zwar nach — das war der ursprüngliche Grund
         * für den Rohwert —, aber seit `compassEmaAlphaDrehend` folgt er einer
         * echten Drehung zügig genug, während er im Stand ruhig bleibt. Genau
         * die Unterscheidung, auf die es hier ankommt.
         */
        if (letzterRohKurs !== null) {
            const dt = (jetzt - letzterRohZeit) / 1000;
            if (dt > 0.001) {
                const gemessen = shortestAngleDelta(letzterRohKurs, compassHeading) / dt;
                const geglaettet = drehrate + (gemessen - drehrate) * FOLLOW.drehrateEmaAlpha;
                /*
                 * Die Rate darf sich nur begrenzt schnell ändern — das bremst
                 * den Anlauf und glättet die Magnetometerstufen in einem.
                 *
                 * **Asymmetrisch:** Aufbauen langsam, Abbauen zügig. Eine
                 * symmetrische Grenze liesse die Karte beim Loslassen rund eine
                 * Sekunde nachdrehen und damit über das Ziel hinausschiessen.
                 */
                const bremst = Math.abs(geglaettet) < Math.abs(drehrate);
                const grenze = (bremst ? FOLLOW.drehverzoegerungMax
                    : FOLLOW.drehbeschleunigungMax) * dt;
                drehrate += Math.max(-grenze, Math.min(grenze, geglaettet - drehrate));
            }
        }
        letzterRohKurs = compassHeading;
        letzterRohZeit = jetzt;
        updateHeadingTarget(jetzt);
    }

    /**
     * Wieviel Grad die Karte der gemessenen Richtung vorauseilen soll, um den
     * festen Nachlauf der Dämpfung auszugleichen.
     *
     * Nur für den Kompass: der GPS-Kurs ist bereits die Bewegungsrichtung und
     * durchläuft diese Glättung nicht. Die Totzone wird **abgezogen**, nicht
     * verglichen — so wächst der Vorhalt stetig aus null heraus, statt beim
     * Überschreiten einer Schwelle zu springen.
     */
    /**
     * Drehrate ohne den Anteil, der im Stand blosses Rauschen ist.
     *
     * **Weich abgezogen, nicht verglichen.** Ein Schwellwertschalter liesse den
     * Wert beim Überschreiten springen; so wächst er stetig aus null heraus.
     * Ohne diese Totzone integriert der Ratenvorschub im Stillstand das
     * Rauschen der Schätzung: gemessen wanderte das Bild dann 13 statt 4 Pixel.
     */
    function wirksameDrehrate() {
        if (headingSource !== 'compass') return 0;
        return Math.sign(drehrate)
            * Math.max(0, Math.abs(drehrate) - FOLLOW.kompassVorhalteTotDegrees);
    }

    function vorhalt() {
        return wirksameDrehrate() * FOLLOW.kompassVorhalteSekunden;
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
    /**
     * Blickpunkt für die Geländemessung — seit dem Umbau auf `padding` schlicht
     * die eigene Position, denn dort steht der Kartenmittelpunkt.
     *
     * Damit ist der Geländeunterschied zwischen beiden null: die eingestellte
     * Höhe gilt unmittelbar über dem eigenen Punkt, ohne Umrechnung. Das war
     * vorher eine eigene Rechnung samt Rückkopplungsgefahr.
     */
    function bezugsBlickpunkt() {
        return target === null ? null : {lng: target.lng, lat: target.lat};
    }

    function anchoredCenter(lng, lat) {
        return [lng, lat];
    }

    /**
     * Optische Mitte nach unten schieben, damit der eigene Punkt dort sitzt,
     * wo der Regler ihn haben will.
     *
     * Ein Anteil `f` der Bildhöhe entspricht `padding.top = Höhe · 2 · (f − ½)`
     * — nachgemessen linear: 0 px → 50 %, 300 → 65,5 %, 600 → 81,1 %,
     * 869 → 95,0 %, und zwar bei jeder Blickrichtung identisch.
     */
    function setzePadding() {
        const hoehePx = map.getCanvas().clientHeight;
        const oben = Math.max(0, hoehePx * anchor * (2 * FOLLOW.anchorMaxAnteil - 1));
        eigeneKamerabewegung = true;
        map.setPadding({top: oben, bottom: 0, left: 0, right: 0});
        eigeneKamerabewegung = false;
    }

    /** Zoom so setzen, dass die Kamera bei der aktuellen Neigung auf `targetHeight` steht. */
    function applyHeight({sofort = false} = {}) {
        // `targetHeight` ist die Höhe über dem eigenen Standort; das Modell
        // rechnet über der Kartenebene am Blickpunkt. Der Geländeunterschied
        // liegt dazwischen.
        const zoom = cockpitZoom(map.getCenter().lat, cameraPitch,
            targetHeight + gesamtVersatz(), map.getCanvas().clientHeight);
        versatzAngewendet = gesamtVersatz();
        heightAppliedAtPitch = cameraPitch;
        zielZoom = Math.min(map.getMaxZoom(), Math.max(map.getMinZoom(), zoom));
        // Beim ersten Aufbau sofort setzen — dort gibt es nichts, wovon aus
        // interpoliert werden könnte, und ein Anlauf kostete nur Kacheln.
        if (sofort) {
            eigeneKamerabewegung = true;
            map.jumpTo({zoom: zielZoom});
            eigeneKamerabewegung = false;
        }
    }

    // `padding` hängt an der Bildhöhe: bei Drehung des Geräts oder Wechsel in
    // den Vollbildmodus neu setzen, sonst sitzt der Punkt falsch.
    map.on('resize', setzePadding);

    /*
     * Jede Zoomänderung, die **nicht** von der Kameraführung selbst kommt, gilt
     * als neue Vorgabe: das Kneifen des Nutzers ebenso wie ein Setzen von
     * aussen. Ohne das zöge der Frame-Loop den Zoom im nächsten Bild wieder auf
     * seinen alten Zielwert zurück — seit die Höhe interpoliert wird, tut er
     * das in jedem Bild und nicht mehr nur bei Schwellwertüberschreitungen.
     */
    map.on('zoom', () => {
        if (eigeneKamerabewegung) return;
        targetHeight = cameraHeightMeters(cameraPitch, map.getCenter().lat) - gesamtVersatz();
        versatzAngewendet = gesamtVersatz();
        heightAppliedAtPitch = cameraPitch;
        zielZoom = map.getZoom();
        /*
         * Nach aussen melden: die Höhe kommt jetzt von aussen (Kneifen oder
         * ein Setzen von aussen), und der Regler muss mitwandern. Ein
         * `zoom`-Ereignis allein taugt dafür nicht — seit der Zoom weich
         * nachgeführt wird, feuert es auch während des eigenen Einlaufens.
         */
        onHoeheUebernommen?.();
    });

    /**
     * Zeitkonstante für den GPS-Kurs, nach Tempo gestaffelt: direkt über der
     * Schwelle träge (der Kurs selbst wandert dort mehrere Grad je Fix),
     * ab `headingTauGpsFullSpeedMps` der volle, schnelle Wert.
     */
    function gpsHeadingTau(speed) {
        const {gpsHeadingMinSpeedMps: minSpeed, headingTauGpsFullSpeedMps: fullSpeed,
            headingTauGpsSlowSeconds: slowTau, headingTauSeconds: fastTau} = FOLLOW;
        if (speed >= fullSpeed) return fastTau;
        if (speed <= minSpeed) return slowTau;
        return slowTau + (fastTau - slowTau) * (speed - minSpeed) / (fullSpeed - minSpeed);
    }

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
     * Höhe über der Mittelpunktsebene, bei der der Kamerapunkt frei über dem
     * Gelände liegt — als Differenz zur eingestellten Höhe.
     *
     * Iterativ, weil Steigen die Kamera nicht nur hebt, sondern zugleich um
     * `Höhe · tan(Neigung)` weiter nach hinten schiebt: der geprüfte Punkt
     * wandert mit, unter Umständen noch tiefer in den Hang. Vier Runden
     * genügen, gemessen konvergiert es nach zwei bis drei.
     *
     * Gerechnet wird ab der **eingestellten** Höhe, nicht ab der gerade
     * geltenden — sonst zöge eine bereits angewendete Anhebung sich selbst in
     * die nächste Messung und der Wert schwänge.
     */
    function noetigeAnhebung(center, groundAtCenter, pitchDegrees) {
        const rad = Math.PI / 180;
        const bearing = map.getBearing() * rad;
        const tanNeigung = Math.tan(pitchDegrees * rad);
        const basis = targetHeight + gelaendeVersatz;
        let hoehe = basis;
        for (let runde = 0; runde < 4; runde++) {
            const back = hoehe * tanNeigung;
            const groundAtCamera = map.queryTerrainElevation({
                lng: center.lng - (back * Math.sin(bearing)) / (111320 * Math.cos(center.lat * rad)),
                lat: center.lat - (back * Math.cos(bearing)) / 110540
            });
            // Ausserhalb der Geländeabdeckung gibt es nichts, worin die Kamera
            // stecken könnte.
            if (!Number.isFinite(groundAtCamera)) return 0;
            const noetig = groundAtCamera + FOLLOW.terrainClearanceMeters - groundAtCenter;
            if (noetig <= hoehe) break;
            hoehe = noetig;
        }
        return hoehe - basis;
    }

    /**
     * Hält die Kamera über dem Gelände. Die Kamera liegt hinter dem
     * Mittelpunkt — dort wird gemessen, nicht in der Bildmitte, denn dort
     * sitzt sie ja nicht.
     *
     * Erste Wahl ist **Steigen**: die eingestellte Neigung bleibt, der Blick
     * geht weiter nach vorn. Reicht das nicht (siehe
     * FOLLOW.hindernisLiftMaxMeters), wird wie früher die Neigung gesenkt —
     * dann kippt der Blick nach unten, aber die Kamera kommt frei.
     */
    /**
     * Geländehöhe, gemittelt über den Punkt und vier Nachbarn.
     *
     * **Räumlich glätten statt zeitlich.** Beim Drehen wandert der Bezugspunkt
     * über das Gelände, und die abgetastete Höhe springt an Kachelgrenzen und
     * Rasterpunkten des Höhenmodells. Jeder solche Sprung erzeugt eine
     * gedämpfte Korrektur, die als Ausschlag im Bild sichtbar wird — am
     * Mitschnitt vom 7.9.2026 als Bildänderung von 2,2 bis 4,9 über einem
     * Grundwert von 0,5, weich abklingend über eine halbe Sekunde.
     *
     * Zeitlich stärker zu dämpfen würde die Korrektur nur verschleppen. Die
     * Mittelung nimmt der Abtastung die Stufen, ohne Verzögerung zu kosten.
     */
    function gemitteltesGelaende({lng, lat}) {
        const rad = Math.PI / 180;
        const d = FOLLOW.gelaendeAbtastungMeter;
        const dLng = d / (111320 * Math.cos(lat * rad));
        const dLat = d / 110540;
        const punkte = [
            {lng, lat},
            {lng: lng + dLng, lat}, {lng: lng - dLng, lat},
            {lng, lat: lat + dLat}, {lng, lat: lat - dLat}
        ];
        let summe = 0;
        let anzahl = 0;
        for (const p of punkte) {
            const h = map.queryTerrainElevation(p);
            if (Number.isFinite(h)) {
                summe += h;
                anzahl++;
            }
        }
        return anzahl === 0 ? NaN : summe / anzahl;
    }

    function updatePitchCeiling(now, center) {
        if (now - lastGuardAt < FOLLOW.terrainGuardIntervalMs) return;
        lastGuardAt = now;
        if (typeof map.queryTerrainElevation !== 'function') return;

        const rad = Math.PI / 180;
        // Gegen den rückkopplungsfreien Bezugspunkt messen, nicht gegen den
        // laufenden Mittelpunkt (siehe bezugsBlickpunkt).
        const bezug = bezugsBlickpunkt() ?? center;
        const groundAtCenter = gemitteltesGelaende(bezug);
        if (!Number.isFinite(groundAtCenter)) return;

        /*
         * Geländeunterschied zum eigenen Standort nachführen. Nur der Zielwert
         * wird hier gesetzt; geglättet wird im Frame-Loop, damit weder die
         * Ankerrechnung noch der Zoom einen 300-ms-Sprung sehen.
         */
        if (target !== null) {
            const groundAtMe = map.queryTerrainElevation([target.lng, target.lat]);
            if (Number.isFinite(groundAtMe)) {
                // Nur das Ziel setzen; geglättet wird im Frame-Loop, damit die
                // Ankerrechnung keinen 300-ms-Sprung sieht.
                gelaendeVersatzZiel = groundAtMe - groundAtCenter;
            }
        }

        /*
         * Steigen statt kippen. Wie beim Geländeversatz nur der Zielwert; die
         * Glättung sitzt im Frame-Loop.
         */
        const wunschNeigung = Math.min(FOLLOW.pitchMax, targetPitch ?? cameraPitch);
        const anhebung = noetigeAnhebung(center, groundAtCenter, wunschNeigung);
        const gedeckelt = Math.min(anhebung, FOLLOW.hindernisLiftMaxMeters);
        hindernisVersatzZiel = gedeckelt;
        /*
         * Erst ab `heightTerrainStepMeters` nachziehen. Das Totband wirkt gegen
         * die Amplitude, nicht gegen die Stufigkeit — Letztere erledigt die
         * Interpolation im Frame-Loop. Ohne das Totband folgte die Höhe jeder
         * Geländewelle und die Zoomspanne während einer Drehung wuchs von 1,08
         * auf 1,88 Stufen.
         */
        if (Math.abs(gesamtVersatz() - versatzAngewendet) > FOLLOW.heightTerrainStepMeters) {
            applyHeight();
        }
        if (anhebung <= FOLLOW.hindernisLiftMaxMeters) {
            pitchCeiling = FOLLOW.pitchMax;
            return;
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
        /*
         * Finger auf der Karte: die Kamera gehört dem Nutzer. Ein `jumpTo`
         * während der Geste würde sie abbrechen (siehe touchCount).
         *
         * **Und danach noch der Nachlauf.** MapLibre zoomt und dreht nach dem
         * Loslassen der Finger weiter aus; `touchCount` ist dann schon null,
         * der Loop lief wieder an und sein `jumpTo` brach die Bewegung ab —
         * der Zoom blieb auf dem Wert des Loslassens stehen. Gemessen: statt
         * auf 13,78 kam er nur auf 15,26 von 15,28, also praktisch zurück.
         * Genau das war die Meldung „springt immer wieder zurück".
         *
         * `isMoving`, nicht `isEasing`: Letzteres steht zwar in MapLibres
         * Quelltext, ist auf der Karteninstanz dieser Fassung aber nicht
         * vorhanden — der Aufruf warf und riss die ganze Schleife mit. Der
         * Typprüfung wegen belassen, falls sich das je ändert.
         */
        const kartenBewegungLaeuft = typeof map.isMoving === 'function' && map.isMoving();
        if (!active || target === null || touchCount > 0 || kartenBewegungLaeuft) {
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

        // Zähler für das HUD: wie oft die Kamera tatsächlich weiterrückt.
        // Zeichnen tut MapLibre öfter (siehe main.js, Zeile „Takt").
        kameraTakte++;
        const dt = (now - lastFrameTime) / 1000;
        lastFrameTime = now;

        // War die App im Hintergrund, ist der alte Kamerastand veraltet: direkt
        // setzen statt hin animieren. dt selbst wird nicht gedeckelt, sonst
        // liefe die Interpolation bei niedriger Bildrate langsamer als
        // konfiguriert.
        const resuming = dt <= 0 || dt > FOLLOW.resumeSnapSeconds;
        // Nicht auf den zuletzt empfangenen Punkt zulaufen, sondern auf den,
        // an dem man jetzt sein dürfte — sonst steht die Karte zwischen zwei
        // Fixes still (siehe FOLLOW.koppelMaxSeconds).
        const ziel = koppelZiel(now);
        camera = resuming ? {...ziel} : {
            lng: approach(camera.lng, ziel.lng, dt, FOLLOW.positionTauSeconds),
            lat: approach(camera.lat, ziel.lat, dt, FOLLOW.positionTauSeconds)
        };

        /*
         * Die Geländeversätze weich nachführen, bevor irgendetwas sie liest.
         * Die Sicherung setzt nur die Zielwerte (siehe gelaendeVersatzZiel).
         */
        if (!resuming) {
            const tauVersatz = FOLLOW.gelaendeVersatzTauSeconds;
            gelaendeVersatz = approach(gelaendeVersatz, gelaendeVersatzZiel, dt, tauVersatz);
            hindernisVersatz = approach(hindernisVersatz, hindernisVersatzZiel, dt, tauVersatz);
        } else {
            gelaendeVersatz = gelaendeVersatzZiel;
            hindernisVersatz = hindernisVersatzZiel;
        }
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
                : (headingSource === 'compass' ? kompassTau : gpsHeadingTau(fahrtTempo));
            /*
             * **Mit der Rate drehen, nicht dem Ziel hinterherjagen.**
             *
             * Das Magnetometer liefert grobe Stufen. Wer nur auf den letzten
             * Wert zuläuft, übernimmt deren Unregelmässigkeit ins Bild: bei
             * einer gleichmässigen Drehung von 45 °/s und 4°-Stufen schwankte
             * der Drehschritt je Bild zwischen 0,67° und 2,19°, Faktor 3,3.
             * Genau das ist das nervöse Zucken.
             *
             * Stattdessen wird zuerst mit der geschätzten Drehrate
             * weitergedreht — die ist geglättet und damit gleichmässig — und
             * erst von dort aus sanft auf das Ziel korrigiert. Derselbe Aufbau
             * wie die Koppelnavigation bei der Position: erst weiterrechnen,
             * dann einmischen.
             *
             * Nur für den Kompass; der GPS-Kurs ist bereits stufenfrei.
             */
            const vorgedreht = normalizeAngle(map.getBearing() + wirksameDrehrate() * dt);
            jumpOptions.bearing = resuming
                ? targetHeading
                : approachAngle(vorgedreht, targetHeading, dt, tau);
        }
        /*
         * Höhe weich nachführen statt springen. Ohne das setzte die
         * Bodenfreiheits-Sicherung den Zoom dreimal je Sekunde in einem
         * einzigen Bild (siehe FOLLOW.zoomTauSeconds).
         */
        if (zielZoom !== null) {
            jumpOptions.zoom = resuming
                ? zielZoom
                : approach(map.getZoom(), zielZoom, dt, FOLLOW.zoomTauSeconds);
        }
        // Mit dem Kurs dieses Bildes verschieben, nicht mit dem des letzten.
        jumpOptions.center = anchoredCenter(camera.lng, camera.lat,
            jumpOptions.bearing ?? map.getBearing());
        eigeneKamerabewegung = true;
        map.jumpTo(jumpOptions);
        eigeneKamerabewegung = false;
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
        /*
         * Im Tracking auf den eigenen Punkt zoomen, nicht auf die Fingermitte:
         * der Anker sitzt meist tief im Bild (padding.top), die Finger eher
         * mittig — ohne das wanderte der Pfeil beim Kneifen davon und konnte
         * unten aus dem Bild fallen. `around: 'center'` ist MapLibres eigene
         * Option dafür; „center" meint dabei den durch `padding` verschobenen
         * optischen Mittelpunkt, also genau die Ankerposition.
         */
        const zoomAnchor = locked ? {around: 'center'} : undefined;
        map.scrollZoom?.enable(zoomAnchor);
        map.touchZoomRotate?.enable(zoomAnchor);
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
            // Die Bildlage steckt im `padding`, nicht im Frame-Loop — sie gilt
            // deshalb sofort, auch im Manuell-Modus.
            setzePadding();
        },

        get anchor() {
            return anchor;
        },

        /**
         * Kamerahöhe über Grund in Metern. MapLibre kennt nur Zoom, also wird
         * er aus der gewünschten Höhe zurückgerechnet — bei der aktuellen
         * Neigung, denn flacher blicken hebt die Kamera bei gleichem Zoom.
         */
        /**
         * Die Tracking-Lage sichern, bevor der Manuell-Modus sie überschreibt.
         *
         * Dort gehört die Kamera dem Finger, und jede Zoom- oder
         * Neigungsänderung wird als neue Einstellung übernommen — sonst zeigte
         * der Höhenregler nach dem Kneifen Unsinn. Beim Zurückwechseln soll
         * aber die Lage von vorher gelten, nicht die des Ausflugs.
         */
        merkeLage() {
            gemerkteLage = {targetHeight, anchor, targetPitch, cameraPitch};
        },

        /** Gegenstück zu `merkeLage`; ohne vorherige Sicherung wirkungslos. */
        stelleLageHer() {
            if (gemerkteLage === null) return;
            targetHeight = gemerkteLage.targetHeight;
            anchor = gemerkteLage.anchor;
            targetPitch = gemerkteLage.targetPitch;
            cameraPitch = gemerkteLage.cameraPitch;
            setzePadding();
            // Sofort, nicht eingelaufen: die Rückkehr ins Tracking ist eine
            // gewollte Ansage.
            applyHeight({sofort: true});
        },

        setCameraHeight(meters) {
            targetHeight = Math.min(FOLLOW.heightMaxMeters,
                Math.max(FOLLOW.heightMinMeters, meters));
            /*
             * **Sofort, nicht eingelaufen.** Die weiche Nachführung des Zooms
             * ist gegen springende Geländekorrekturen gedacht; eine
             * Reglerbewegung ist eine gewollte Ansage und soll unmittelbar
             * gelten. Dasselbe Prinzip wie beim Anker und beim Kneifen.
             */
            applyHeight({sofort: true});
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
            const ziel = koppelZiel(performance.now());
            map.easeTo({center: anchoredCenter(ziel.lng, ziel.lat), duration: 600});
        },

        start() {
            if (frameHandle === null) {
                lastFrameTime = performance.now();
                frameHandle = requestAnimationFrame(renderFrame);
            }
            active = true;
            lockGesturesForFollowing(true);
            setzePadding();
            // Cockpit-Zoom nur beim ersten Start setzen; danach bleibt er dem
            // Nutzer überlassen, weil der Frame-Loop ihn nicht anfasst. Ein
            // Folgen-aus/ein darf den selbst gewählten Zoom nicht zurückwerfen.
            const startPitch = targetPitch ?? FOLLOW.pitch;
            map.jumpTo({pitch: startPitch});
            if (!initialZoomSet) {
                // Startzustand als Höhe über Grund, nicht als Zoomstufe.
                applyHeight({sofort: true});
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
                // Vorhergesagt, nicht zuletzt empfangen: der Marker sitzt
                // sonst 36 m hinter der Kamera und rutscht bei jedem Fix
                // sichtbar nach vorn.
                position: target === null ? null : koppelZiel(performance.now()),
                headingSource,
                heading: targetHeading,
                pitchCeiling,
                hindernisVersatz,
                gelaendeVersatz,
                ankerVersatz: letzterAnkerVersatz,
                kameraTakte,
                pitch: cameraPitch,
                hasPosition: target !== null
            };
        }
    };
}

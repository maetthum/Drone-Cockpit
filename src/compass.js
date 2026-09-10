/**
 * Adapter für die Gerätelage (DeviceOrientation): Kompasskurs *und* Neigung.
 *
 * iOS verlangt `DeviceOrientationEvent.requestPermission()` aus einer echten
 * Nutzergeste heraus — deshalb hängt der Start am Button in main.js und nicht
 * am Seitenaufbau.
 */

/** @returns {boolean} true, wenn das Gerät überhaupt Orientierungsdaten anbietet. */
export function isCompassAvailable() {
    return typeof window.DeviceOrientationEvent !== 'undefined';
}

/**
 * Fordert die Freigabe an. Auf Plattformen ohne `requestPermission` (Android,
 * Desktop) gilt der Zugriff als erlaubt.
 *
 * @returns {Promise<'granted'|'denied'|'unavailable'>}
 */
export async function requestCompassPermission() {
    if (!isCompassAvailable()) return 'unavailable';
    const request = window.DeviceOrientationEvent.requestPermission;
    if (typeof request !== 'function') return 'granted';
    try {
        const result = await request.call(window.DeviceOrientationEvent);
        return result === 'granted' ? 'granted' : 'denied';
    } catch {
        // requestPermission wirft, wenn der Aufruf nicht aus einer Geste kam.
        return 'denied';
    }
}

/**
 * Rechnet ein Orientierungs-Event in einen Rohkurs um (Grad, 0 = Nord, im
 * Uhrzeigersinn), bezogen auf die **Geräteoberkante im Hochformat**.
 *
 * @param {DeviceOrientationEvent} event
 * @returns {number|null}
 */
function readRawHeading(event) {
    // iOS liefert den fertigen, missweisungskorrigierten Kurs.
    if (Number.isFinite(event.webkitCompassHeading)) return event.webkitCompassHeading;
    // Android/Chrome: nur absolute Werte sind ein Kompasskurs; alpha zählt
    // gegen den Uhrzeigersinn und muss gespiegelt werden.
    if (event.absolute === true && Number.isFinite(event.alpha)) return (360 - event.alpha) % 360;
    return null;
}

/**
 * Lage des Bildschirms gegenüber der natürlichen Geräteausrichtung, in Grad
 * im Uhrzeigersinn.
 *
 * `screen.orientation` gibt es auf iOS seit 16.4; `window.orientation` ist der
 * Alt-Pfad (dort steht -90 für „im Uhrzeigersinn gedreht", was nach der
 * Normalisierung 270 ergibt — konsistent mit dem Standard, aber nicht auf einem
 * Gerät nachgeprüft).
 */
function readScreenAngle() {
    const angle = window.screen?.orientation?.angle;
    if (Number.isFinite(angle)) return angle;
    return (((window.orientation ?? 0) % 360) + 360) % 360;
}

/**
 * Korrigiert den Rohkurs um die Bildschirmlage.
 *
 * Herleitung (iOS, Zielplattform): `webkitCompassHeading` bezieht sich auf die
 * Oberkante des Geräts im Hochformat und wird *nicht* mitgedreht, wenn der
 * Bildschirm rotiert. Wird das Gerät um 90° gegen den Uhrzeigersinn gekippt
 * (`screen.orientation.angle === 90`), zeigt die Geräteoberkante nach links —
 * die vom Nutzer als „vorne" wahrgenommene Bildschirmoberkante liegt also 90°
 * im Uhrzeigersinn davon. Deshalb: Kurs = Rohkurs + Bildschirmwinkel.
 *
 * Damit ist die Halterungslage egal: hoch wie quer stimmt der Kurs. Das HUD
 * zeigt Rohwert, Winkel und Ergebnis an, damit der erste Gerätetest die
 * Annahme in Sekunden bestätigt oder widerlegt.
 */
function correctForScreenAngle(rawHeading, screenAngle) {
    return (rawHeading + screenAngle) % 360;
}

/**
 * Startet das Lauschen auf den Kompasskurs.
 *
 * Die *Neigung* des Geräts wird bewusst nicht ausgewertet: sie steuerte
 * zeitweise die Kameraneigung, was in der Halterung mehr störte als half — im
 * Fahrzeug wackelt das Gerät, und die Ansicht wackelte mit. Die Neigung stellt
 * man einmal mit zwei Fingern ein, danach bleibt sie stehen.
 *
 * @param {(state: {heading: number, raw: number, screenAngle: number}) => void} onOrientation
 * @returns {() => void} Stopp-Funktion
 */
export function watchOrientation(onOrientation) {
    if (!isCompassAvailable()) return () => {};

    const handler = (event) => {
        const raw = readRawHeading(event);
        if (raw === null) return;
        const screenAngle = readScreenAngle();
        onOrientation({heading: correctForScreenAngle(raw, screenAngle), raw, screenAngle});
    };
    // `deviceorientationabsolute` ist auf Android die verlässlichere Quelle,
    // iOS kennt nur `deviceorientation`. Beide anmelden, readHeading filtert.
    window.addEventListener('deviceorientationabsolute', handler);
    window.addEventListener('deviceorientation', handler);

    return () => {
        window.removeEventListener('deviceorientationabsolute', handler);
        window.removeEventListener('deviceorientation', handler);
    };
}

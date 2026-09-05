/**
 * Adapter für `navigator.geolocation`. Liefert rohe Fixes weiter und hält keine
 * Kameralogik — Glättung und Quellenwahl passieren in follow.js.
 */

/**
 * @typedef {object} Fix
 * @property {number} lng
 * @property {number} lat
 * @property {number|null} altitude       Meter über Ellipsoid/WGS84, falls verfügbar
 * @property {number|null} altitudeAccuracy
 * @property {number} accuracy            horizontale Genauigkeit in Metern
 * @property {number|null} speed          Meter pro Sekunde
 * @property {number|null} heading        Grad, nur bei Bewegung gesetzt
 * @property {number} timestamp
 */

const WATCH_OPTIONS = {
    enableHighAccuracy: true,
    // Kein Cache: veraltete Fixes lassen die Kamera zurückspringen.
    maximumAge: 0,
    timeout: 10000
};

/**
 * Einmaliger, grober Fix für den Kartenstart — noch bevor der Nutzer auf
 * „Cockpit starten" tippt.
 *
 * Bewusst mit anderen Optionen als `watchPosition`: für die Wahl der Kacheln
 * genügen ein paar hundert Meter, und ein zwischengespeicherter Fix aus
 * Funkzelle oder WLAN kommt sofort statt nach Sekunden am GPS. Die
 * Kameraführung bekommt weiterhin volle Genauigkeit ohne Cache.
 *
 * Liefert `null` statt zu werfen: ohne Position startet die Karte auf der
 * Übersicht, das ist ein gültiger Zustand und kein Fehler.
 *
 * @param {PositionOptions} options
 * @returns {Promise<{lng: number, lat: number}|null>}
 */
export function getStartPosition(options) {
    return new Promise((resolve) => {
        // Der Smoke-Test ersetzt `navigator.geolocation` durch eine Attrappe,
        // die nur `watchPosition` kennt — und ältere Geräte kennen gar nichts.
        if (typeof navigator.geolocation?.getCurrentPosition !== 'function') {
            resolve(null);
            return;
        }
        let settled = false;
        const finish = (value) => {
            if (settled) return;
            settled = true;
            resolve(value);
        };
        // Eigene Frist zusätzlich zu `options.timeout`: iOS meldet einen
        // verweigerten Zugriff mitunter gar nicht zurück, und darauf darf die
        // Karte nicht endlos warten.
        setTimeout(() => finish(null), options.timeout);
        navigator.geolocation.getCurrentPosition(
            (position) => finish({lng: position.coords.longitude, lat: position.coords.latitude}),
            () => finish(null),
            options
        );
    });
}

/**
 * Startet die Positionsverfolgung.
 *
 * @param {(fix: Fix) => void} onFix
 * @param {(error: GeolocationPositionError) => void} onError
 * @returns {() => void} Stopp-Funktion
 */
export function watchPosition(onFix, onError) {
    if (!navigator.geolocation) {
        onError(new Error('Dieses Gerät liefert keine Standortdaten.'));
        return () => {};
    }

    const watchId = navigator.geolocation.watchPosition(
        (position) => {
            const c = position.coords;
            onFix({
                lng: c.longitude,
                lat: c.latitude,
                altitude: Number.isFinite(c.altitude) ? c.altitude : null,
                altitudeAccuracy: Number.isFinite(c.altitudeAccuracy) ? c.altitudeAccuracy : null,
                accuracy: c.accuracy,
                // speed/heading sind laut Spezifikation null, solange das Gerät
                // keinen Bewegungsvektor bilden kann (typisch im Stand).
                speed: Number.isFinite(c.speed) ? c.speed : null,
                heading: Number.isFinite(c.heading) ? c.heading : null,
                timestamp: position.timestamp
            });
        },
        onError,
        WATCH_OPTIONS
    );

    return () => navigator.geolocation.clearWatch(watchId);
}

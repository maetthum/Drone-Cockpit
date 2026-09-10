/**
 * Bildschirmsperre verhindern, solange das Cockpit läuft.
 *
 * Im Fahrzeug ist die Karte minutenlang nur zu betrachten, ohne dass sie
 * jemand berührt — genau dann dunkelt das Gerät ab und sperrt. Die Screen
 * Wake Lock API hält den Bildschirm wach; iOS kann das seit 16.4, auch in der
 * zum Homescreen gelegten PWA.
 *
 * **Die Sperre muss neu angefordert werden.** Das Betriebssystem gibt sie
 * automatisch frei, sobald die Seite in den Hintergrund gerät — beim Wechsel
 * in eine andere App, aber auch, wenn der Nutzer selbst kurz sperrt. Ohne das
 * Neuanfordern bei `visibilitychange` wäre sie nach dem ersten Wegschalten
 * für den Rest der Sitzung verloren, und das fiele erst auf, wenn der
 * Bildschirm mitten in der Fahrt ausgeht.
 */

/**
 * @param {(text: string) => void} melde Einmalige Meldung, falls das Gerät
 *   die Sperre nicht kennt oder verweigert.
 */
export function keepAwake(melde) {
    if (!('wakeLock' in navigator)) {
        melde('Bildschirmsperre lässt sich auf diesem Gerät nicht verhindern (iOS ab 16.4).');
        return;
    }

    /** @type {WakeLockSentinel|null} */
    let sentinel = null;
    /** Nur die erste Absage melden — sonst bei jedem Wegschalten ein Banner. */
    let bereitsGemeldet = false;

    async function anfordern() {
        // Im Hintergrund lehnt der Browser die Anforderung ab; der
        // `visibilitychange`-Aufruf holt sie nach.
        if (sentinel !== null || document.visibilityState !== 'visible') return;
        try {
            sentinel = await navigator.wakeLock.request('screen');
            // Freigabe durch das System: Feld leeren, damit die nächste
            // Anforderung wieder durchgeht.
            sentinel.addEventListener('release', () => {
                sentinel = null;
            });
        } catch (error) {
            sentinel = null;
            if (!bereitsGemeldet) {
                bereitsGemeldet = true;
                melde(`Bildschirm bleibt nicht wach: ${error?.message ?? error}`);
            }
        }
    }

    document.addEventListener('visibilitychange', anfordern);
    anfordern();
}

/**
 * Einzige Quelle der Wahrheit für Endpunkte, Layer-IDs und Tuning-Konstanten.
 * Kein anderes Modul darf URLs oder Magic Numbers hart kodieren.
 *
 * ACHTUNG — nicht verifizierte Werte sind mit VERIFY markiert: die Build-Session
 * hat keinen Netzzugang zu *.geo.admin.ch (Egress-Policy), die URL-Muster
 * stammen aus der Spezifikation bzw. dem üblichen geo.admin-WMTS-Schema und
 * müssen einmal auf einem echten Gerät gegengeprüft werden.
 */

/**
 * Abdeckung der Schweizer Datensätze (Landesgrenze plus Grenzsaum).
 *
 * An einer Stelle, weil drei Verbraucher dieselben Zahlen brauchen: das Terrain
 * synthetisiert daraus seine Verfügbarkeit, und Basemap wie Overlays halten
 * MapLibre damit davon ab, ausserhalb überhaupt Kacheln anzufordern.
 *
 * Ohne die Grenze an den Sources lief die Übersicht in Dutzende HTTP 400 —
 * eine Kachelreihe wie z8/y87 beginnt bei 50° N, dort gibt es schlicht keine
 * Luftbilder. Aufgefallen ist das erst beim Messen: MapLibre meldet
 * fehlgeschlagene Rasterkacheln nicht, sie fehlen einfach stumm.
 */
export const COVERAGE = {west: 5.6, south: 45.5, east: 11.0, north: 48.2};

/** Dieselbe Abdeckung in MapLibres Source-Schreibweise. */
export const COVERAGE_BOUNDS = [COVERAGE.west, COVERAGE.south, COVERAGE.east, COVERAGE.north];

/** Quantized-Mesh-Terrain von swisstopo (3D-Tiles-Endpunkt, kein Token nötig). */
export const TERRAIN = {
    layerJsonUrl: 'https://3d.geo.admin.ch/ch.swisstopo.terrain.3d/v1/layer.json',
    // swisstopos layer.json führt kein `available`-Array; das Plugin synthetisiert
    // die Verfügbarkeit über diese Bounds (Schweiz + Grenzsaum) bis maxZoom.
    boundsOverride: COVERAGE,
    maxZoom: 14,
    attribution: 'Terrain: © swisstopo',
    // Keine Überhöhung: die Zonenvolumen stehen in echten Metern über Grund,
    // ein gestrecktes Gelände würde sie gegenüber dem Bild verschieben.
    exaggeration: 1
};

/** Basemap: swisstopo-Luftbild als WMTS-Raster. VERIFY: Layer-ID/Time/Format. */
export const BASEMAP = {
    id: 'swissimage',
    tiles: ['https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/current/3857/{z}/{x}/{y}.jpeg'],
    tileSize: 256,
    minzoom: 0,
    maxzoom: 19,
    attribution: '© swisstopo'
};

/**
 * Startansicht, bis die eigene Position bekannt ist.
 *
 * Hier stand bis zum 4.9.2026 eine feste Testkamera im Lauterbrunnental, mitten
 * im Cockpit-Blick. Nachgemessen: **476 Kachelanfragen samt vollem Terrain-
 * Resampling für einen Ort, den niemand je zu sehen bekam** — die echte
 * Umgebung wurde erst nach dem Tippen auf „Cockpit starten" geladen, und bis
 * dahin war der Hauptthread mit dem falschen Ort beschäftigt. Das war der
 * grösste Posten der rund zehn Sekunden bis zum ersten Bild.
 *
 * Deshalb wird die Position jetzt **vor** dem Kartenbau bestimmt und die Karte
 * gleich dort aufgebaut: zuerst die zuletzt bekannte aus dem Speicher (kostet
 * nichts und ist im Regelfall vorhanden), sonst ein grober Fix.
 */
export const START_VIEW = {
    /**
     * Rückfall, wenn keine Position zu bekommen ist: die ganze Schweiz, flach
     * und weit heraus. Bewusst so gewählt, dass es wenige Kacheln sind und das
     * Terrain fast nichts zu resampeln hat — eine Übersicht ist billig, ein
     * Cockpit-Blick am falschen Ort nicht.
     */
    overview: {center: [8.23, 46.80], zoom: 7, pitch: 0, bearing: 0},
    /**
     * Grober Fix genügt zur Kachelwahl und kommt viel schneller als ein
     * hochgenauer: `enableHighAccuracy: false` nimmt Funkzellen und WLAN statt
     * auf das GPS zu warten, `maximumAge` lässt einen zwischengespeicherten
     * Fix zu. Für die Kameraführung gilt weiterhin volle Genauigkeit
     * (siehe geolocation.js).
     */
    fixOptions: {enableHighAccuracy: false, maximumAge: 600000, timeout: 2500},
    /** Schlüssel und Höchstalter der gespeicherten letzten Position. */
    storageKey: 'cockpit:last-position',
    maxAgeMs: 30 * 24 * 3600 * 1000,
    /** Seltener als das wird die Position nicht weggeschrieben. */
    storeIntervalMs: 10000
};

/**
 * Vorladen der Kacheln, die als Nächstes gebraucht werden.
 *
 * Beim Fahren kommt der Ausschnitt immer von vorn ins Bild: was gleich
 * gebraucht wird, steht Sekunden vorher fest. Diese Kacheln werden deshalb
 * vorab geholt und landen über den Service-Worker im Kachelspeicher.
 */
export const PREFETCH = {
    /**
     * Was in welcher Reihenfolge vorgeladen wird.
     *
     * Die Reihenfolge **ist** die Priorität: der Ring um den eigenen Standort
     * zuerst, danach in Blickrichtung immer weiter hinaus. Was man gleich unter
     * sich hat, muss stehen, bevor der Horizont schön wird.
     *
     * `zoomAbschlag` gröbert mit der Entfernung. Das ist kein Sparen an der
     * falschen Stelle, sondern deckungsgleich mit dem, was MapLibre später
     * selbst anfordert: bei Neigung 80° deckt ein Bildschirmpixel in der Ferne
     * ein Vielfaches der Fläche ab, dort wird ohnehin eine gröbere Stufe
     * gezeichnet. Ein feiner Kachelsatz zehn Kilometer voraus wäre schlicht
     * verworfen worden.
     *
     * `ring` ist der Radius in Kacheln um den Zielpunkt: 1 ergibt einen
     * 3 × 3-Block, 2 einen 5 × 5.
     */
    stufen: [
        // Rund um den Standort — gilt auch im Stand, ganz ohne bekannten Kurs.
        // Grösstes Kontingent: das hier ist der Boden unter den Füssen.
        {aheadMeters: 0, zoomAbschlag: 0, ring: 1, deckel: 24},
        // Blickrichtung, gestaffelt. 1500 m sind bei Referenztempo 120 km/h
        // rund 45 Sekunden Vorlauf.
        {aheadMeters: 1500, zoomAbschlag: 0, ring: 1, deckel: 16},
        {aheadMeters: 4000, zoomAbschlag: 2, ring: 1, deckel: 12},
        {aheadMeters: 10000, zoomAbschlag: 4, ring: 2, deckel: 12}
    ],
    /**
     * Deckel je Durchgang. Vorgeladenes darf nie mit dem konkurrieren, was
     * gerade sichtbar werden soll.
     *
     * Zusätzlich zum `deckel` je Stufe, der verhindert, dass der Nahbereich
     * allein alles aufbraucht. Ohne ihn kam die Ferne erst nach der nächsten
     * Fahrtstrecke dran und im Stand nie — nachgemessen: der Ring um den
     * Standort füllte 39 von 48 Plätzen.
     */
    maxTilesPerRun: 64,
    /** Frühestens so oft, und erst nach dieser Strecke seit dem letzten Mal. */
    minIntervalMs: 3000,
    minDistanceMeters: 250,
    /** Höchstzahl gemerkter URLs, damit die Merkliste nicht unbegrenzt wächst. */
    memory: 3000
};

/**
 * Kameraführung im Live-Betrieb (Phase 2).
 *
 * Glättung in zwei Stufen, weil ein einziger Filter beides nicht kann:
 *  1. EMA über die rohen GPS-Fixes gegen Jitter — mit *adaptivem* Alpha. Ein
 *     fixes, kleines Alpha würde bei 1 Hz und Tempo 80 mehrere Sekunden
 *     hinterherhinken (≈ 20 m/s × 3 s ≈ 60 m). Im Stand ist Trägheit erwünscht,
 *     in Fahrt ist sie ein Fehler.
 *  2. Exponentielle Annäherung pro Frame, damit die 1-Hz-Sprünge nicht als
 *     Ruckeln sichtbar werden.
 */
export const FOLLOW = {
    /**
     * Blickrichtung im Cockpit: fast waagrecht, nicht von oben herab. So sieht
     * man, was vor einem liegt, statt der Dachlandschaft darunter.
     *
     * Der eigene Punkt sitzt bei `anchor: 1` immer am unteren Bildrand. Wie
     * weit die Kamera dann hinter einem steht, folgt aus Höhe und Neigung:
     * `Abstand = Höhe / tan((90° − Neigung) + 18,435°)`, wobei 18,435° das
     * halbe Gesichtsfeld ist (nachgemessen, siehe `follow.js`).
     *
     * Umgestellt heisst das `Höhe = Abstand · tan((90° − Neigung) + 18,435°)`.
     * Gesetzt ist der Wunsch vom Gerät: **Neigung 80°, Abstand 620 m** —
     * daraus folgen 336 m Höhe (620 · tan 28,435°).
     *
     * Frühere Einstellungen desselben Tages, zum Vergleich: 50 m Höhe bei 89°
     * ergab 142 m Abstand; 150 m bei 78° ergab 243 m.
     *
     * Zum Vergleich die frühere Messreihe bei 150 m Höhe:
     *
     * ```
     *   Neigung   Blick voraus   Zoom
     *      55°         53 m      19,0
     *      63°         76 m      18,6
     *      70°        117 m      18,2
     *      78°        243 m      17,5
     *      85°        738 m      16,3
     * ```
     *
     * Waagrecht (90°) ginge nur, wenn der eigene Punkt aus dem Bild fällt —
     * bei waagrechtem Blick liegt der Boden unterhalb des Bildrands. 78° ist
     * der Kompromiss: nahe an waagrecht, eigener Punkt noch sichtbar. Zwei
     * Finger stellen es jederzeit um.
     */
    pitch: 80,
    /**
     * Die Kamera übernimmt die Neigung des Geräts 1:1: hält man das iPad
     * aufrecht, blickt die Karte zum Horizont und die nahen Berge stehen im
     * Bild; kippt man es flach, wird daraus die Aufsicht. Geklammert, weil
     * MapLibre über 85° nicht hinausgeht und unter `pitchMin` das Gelände
     * ohnehin flach wirkt — dort meist nur die Halterung, nicht die Absicht.
     */
    /**
     * Untergrenze bewusst hoch: unter etwa 55° kippt die Ansicht in die
     * Aufsicht, und darum geht es hier nicht.
     *
     * Obergrenze über 85°: MapLibre 6 lässt bis 180° zu. Darüber wird es aber
     * unbrauchbar — die Kamera sitzt bei Pitch p nur `1,5 · Bildhöhe · cos p ·
     * Massstab` über dem Boden und steckt dann im nächsten Hügel. 88° ist der
     * gemessene Kompromiss: praktisch waagrecht, Kamera noch über Grund.
     */
    pitchMin: 55,
    pitchMax: 89,
    /** Träger als die Blickrichtung: Handzittern soll das Bild nicht kippen. */
    pitchTauSeconds: 0.35,

    /**
     * Bodenfreiheit der Kamera.
     *
     * Bei fast waagrechtem Blick sitzt die Kamera nur knapp über Grund und
     * rutscht in ansteigendem Gelände hinein — man sieht den Berg dann von
     * innen. Reicht die Freiheit nicht, wird die Neigung so weit zurück-
     * genommen, bis sie wieder passt: flacher blicken hebt die Kamera.
     */
    terrainClearanceMeters: 25,
    /**
     * Obergrenze des Ankerversatzes in Metern.
     *
     * Der Versatz wächst mit der Kamerahöhe — und mit ihm der Hebel, mit dem
     * jede Kursänderung das Bild zur Seite schwenkt. Nachgerechnet, was eine
     * Kompassstufe von 3° an seitlichem Schwenk erzeugt:
     *
     * ```
     *    336 m Kamerahöhe →  1,3 km Versatz →   67 m
     *    800 m            →  3,1 km         →  160 m
     *   2600 m            →  9,9 km         →  521 m
     * ```
     *
     * Bei hoher Kamera wurde daraus ein ausgeprägtes seitliches Rucken, das
     * keine Glättung mehr einfangen kann — vier Dämpfungsvarianten gemessen,
     * die Unruhe blieb. Der Deckel begrenzt den Hebel auf rund 105 m je
     * Kompassstufe.
     *
     * Der Preis: über dieser Höhe sitzt der eigene Punkt nicht mehr am unteren
     * Bildrand, sondern wandert zur Bildmitte — die Ansicht geht mit
     * zunehmender Höhe vom Blick nach vorn in die Aufsicht über. Das ist dort
     * ohnehin die ehrlichere Darstellung: aus 2,6 km Höhe ist ein
     * „Cockpit-Blick" keiner mehr.
     *
     * (Ersetzt `anchorMaxOffsetFraction`, das mit der Umstellung von
     * `unproject()` auf die gerechnete Geometrie gegenstandslos wurde.)
     */
    anchorMaxOffsetMeters: 2000,
    /** Prüftakt: die Geländeabfrage muss nicht mit der Bildrate laufen. */
    terrainGuardIntervalMs: 300,
    /**
     * Die eingestellte Höhe gilt über der **eigenen Position**.
     *
     * MapLibre hebt die Kamera bei aktivem Terrain um die Geländehöhe am
     * Kartenmittelpunkt — und der liegt rund einen Kilometer voraus. Ohne
     * Ausgleich hing die Höhe damit am Gelände dort statt an dem, worüber man
     * selbst steht: bei 336 m Einstellung nachgemessen 324 m über sich im
     * Flachland, aber 380 m im Talboden, weil der Blickpunkt dort höher lag.
     *
     * Ausgeglichen wird der Unterschied zwischen beiden Geländehöhen — aber
     * **geglättet und mit Totband**, denn jede Korrektur ändert den Zoom und
     * ist damit eine sichtbare Bewegung. Lieber ein paar Meter Abweichung als
     * eine Höhe, die im Relief dauernd nachregelt.
     */
    heightTerrainEmaAlpha: 0.15,
    /** Erst ab dieser Änderung des Ausgleichs wird der Zoom nachgezogen. */
    heightTerrainStepMeters: 15,

    /**
     * Kamerahöhe über dem eigenen Punkt, einstellbar in Metern.
     *
     * MapLibre koppelt die Kamerahöhe an den Zoom — der Regler rechnet also in
     * Metern und setzt daraus den Zoom. Das ist im Cockpit die verständlichere
     * Grösse: „400 m über mir" sagt mehr als „Zoomstufe 14,2".
     *
     * Der Bereich ist bewusst weit und wird logarithmisch abgegriffen, damit
     * unten fein und oben grob eingestellt werden kann.
     */
    heightMinMeters: 20,
    heightMaxMeters: 4000,
    /**
     * Startzustand als **Höhe über Grund**, nicht als Zoomstufe.
     *
     * Der Zoom bestimmt in MapLibre die Kamerahöhe *und* den Abstand nach
     * hinten, und beides hängt unterschiedlich an Zoom und Neigung. Gerechnet
     * für ein iPhone (844 px Bildhöhe, Breite 47°):
     *
     * ```
     *  Neigung   Zoom   Kamerahöhe   Kamera hinter mir
     *      85°   13.8       820 m          5,8 km
     *      88°   13.8       328 m          5,2 km
     *      88°   15.5       100 m          1,6 km
     *      88°   16.5        51 m          0,8 km
     * ```
     *
     * Der Abstand nach hinten hängt fast nur am Zoom, die Höhe an beidem. Weit
     * herausgezoomt steht die Kamera also kilometerweit hinter einem und
     * hunderte Meter hoch — das wirkt wie eine Luftaufnahme, nicht wie der
     * Blick aus dem Fahrzeug. 100 m Höhe bei 88° trifft es besser; in die
     * Weite sieht man trotzdem, weil der Blick fast waagrecht liegt.
     */
    heightMeters: 336,
    /** EMA-Gewicht für neue Fixes: träge im Stand, schnell in Fahrt. */
    positionEmaAlphaStatic: 0.15,
    positionEmaAlphaMoving: 0.6,
    /**
     * Wo der eigene Standort im Bild sitzt, 0…1.
     *
     * 0 = Bildmitte: man sieht gleich viel vor und hinter sich (Übersicht).
     * 1 = unterer Bildrand: hinter einem wird nichts mehr gezeigt, die Kamera
     * steht praktisch auf dem eigenen Punkt und blickt nach vorn.
     *
     * Umgesetzt über einen **verschobenen Kartenmittelpunkt**, nicht über
     * MapLibres `padding`. Padding war der erste Weg und sah richtig aus, liess
     * aber den Himmel stehen, wo er war: der freigeräumte Bereich blieb
     * ungezeichnet und damit schwarz — bei 60 % ein Drittel des Bildes. Am
     * Gerät gemessen, siehe Wissensbasis.
     *
     * Der Zoom bleibt unberührt; von der gewählten Lage aus lässt sich frei
     * weiterzoomen.
     */
    anchor: 1,
    /**
     * Fester Takt der Kameraführung, in Millisekunden.
     *
     * **Gleichmässigkeit schlägt Höhe.** Aus einem iPhone-Video (60 fps,
     * Frame für Frame ausgewertet) kamen im Mittel 37 fps — aber ungleichmässig:
     * 70 × ein Frame Abstand, 41 × zwei, 19 × drei. Genau diese Schwankung wird
     * als Ruckeln wahrgenommen, nicht die Bildrate an sich.
     *
     * Statt 60 fps anzustreben und zwischen 20 und 60 zu schwanken, wird die
     * Kamera bewusst nur alle 33 ms nachgeführt. Auf einem 60-Hz-Schirm ist das
     * exakt jeder zweite Bildtakt, auf einem 120-Hz-Schirm jeder vierte — in
     * beiden Fällen ein gleichmässiger Abstand. Dazwischen bleibt dem Gerät
     * Zeit, die Kacheln zu zeichnen.
     *
     * Die Interpolation rechnet weiterhin mit dem *echten* `dt`, die Bewegung
     * läuft also unverändert schnell ab — nur in gröberen, dafür gleichmässigen
     * Schritten.
     *
     * **28 und nicht 33**, obwohl 33 ms das Ziel sind: die Schwelle muss unter
     * dem Zielabstand liegen. Bei 33 verwarf ein Bildtakt, der mit etwas Jitter
     * knapp darunter ankam (32,9 ms), seine Runde — und der nächste kam erst
     * 16,7 ms später. Gemessen schlug das als p90 von 49 ms durch, also genau
     * als der Judder, der hier abgestellt werden soll. Mit 28 greift auf einem
     * 60-Hz-Schirm zuverlässig jeder zweite Takt und auf 120 Hz jeder vierte.
     */
    frameIntervalMs: 28,
    /** Zeitkonstante der Frame-Interpolation von Position und Blickrichtung. */
    positionTauSeconds: 0.25,
    headingTauSeconds: 0.2,
    /**
     * Deutlich träger, sobald die Blickrichtung vom Magnetometer kommt.
     *
     * Im Stand und im Schritttempo ist der Kompass die einzige Quelle, und er
     * rauscht — im Fahrzeug zusätzlich durch Karosserie und Elektronik. Weil
     * die Kamera vor dem eigenen Punkt steht, wird aus wenigen Grad Rauschen
     * ein sichtbarer Schwenk: bei 1 km Vorlage sind 5° rund 87 m Versatz. Der
     * GPS-Kurs braucht diese Trägheit nicht, er ist von Natur aus ruhig.
     *
     * **Von 0,9 auf 3,0 erhöht (5.9.2026)**, zusammen mit `compassEmaAlpha`
     * (0,2 → 0,08) und `headingDeadbandDegrees` (2 → 4). Anlass war ein
     * gemeldetes Zittern, das weder von der Bildrate noch vom GPS kam.
     * Nachgemessen im Stand mit `anchor: 1` und ±8° Kompassrauschen, wie weit
     * das Bild wandert:
     *
     * ```
     *   GPS allein (±5 m)                    1,1 m   ← unschuldig
     *   Kompass allein (±8°)                41,5 m   ← die Ursache
     *   dieselbe Störung bei anchor 0        0,5 m   ← der Anker ist der Hebel
     * ```
     *
     * Und der Zielkonflikt, mit gleichbleibender Störung gemessen:
     *
     * ```
     *   τ 0,9 · 0,20 · 2°   14,0 m   Drehung um 90°: 2,1 s
     *   τ 2,0 · 0,12 · 3°    9,4 m                   4,4 s
     *   τ 2,0 · 0,12 · 3°    9,4 m                   4,4 s   ← gesetzt
     *   τ 3,0 · 0,08 · 4°    3,6 m                   6,7 s
     *   τ 4,0 · 0,06 · 5°    3,6 m                   9,2 s   ← bringt nichts mehr
     * ```
     *
     * **Zuerst stand hier τ 3,0**, das stärkste sinnvolle Mass. Der Smoke-Test
     * hat es widerlegt: eine echte 180°-Drehung kam nur noch zu 126° an, die
     * Kompass-Lagekorrektur war nicht mehr messbar. τ 2,0 ist der Mittelweg —
     * zwei Drittel des Zitterns weg, echte Drehungen noch brauchbar.
     *
     * Die Trägheit ist vertretbar, weil der Kompass **nur im Stand und im
     * Schritttempo** die Quelle ist; ab 2 km/h übernimmt der GPS-Kurs mit
     * `headingTauSeconds` (0,2 s).
     */
    headingTauCompassSeconds: 4.0,
    /**
     * Ab dieser Abweichung gilt die Änderung als **echte Drehung**, nicht als
     * Rauschen — dann wird schnell nachgeführt statt gedämpft.
     *
     * Der Grund: eine feste Dämpfung kann nur eines von beidem. Stark genug
     * gegen das Kompassrauschen war sie so träge, dass die Blickrichtung im
     * Tracking spürbar hinterherhing; schnell genug für echte Drehungen liess
     * sie das Bild zittern. Magnetometerrauschen bewegt sich im Bereich weniger
     * Grad, eine Kopf- oder Fahrzeugdrehung um ein Vielfaches mehr — daran
     * lassen sich die beiden Fälle trennen.
     *
     * Dasselbe Muster nutzt die Position bereits mit
     * `positionEmaAlphaStatic`/`-Moving`.
     */
    compassFastDeltaDegrees: 14,
    /**
     * Ab welchem **Einzelsprung** des Rohwerts die Glättung nachgibt.
     *
     * Deutlich höher als `compassFastDeltaDegrees`, und das ist der Kern: am
     * Gerät nachgemessen (Videomitschnitt, Tempo 0, HUD offen) liefert das
     * Magnetometer keine gleichmässige Kurve, sondern Stufen — 245° → 239° →
     * 223° → 219° → 218° innerhalb einer Sekunde, also ein Einzelsprung von
     * **16°** mitten in einer ruhigen Drehung. Lag die Schwelle bei 14°, wurde
     * genau dieser Sprung für eine echte Drehung gehalten und ruckartig
     * übernommen. Das war der sichtbare Ruck.
     *
     * Eine wirkliche Drehung erkennt man nicht am Einzelsprung, sondern daran,
     * dass die Abweichung *anhält* — und darauf reagiert die Kameraseite über
     * `compassFastDeltaDegrees`. Der Rohwert darf deshalb ruhig träge bleiben.
     */
    compassJumpDeltaDegrees: 30,
    /** Zeitkonstante und Glättung, sobald es als echte Drehung gilt. */
    headingTauCompassFastSeconds: 0.4,
    compassEmaAlphaFast: 0.6,
    /** Glättung der rohen Kompasswerte, bevor sie überhaupt zum Ziel werden. */
    compassEmaAlpha: 0.06,
    /**
     * Unterhalb dieser Änderung bleibt die Blickrichtung stehen. Fängt das
     * letzte Zittern ab, ohne eine echte Drehung merklich zu verzögern.
     */
    headingDeadbandDegrees: 3,

    /**
     * Quellenwahl mit Hysterese: über `gpsHeadingMinSpeedMps` zählt der
     * GPS-Bewegungsvektor, unter `compassHeadingMaxSpeedMps` das Magnetometer,
     * dazwischen bleibt die bisherige Quelle stehen. Ohne diesen Totbereich
     * flattert die Quelle im Schritttempo hin und her.
     * 2,0 km/h = 0,556 m/s (Schwelle aus der Spezifikation), 1,2 km/h = 0,333 m/s.
     */
    gpsHeadingMinSpeedMps: 0.556,
    compassHeadingMaxSpeedMps: 0.333,
    /**
     * Nach einem Quellenwechsel wird die Blickrichtung kurz träger nachgeführt,
     * damit der Sprung zwischen Magnetometer- und GPS-Kurs nicht als Ruckler
     * sichtbar wird.
     */
    headingSwitchTauSeconds: 0.9,
    headingSwitchDurationSeconds: 1.2,

    /**
     * Frame-Abstand, ab dem nicht mehr interpoliert, sondern direkt auf die
     * Zielwerte gesetzt wird. Trifft zu, wenn die App im Hintergrund war: dann
     * ist der alte Kamerastand veraltet, und eine Animation dorthin wäre falsch.
     * Ein blosser Deckel auf dt würde stattdessen die Interpolation verlangsamen,
     * sobald die Bildrate einbricht.
     *
     * Grosszügig gewählt: eine Rückkehr aus dem Hintergrund dauert Sekunden,
     * ein Bildratenhänger (Kachel-Dekodierung, langsame GPU) auch mal ein
     * halbes. Zu klein gewählt, springt die Kamera bei jedem Hänger statt zu
     * überblenden.
     */
    resumeSnapSeconds: 2,

    /**
     * Springt die Position weiter als das, ist es kein Rauschen mehr, sondern
     * ein Ortswechsel — Tunnelausfahrt, Empfangssprung, Wiederaufnahme nach
     * langer Pause. Dann wird die Glättung übersprungen und direkt gesetzt.
     * Sonst kröche die Karte mit 15 % pro Fix hinterher: bei einem Sprung über
     * 70 km wäre sie eine halbe Minute unterwegs.
     */
    jumpDistanceMeters: 500,

    /** Ab dieser Horizontalgenauigkeit gilt der Fix als unzuverlässig (Meter). */
    poorAccuracyMeters: 30
};

/**
 * Sperr- und Hinweisflächen als Raster über dem Terrain (Phase 4a). MapLibre
 * drapiert sie bei aktivem Terrain automatisch über das Gelände.
 *
 * Am 3.9.2026 alle IDs gegen das echte geo.admin gegengeprüft (Kachel bzw.
 * GetMap über der Schweiz, HTTP 200). Entscheidend ist `service`: nicht jeder
 * Layer liegt als WMTS vor. `ch.bazl.luftfahrthindernis` ist WMS-only und
 * antwortete am WMTS-Endpunkt mit „Unsupported Layer" — als WMTS eingebunden
 * blieb das Overlay stumm leer.
 *
 * `enabled` ist die Voreinstellung. Naturschutzgebiete sind aus, weil sie sich
 * grossflächig mit den beiden BAFU-Layern überlagern und jedes zusätzliche
 * Raster Kachel-Traffic und Compositing auf dem Telefon kostet.
 */
export const OVERLAYS = [
    // Die massgebliche Drohnenkarte des BAZL — steht bewusst zuoberst im Panel.
    {id: 'drohnen', label: 'Einschränkungen für Drohnen', layer: 'ch.bazl.einschraenkungen-drohnen', service: 'wmts', enabled: true},
    /*
     * Wildruhezonen sind die eine Naturschutzkategorie, die die BAZL-Karte
     * **nicht** führt: sie sind kantonal. Am Trüebsee nachgemessen — der
     * Schutzlayer meldet zwei Zonen, die Drohnenkarte an derselben Stelle
     * keine. Deshalb bleibt er, während Jagdbanngebiete, Nationalpark,
     * Vogelreservate und Pro-Natura-Gebiete entfernt wurden (siehe unten).
     */
    {id: 'wildruhezonen', label: 'Wildruhezonen', layer: 'ch.bafu.wrz-wildruhezonen_portal', service: 'wmts', enabled: true},
    // Wo andere Drohnen unterwegs sind: genehmigte BVLOS-Flüge. Kein Verbot,
    // sondern Verkehr — und damit das, was die Verbotskarte nicht zeigt.
    {id: 'uas-aktivitaet', label: 'UAS-Aktivitätszonen', layer: 'ch.bazl.uas-aktivitaetszonen', service: 'wms', enabled: true},
    // Gefahrenzonen der Armee samt Schiesstagen und -zeiten.
    {id: 'schiessanzeigen', label: 'Schiessanzeigen + Gefahrenzonen', layer: 'ch.vbs.schiessanzeigen', service: 'wmts', enabled: true},
    /*
     * `ch.vbs.sperr-gefahrenzonenkarte` wurde am 5.9.2026 wieder entfernt: der
     * Layer ist trotz seines Namens **kein Overlay, sondern eine vollflächige
     * Landeskarte** — Relief, Höhenkoten, Ortsnamen. Über das Luftbild gelegt
     * deckte er es vollständig zu (gemessen: 98 % der Bildfläche verändert,
     * Kachelpixel zu 100 % deckend) und verbarg damit alles darunter,
     * namentlich die Wildruhezonen. Die Gefahrenzonen der Armee deckt
     * `ch.vbs.schiessanzeigen` transparent ab.
     *
     * **Prüfkriterium für neue Layer:** eine Kachel ansehen, nicht nur den
     * HTTP-Status. Ein Layer mit „-karte" im Namen ist verdächtig.
     */
    // Linien statt Flächen — bei der flächigen Deckkraft wären sie kaum zu sehen.
    {id: 'seilbahnen', label: 'Seilbahnen', layer: 'ch.swisstopo.swisstlm3d-uebrigerverkehr', service: 'wmts', enabled: true, opacity: 0.9},
    /*
     * Echte Leitungsgeometrie (Leitungen, Unterwerke, Trafostationen) statt der
     * Sachplan-Korridore. Laut Legende haben noch nicht alle Netzbetreiber
     * geliefert — Ergänzung, kein Ersatz für die Sichtprüfung. Unter 36 kV
     * erfasst der Bund gar nichts.
     */
    {id: 'hochspannung', label: 'Hochspannung >36 kV', layer: 'ch.bfe.elektrische-anlagen_ueber_36', service: 'wms', enabled: true, opacity: 0.9},

    /*
     * Ab hier zuschaltbar statt vorgabemässig an. Jedes sichtbare Raster kostet
     * einen eigenen Kachelsatz und eigenes Compositing — bei tiefer Kamera sind
     * das dreistellig viele Kacheln je Layer. Die Voreinstellung trägt deshalb
     * nur, was unmittelbar den Flug betrifft.
     */
    // Hohe Hindernisse mit drehendem Rotor.
    // Einzelne Anlagen, keine Fläche.
    {id: 'windenergie', label: 'Windenergieanlagen', layer: 'ch.bfe.windenergieanlagen', service: 'wms', enabled: false, opacity: 0.9},
    // Flächen um Flugplätze, in denen Höhenbeschränkungen gelten. Grossflächig,
    // deshalb aus: eingeschaltet deckt es halbe Landstriche zu.
    {id: 'hindernisflaechen', label: 'Hindernisbegrenzungsflächen', layer: 'ch.bazl.hindernisbegrenzungsflaechen-kataster', service: 'wms', enabled: false},

    /*
     * Naturschutz-Kontext. Diese vier bedeuten **kein** Drohnenverbot — sie
     * zeigen, wo Störungsverbote und kantonale Regeln greifen können. Deshalb
     * zuschaltbar und nicht vorgabemässig an.
     */
    {id: 'moorlandschaften', label: 'Moorlandschaften', layer: 'ch.bafu.bundesinventare-moorlandschaften', service: 'wmts', enabled: false},
    {id: 'auen', label: 'Auengebiete', layer: 'ch.bafu.bundesinventare-auen', service: 'wmts', enabled: false},
    {id: 'bln', label: 'BLN-Landschaften', layer: 'ch.bafu.bundesinventare-bln', service: 'wmts', enabled: false},
    {id: 'waldreservate', label: 'Waldreservate', layer: 'ch.bafu.waldreservate', service: 'wmts', enabled: false, maxzoom: 17},

    /*
     * Gewässer sind keine Sperrzone — aber mehrere Kantone knüpfen Regeln
     * daran, und die stehen nicht in der BAZL-Karte (dort liegen über dem
     * Vierwaldstättersee nur Luftverkehrszonen). Beispiel Luzern, § 18 der
     * Verordnung über die Schifffahrt (SRL 787, Stand 1.4.2026): für
     * Modellluftfahrzeuge ein Verbot „auf und über einem Gewässer", für
     * Drohnen eine Zurückhaltungspflicht. Der Layer zeigt, *wo* das gilt;
     * *was* gilt, steht im kantonalen Recht.
     */
    {id: 'gewaesser', label: 'Gewässer (kant. Regeln)', layer: 'ch.swisstopo.swisstlm3d-gewaessernetz', service: 'wmts', enabled: false, opacity: 0.7}

    /*
     * ENTFERNT am 5.9.2026, weil die BAZL-Drohnenkarte sie bereits führt —
     * nachgemessen, nicht vermutet. Sie ist selbst eine Sammelkarte mit drei
     * Kategorien (610 Zonen gerastert): NATURE, SENSITIVE, AIR_TRAFFIC.
     *   - Nationalpark          → NATURE      („Schweizerischer Nationalpark")
     *   - Jagdbanngebiete       → NATURE      („Eidg. Jagdbanngebiet Creux-du-Van")
     *   - Naturschutz Pro Natura→ NATURE      (Aletsch → „Eidg. Jagdbanngebiet Aletschwald")
     *   - Kontrollzonen (CTR)   → AIR_TRAFFIC („CTR BERN", „CTR ALPNACH (MIL)")
     *   - Flugplätze/Heliports  → AIR_TRAFFIC
     *   - Spitallandeplätze     → SENSITIVE   („BEWA Inselspital")
     */
];

/**
 * Luftfahrthindernisse — als Vektor, nicht als Raster.
 *
 * Der WMS-Layer stempelt „Last update: …" in jedes ausgelieferte Bild, also in
 * jede Kachel; am Gerät lag die halbe Karte voll roter Schrift. Der Stempel
 * steckt in der Serverdarstellung. Der identify-Dienst liefert dieselben
 * Objekte sauber und dazu `maxheightagl` je Hindernis.
 */
export const OBSTACLES = {
    id: 'hindernisse',
    label: 'Luftfahrthindernisse',
    enabled: true,
    identifyUrl: 'https://api3.geo.admin.ch/rest/services/all/MapServer/identify',
    layer: 'ch.bazl.luftfahrthindernis',
    /** Serverseitige Obergrenze; 5 km Kantenlänge liefern rund 30 Objekte. */
    limit: 200,
    /** Darunter deckt der Ausschnitt zu viel Fläche für eine sinnvolle Abfrage. */
    minZoom: 12,
    /**
     * Nachgeladen wird nach *Strecke*, gemessen am sichtbaren Ausschnitt: hat
     * die Kamera ein Viertel der Bildbreite zurückgelegt, kommen neue Daten.
     *
     * Warum nicht ein fixer Meterwert plus Zeittakt (vorher 400 m / 4 s): der
     * Zeittakt feuerte auch im Stand alle vier Sekunden gegen api3, und die
     * 400 m passten weder zum weiten noch zum nahen Zoom. Bei Referenztempo
     * **120 km/h** (33 m/s) und einem Ausschnitt von rund 500 m im
     * Cockpit-Zoom heisst ein Viertel: alle ~125 m, also alle vier Sekunden —
     * die Hindernisse liegen damit vor einem, bevor man sie erreicht.
     */
    refreshViewportFraction: 0.25,
    /** Grenzen dazu, damit weder Dauerfeuer noch Hängenbleiben entsteht. */
    minRefreshDistanceMeters: 120,
    maxRefreshDistanceMeters: 2000,
    /** Sicherheitsnetz im Stand: einmal pro Minute reicht. */
    idleRefreshMs: 60000
};

/** Gemeinsame WMTS-Parameter. Zeitdimension `current`, verifiziert 3.9.2026. */
export const WMTS = {
    urlTemplate: 'https://wmts.geo.admin.ch/1.0.0/{layer}/default/current/3857/{z}/{x}/{y}.png',
    /**
     * **512, obwohl die Kacheln physisch 256 × 256 sind** (nachgemessen an der
     * ausgelieferten PNG-Datei und in den WMTS-Capabilities bestätigt).
     *
     * Das ist bewusst: `tileSize` sagt MapLibre, über wie viele Bildschirm-
     * pixel eine Kachel gespannt wird. Mit 512 nimmt es für dieselbe Fläche
     * eine Zoomstufe gröber — halb so viele Kacheln in jeder Richtung, also ein
     * Viertel der Anfragen. Bezahlt wird das mit einer Stufe Überzoom, und
     * genau eine Stufe war schon vorher der bewusste Kompromiss (siehe
     * `maxzoom`).
     *
     * Gemessen in der Safari-Engine bei 2560 × 1440 auf Retina, Cockpit-Blick:
     * 917 Kacheln / 3,73 s vorher, 599 Kacheln / 2,68 s nachher. Das Luftbild
     * bleibt dabei unangetastet scharf — nur die Sperrflächen werden gröber
     * geladen, und das sind Flächen, keine Details.
     */
    tileSize: 512,
    /**
     * Bewusst tief: Sperrflächen sind Flächen, keine Details. Über dieser Stufe
     * skaliert MapLibre die vorhandene Kachel hoch, statt neue zu holen.
     *
     * Kontrolliert gemessen bei fixer Kamera (z16.5, Pitch 87°, fünf Overlays):
     * Stufe 18 → 220 Anfragen / 263 KB, Stufe 15 → 140 Anfragen / 250 KB. Also
     * weniger Anfragen bei gleicher Datenmenge — auf Mobilfunk zählt die Zahl
     * der Verbindungen mehr als die Bytes.
     *
     * **17 statt 15**, seit die Kamera nahe steht (Vorgabe z17,5): bei Deckel
     * 15 wären die Flächen zweieinhalb Stufen hochskaliert und verschmieren
     * sichtbar. Eine Stufe Überzoom ist der Kompromiss.
     *
     * Nebeneffekt: fehlt eine Stufe auf dem Server, entstehen keine 404er.
     */
    maxzoom: 17,
    /**
     * Deckkraft **flächiger** Overlays.
     *
     * Von 0,65 auf 0,35 gesenkt (5.9.2026). Grund: steht man mitten in einer
     * grossen Zone — etwa der CTR Emmen —, deckt das Raster den ganzen
     * Bildschirm, und das Luftbild darunter war praktisch weg. Nachgemessen am
     * Detailkontrast des Bildes: bei 0,65 blieben **40 %** der Bilddetails,
     * bei 0,40 schon 53 %, bei 0,30 dann 63 %. 0,35 ist der Kompromiss — die
     * Zone bleibt als Einfärbung klar erkennbar, die Karte darunter lesbar.
     *
     * Layer, die keine Flächen, sondern Linien oder Punkte zeichnen, brauchen
     * mehr Deckkraft, sonst verschwinden sie ganz: die übersteuern den Wert
     * über `opacity` in ihrem Eintrag in OVERLAYS.
     */
    opacity: 0.35
};

/**
 * WMS-Fallback für Layer ohne WMTS-Kachelsatz. MapLibre füllt
 * `{bbox-epsg-3857}` je Kachel selbst; WMS 1.3.0 verlangt bei EPSG:3857 die
 * Achsfolge x,y — also dieselbe Reihenfolge wie im Platzhalter.
 */
export const WMS = {
    urlTemplate: 'https://wms.geo.admin.ch/?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap'
        + '&LAYERS={layer}&STYLES=&CRS=EPSG:3857&BBOX={bbox-epsg-3857}'
        + '&WIDTH=512&HEIGHT=512&FORMAT=image/png&TRANSPARENT=true',
    /**
     * Hier ist 512 **gratis**, anders als bei WMTS: ein WMS rendert die
     * angeforderte Fläche in der gewünschten Pixelgrösse, statt fertige Kacheln
     * auszuliefern. `WIDTH`/`HEIGHT` wandern deshalb mit — dieselbe Auflösung
     * wie zuvor, nur ein Viertel der Anfragen. Die beiden Werte müssen
     * zusammenpassen, sonst kommt ein 256er Bild auf 512 Pixel gestreckt.
     */
    tileSize: 512,
    /** Gleiche Überlegung wie bei WMTS. */
    maxzoom: 17
};

/**
 * Fixer Quellenhinweis (opendata.swiss terms_by — Quellenangabe verpflichtend).
 *
 * Nennt alle Rechteinhaber der eingebundenen Daten, auch die der per
 * Voreinstellung abgeschalteten Layer: der Hinweis steht dauerhaft und folgt
 * nicht dem Layer-Panel. swisstopo (Terrain, Basemap, Seilbahnen, Gewässer),
 * BAZL (Luftfahrthindernisse, Drohnenzonen, UAS-Aktivitätszonen,
 * Hindernisbegrenzungsflächen), BAFU (Wildruhezonen, Moorlandschaften, Auen,
 * BLN, Waldreservate), BFE (elektrische Anlagen, Windenergie), VBS/Armee
 * (Schiessanzeigen, Sperr- und Gefahrenzonen).
 *
 * Pro Natura ist am 5.9.2026 entfallen, weil der Layer entfernt wurde — ein
 * Rechteinhaber ohne Daten gehört nicht in den Hinweis.
 */
export const ATTRIBUTION_TEXT = '© swisstopo / © BAZL / © BAFU / © BFE / © VBS';

/**
 * Rechtlicher Hinweis. `full` steht vor dem Start über dem Startknopf — wer
 * startet, hat ihn gesehen; `short` bleibt während der Fahrt dauerhaft sichtbar.
 * Freigegeben am 3.9.2026.
 */
export const DISCLAIMER = {
    full: 'Dieses Cockpit ist ein informatives Lagebild und keine Flugfreigabe. '
        + 'Zonen, Höhen und Positionen können unvollständig, veraltet oder fehlerhaft sein — '
        + 'unter 36 kV sind Stromleitungen gar nicht erfasst. Massgebend sind allein die '
        + 'amtlichen Angaben von BAZL und Kantonen sowie die geltenden Vorschriften. Die '
        + 'Verantwortung für jeden Flug liegt bei der steuernden Person.',
    short: 'Lagebild, keine Flugfreigabe — Angaben ohne Gewähr.'
};

/**
 * Himmel und Dunst. Ohne `setSky` bleibt oberhalb des Horizonts die
 * Hintergrundfarbe stehen — bei Pitch 75–85° ist das die halbe Fläche, und sie
 * war schwarz. Der Dunst am Horizont ist bewusst schwach: er soll Tiefe geben,
 * nicht die Berge verschlucken, um die es hier geht.
 */
export const SKY = {
    'sky-color': '#4a83c4',
    'horizon-color': '#cddced',
    'fog-color': '#d7e3ee',
    'sky-horizon-blend': 0.6,
    'horizon-fog-blend': 0.35,
    'fog-ground-blend': 0.75,
    'atmosphere-blend': 0.8
};

/** Eigene Position: blauer Punkt mit Richtungspfeil. */
export const ME = {
    color: '#2f7ef7',
    dotRadius: 6,
    /** Kantenlänge des gezeichneten Pfeil-Icons in Pixeln (pixelRatio 2). */
    iconSize: 64,
    /**
     * Grösser als früher (0,55 → 0,8 → 1,15): der Pfeil trägt die
     * Standortmarkierung allein, und seit er aufrecht zum Bildschirm steht
     * (statt flach auf dem Gelände) darf er auch entsprechend Platz einnehmen.
     */
    arrowScale: 1.15
};

/**
 * Wetterradar (Niederschlag).
 *
 * **Warum nicht direkt von MeteoSchweiz.** Die amtlichen Radardaten gibt es als
 * Open Data (`ch.meteoschweiz.ogd-radar-precip`, CC-BY) — aber als 866 HDF5-
 * Dateien je Tag. Das ist ein wissenschaftliches Binärformat, das kein Browser
 * darstellt; es bräuchte einen Server, der daraus Kacheln rechnet, und das
 * widerspricht dem Kernentscheid „statisch, kein Backend". Auch der WMS führt
 * keinen Live-Radar: 2072 Layer durchsucht, kein einziger.
 *
 * **RainViewer liefert sehr wahrscheinlich dieselben Messungen.** Deren
 * Abdeckungsliste nennt „Switzerland (5)", und MeteoSchweiz betreibt genau
 * fünf Radarstandorte (Albis, La Dôle, Monte Lema, Plaine Morte,
 * Weissfluhgipfel). Ein anderes Wetterradarnetz gibt es hier nicht. RainViewer
 * nennt seine Quellen allerdings nicht namentlich — deshalb „sehr
 * wahrscheinlich" und nicht „sicher".
 *
 * **Erste Datenquelle ausserhalb geo.admin.** Die Attribution ist Bedingung der
 * freien Nutzung und hängt deshalb an der Source selbst: MapLibre zeigt sie
 * genau dann, wenn der Layer sichtbar ist.
 */
export const RADAR = {
    id: 'radar',
    label: 'Niederschlagsradar',
    /** Nennt Host und die Pfade der letzten Zeitpunkte. Kein Schlüssel nötig. */
    indexUrl: 'https://api.rainviewer.com/public/weather-maps.json',
    /**
     * `{pfad}` wird aus dem Index eingesetzt. Farbschema 2 (universell),
     * `1_1` = geglättet mit Schneedarstellung.
     */
    tileTemplate: '{host}{pfad}/256/{z}/{x}/{y}/2/1_1.png',
    tileSize: 256,
    /**
     * **Der freie Zugang endet bei z7.** Ab z8 liefert der Dienst kein Radar
     * mehr, sondern eine Platzhalterkachel mit dem Aufdruck „Zoom Level Not
     * Supported" — sichtbar erst im Bild, nicht am HTTP-Status und auch nicht
     * an der Dateigrösse. Nachgewiesen über zwei weit auseinanderliegende Orte:
     * ab z8 kommt für verschiedene Kacheln byte-identisch dasselbe Bild.
     *
     * Mit dem Deckel skaliert MapLibre die z7-Kachel hoch, statt den Aufdruck
     * über die Karte zu legen. Ein Qualitätsverlust ist das kaum: z7 entspricht
     * hier gut einem Kilometer je Bildpunkt, und genau so fein löst ein
     * Wetterradar auf.
     */
    maxzoom: 7,
    /**
     * Kräftiger als die Sperrflächen: die Radarkachel ist nur dort eingefärbt,
     * wo es tatsächlich regnet, und verdeckt das Luftbild deshalb nicht
     * flächig.
     */
    opacity: 0.7,
    /** Der Dienst aktualisiert im Zehnminutentakt; der Pfad wechselt dabei. */
    refreshMs: 10 * 60 * 1000,
    attribution: 'Wetterradar: <a href="https://www.rainviewer.com/" target="_blank" rel="noopener noreferrer">RainViewer</a>',
    /** Vorgabemässig aus: Zusatzinformation, kein Teil des Lagebilds. */
    enabled: false
};

/**
 * Antippen-Abfrage: die Raster-Overlays zeigen Flächen, die Regel steht in den
 * Sachdaten. Derselbe Dienst wie bei den Hindernissen, nur punktweise.
 */
export const INFO = {
    identifyUrl: 'https://api3.geo.admin.ch/rest/services/all/MapServer/identify',
    /**
     * Amtliche Sachdaten-Darstellung je Treffer.
     *
     * `identify` liefert die Werte nur unter technischen Feldnamen
     * (`schutzs_de`, `best_de`, `wrz_name`) und dazu jede Sprache dreifach.
     * Dieser Endpunkt liefert dieselben Daten **mit den amtlichen deutschen
     * Beschriftungen** — „Schutzstatus", „Bestimmungen", „Schutzzeit",
     * „Grundlage" — und zwar für jeden geo.admin-Layer, ohne dass hier je
     * Layer eine Übersetzungstabelle gepflegt werden müsste. Genau das fehlte
     * vorher: eine Wildruhezone zeigte nur ihren Namen, weil die alte
     * Feld-Whitelist ausschliesslich BAZL-Zonen und Hindernisse kannte.
     *
     * Kostet eine Anfrage je Treffer, deshalb erst nach dem Zusammenfassen.
     */
    htmlPopupUrl: 'https://api3.geo.admin.ch/rest/services/all/MapServer/{layer}/{id}/htmlPopup',
    /** Fangradius in Bildschirmpixeln — mit dem Finger trifft man nicht auf den Punkt. */
    tolerancePx: 8,
    limit: 12,
    /**
     * Höchstzahl der Sachdaten-Abfragen je Antippen. Nach dem Zusammenfassen
     * bleiben meist ein bis drei Treffer übrig; der Deckel begrenzt den
     * Ausreisser, bei dem sich viele Zonen überlagern.
     */
    detailLimit: 6
};

/**
 * Kameralage über Sitzungen hinweg merken: der „Vor"-Regler und die Höhe.
 *
 * Beides ist eine persönliche Einstellung, keine Momentaufnahme — wer sie
 * einmal passend gefunden hat, will sie beim nächsten Start wiederfinden und
 * nicht jedes Mal neu schieben.
 */
export const CAMERA_STORE = {
    storageKey: 'cockpit:kameralage'
};

/** Anzeige-Konstanten. */
export const UI = {
    /**
     * Anzeigedauer für Meldungen, die sich von selbst erledigen — ein
     * Kachel-/Netzaussetzer während der Fahrt darf nicht für den Rest der Fahrt
     * über der Karte stehen bleiben. Dauerzustände (Terrain fehlt, Standort
     * verweigert) bleiben stehen, bis sie weggetippt werden.
     */
    transientBannerMs: 6000,
    /**
     * Spätestens so lange wartet das Zuschalten der Sperrflächen auf ein ruhig
     * gewordenes Kartenbild. Sicherheitsnetz: kommt die Karte nie zur Ruhe —
     * bei laufender Kameraführung feuert `idle` womöglich gar nicht —, dürfen
     * die Flächen trotzdem nicht ausbleiben. Lieber etwas Gedränge beim Laden
     * als eine Karte ohne Sperrzonen.
     */
    overlayDelayMaxMs: 4000
};

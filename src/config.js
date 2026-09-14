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

/**
 * Geländeschatten im Manuell-Modus (Sonnenstand-Simulation, 12.9.2026).
 *
 * shademap.app/`mapbox-gl-shadow-simulator` fiel als Vorlage aus: das Paket ist
 * `"license": "UNLICENSED"`, also ohne Nutzungsrecht für ein öffentliches Repo.
 * Stattdessen eigenes Raycasting über dem vorhandenen Quantized-Mesh-Terrain
 * (kein swissALTI3D-Import — DEM reicht, siehe unten), Sonnenstand über
 * `suncalc` (BSD-2-Clause, vendort).
 *
 * **Zielkonflikt Auflösung/Reichweite, drei geprüfte Wege:**
 *  1. Zoom 14 (wie das Live-Terrain): kein Auflösungsgewinn gegenüber der
 *     ohnehin sichtbaren Karte.
 *  2. Zoom 15–16, kleine Kachelzahl: sichtbar schärfere Kanten, Reichweite auf
 *     1–2 km begrenzt. **Gewählt.**
 *  3. Hoher Zoom mit vielen Kacheln für Auflösung *und* Reichweite: eine
 *     einzelne Kachel deckt bei Zoom 18 auf Schweizer Breite nur rund 100 m ab
 *     — für mehrere Kilometer Reichweite bräuchte es hunderte Kacheln je
 *     Neuberechnung, unabsehbare Wartezeit bei jedem Zeit-/Ortswechsel.
 *
 * Eigene, höher gezoomte Ladung des Terrains nötig (nicht einfach das laufende
 * Terrain unverändert weiterverwenden): swisstopo liefert kein `available`
 * -Array, das Plugin synthetisiert die Verfügbarkeit nur bis `maxZoom` — mit
 * `TERRAIN.maxZoom` (14) würde jede Anfrage über Zoom 14 hinaus nur denselben
 * gröberen Kachelsatz feiner resampeln, ohne echte zusätzliche Geländedetails
 * vom Server zu holen. Ein zweiter, separat geladener Datensatz mit `maxZoom:
 * maxGridZoom` holt tatsächlich die feineren Kacheln.
 *
 * **Zoom folgt der Kamera statt fix (13.9.2026).** Der Nutzer wollte den
 * Schatten auch weit herausgezoomt sehen — bei fixem Zoom 15 wären das
 * hunderte Kacheln je Neuberechnung gewesen (siehe Weg 3 oben). Stattdessen
 * folgt `gridZoom` jetzt dem Kamera-Zoom (gerundet, auf `minGridZoom`/
 * `maxGridZoom` geklammert): dieselbe Kachelzahl deckt bei niedrigerem Zoom
 * automatisch mehr Fläche ab, weil die einzelne Kachel dann real breiter ist.
 *
 * **Zwei verworfene Rechenwege, beide 13.9.2026:**
 *  1. Pixel-für-Pixel-Raycasting auf der CPU im Worker — kam am Gerät bei
 *     Kartenbewegung im Manuell-Modus nicht mit dem Kamera-Takt mit.
 *  2. Dieselbe Rechnung als GPU-Fragment-Shader direkt in einer MapLibre-
 *     Custom-Layer (schnell, aber brauchte eine eigene Mercator-Höhen-
 *     Umrechnung für die Position im 3D-Raum) — liess sich über drei
 *     Gerätetests hinweg nie exakt genug kalibrieren (falsche
 *     Bildschirmposition, dann Verschwinden bei bestimmten Zoomstufen, dann
 *     sichtbares Schweben vor Bergkanten trotz Tiefen-Offset).
 *
 * **Jetzt:** dieselbe Verschattungsrechnung (Fragment-Shader, unverändert)
 * läuft in einem eigenen, unsichtbaren WebGL-Kontext ohne jede Kamera-Matrix
 * — nur ein Vollbild-Quad. Das Ergebnis geht als fertiges Bild an eine
 * MapLibre-`image`-Source, die geländetreu drapiert wird — genau wie das
 * Luftbild, nachweislich korrekt (das war schon in der allerersten,
 * CPU-basierten Fassung dieses Features so gelöst, nur zu langsam). Eine
 * Zeitänderung braucht wie eine neue Position eine (debouncte) Neuberechnung
 * — anders als beim Custom-Layer-Versuch keine "kostenlosen" Uniform-Updates
 * mehr, aber die Rechnung selbst bleibt GPU-schnell.
 */
export const SHADOW = {
    /**
     * Grenzen der Rasterstufe der Schatten-Kacheln — unabhängig vom
     * Live-Terrain-Deckel. Die Kachelzahl bleibt über alle Stufen konstant
     * (`gridRadiusTiles`/`outputRadiusTiles`): bei niedrigerer Stufe sind
     * dieselben Kacheln real breiter und decken mehr Fläche ab, ohne mehr
     * Netzlast (13.9.2026, „viel weiter rauszoomen und trotzdem Schatten
     * sehen").
     *
     * **Die Stufe folgte bis zum 14.9.2026 dem gerundeten Kamera-Zoom.** Das
     * war die Ursache eines Gerätebefunds („Schatten springt hin und her, nur
     * durch Zoomänderung"): an jeder Rundungsgrenze kippte die Stufe, und mit
     * ihr halbierte sich das Fenster — bei Stufe 12 ist es 20 km breit, bei 13
     * nur noch 10 km, die Reichweite des Sonnenstrahls entsprechend 6,7 statt
     * 3,3 km. Nachgemessen kippte die verschattete Fläche bei 0,1 Zoomstufen
     * Unterschied zwischen 20,1 % und 24,8 %. Jetzt wählt
     * `shadow.js#chooseGridZoom()` die Stufe aus der tatsächlich sichtbaren
     * Bodenfläche, mit Hysterese (siehe dort sowie `extentSamples`,
     * `maxVisibleMeters`, `gridZoomHysteresis`).
     */
    minGridZoom: 10,
    maxGridZoom: 15,
    /**
     * Abtastpunkte für die sichtbare Bodenfläche, als Anteil von Breite und
     * Höhe des Kartenfensters (0/0 = oben links). Die untere Kante liefert das
     * kameranahe Ende, die oberen Punkte das ferne.
     *
     * **Warum das Fenster wirklich das ganze Bild abdecken muss:** liegt der
     * Fensterrand im Bild, sieht man ihn — dort hört der Schatten schlicht
     * auf. Und weil Fenstermitte und Sichtweite geländebewusst gemessen
     * werden (`unproject()` trifft den echten Boden), wandert der Rand bei
     * flacher Kamera um mehrere hundert Meter, sobald der Messstrahl über
     * einen Grat streicht — im Schwenktest 14.9.2026 gemessen: ±600 bis 800 m
     * bei 150-m-Schritten der Kamera. Deckt das Fenster das ganze Bild ab,
     * liegt dieser Rand ausserhalb und das Wandern bleibt unsichtbar.
     *
     * Nicht bis ganz nach oben (0), weil dort bei flacher Kamera der Himmel
     * beginnt und `unproject()` keinen brauchbaren Bodenpunkt mehr liefert —
     * solche Ausreisser fangen der Endlichkeitstest in `shadow.js` und
     * `maxVisibleMeters` ab.
     */
    extentSamples: [[0, 1], [1, 1], [0, 0.6], [1, 0.6], [0, 0.25], [1, 0.25], [0.5, 0.25]],
    /**
     * Deckel für die gemessene Sichtweite. Fängt Abtastpunkte ab, die knapp
     * über den Horizont zielen und dadurch absurd weit entfernte Bodenpunkte
     * liefern würden — ohne ihn würde ein Streifen Himmel am oberen Bildrand
     * die Stufe auf das gröbste Mass ziehen. 30 km lässt `minGridZoom` (Stufe
     * 10, 80 km Fenster) weiterhin erreichbar, deckelt aber den Unsinn.
     */
    maxVisibleMeters: 30000,
    /**
     * Untergrenze derselben Messung. Fängt den Fall ab, dass alle
     * Abtastpunkte fast auf dem Fensterzentrum landen (sehr steile Kamera,
     * sehr nah am Boden) — ohne sie würde das Fenster beliebig klein und die
     * Kachelstufe ins Maximum laufen.
     */
    minVisibleMeters: 500,
    /**
     * Totband der Stufenwahl, in Zoomstufen. Die Hysterese ist einseitig:
     * deckt die laufende Stufe die sichtbare Fläche nicht mehr ab, wird
     * sofort gewechselt; wäre bloss eine feinere Stufe möglich, erst wenn sie
     * um mehr als eine volle Stufe plus diesen Wert zu grob geworden ist.
     * 0,5 ergibt ein Band von einer halben Zoomstufe — weit genug, dass
     * Zoomen um die Grenze herum nicht mehr flackert.
     */
    gridZoomHysteresis: 0.5,
    /**
     * Reichweite der Verdeckungsprüfung Richtung Sonne, in Metern — zugleich
     * die Breite des unsichtbaren Rands um den angezeigten Ausschnitt.
     *
     * **Seit dem 14.9.2026 ein Meterwert statt einer Kachelzahl.** Vorher war
     * der Rand genau eine Kachel breit, und die Reichweite hing damit an der
     * Kachelstufe: 6,7 km bei Stufe 12, aber nur 0,83 km bei Stufe 15 — ein
     * Faktor 8 über den Zoombereich. Beim Hineinzoomen verlor der Schatten
     * dadurch schlagartig seine entfernten Verursacher. Jetzt bleibt die
     * Reichweite konstant, egal wie fein das Raster ist.
     *
     * 4 km deckt die üblichen Schattenwürfe im Voralpen- und Alpenraum bei
     * tiefstehender Sonne ab. Grössere Werte kosten direkt Auflösung: der Rand
     * zählt in `maxGridPixels` mit, geht also vom sichtbaren Teil ab.
     *
     * **Bekannte Grenze:** ein Gipfel weiter als diese Strecke entfernt wird
     * nicht berücksichtigt, auch wenn er in Wirklichkeit einen Schatten bis
     * hierher würfe.
     */
    rayReachMeters: 4000,
    /**
     * Deckel der Kantenlänge des geladenen Höhenrasters, in Pixeln. Bestimmt
     * indirekt, wie viele Quellkacheln geladen werden: bei 1280 sind es im
     * ungünstigsten Fall (1280/256 + 1)² = 36 Kacheln, typisch 25–30.
     *
     * Das ist die eine Stellschraube des Zielkonflikts: die abgedeckte Fläche
     * ergibt sich aus Sichtweite und `rayReachMeters`, dieser Deckel bestimmt,
     * mit welcher Kachelstufe sie gefüllt wird — je höher, desto feiner das
     * Raster und desto mehr Kacheln.
     */
    maxGridPixels: 1280,
    /**
     * Kantenlänge der Rechen-Canvas, in Pixeln — die Auflösung des erzeugten
     * Schattenbildes. Unabhängig von der Rastergrösse: der Shader bildet seine
     * Ausgabekoordinate ohnehin über `uvScale`/`uvOffset` auf das Raster ab.
     *
     * 1536 entspricht dem, was vorher aus 768 Kachelpixeln mal Faktor 2
     * Supersampling entstand. Höher heisst feinere Schattenkanten (die
     * Verschattungsentscheidung fällt pro Ausgabepixel), ohne dass mehr
     * Geländedaten geladen werden müssten.
     */
    outputPixels: 1536,
    /**
     * Wo auf dem Bildschirm der Punkt liegt, um den das Fenster gebaut wird —
     * 0 die Bildschirmmitte (`map.getCenter()`), 1 der untere Bildrand.
     * 0,75 (14.9.2026, Gerätebefund Glarus): bei starker Kameraneigung liegt
     * die Bildschirmmitte geografisch oft weit vom Gelände am *unteren*
     * Bildrand entfernt, dem in einer flachen FPV-Ansicht nächstgelegenen —
     * eine Kopfdrehung liess diesen Mittelpunkt so weit wandern, dass der
     * nahe Vordergrund aus dem Fenster fiel und bis zur nächsten
     * Neuberechnung unverschattet blieb. Nicht 1,0 (der Bildrand selbst):
     * dort wäre das Fenster so nah an der Kamera zentriert, dass es kaum
     * noch in die Ferne reicht, die im oberen Bildbereich ja auch sichtbar
     * ist. `map.unproject()` ist geländebewusst (berücksichtigt
     * `map.terrain`) und liefert damit den tatsächlichen Bodenpunkt, nicht
     * den Schnittpunkt mit der Ellipsoid-Nullfläche.
     */
    centerScreenFraction: 0.75,
    /**
     * Weichzeichnung des Schattenrands, in Radiant Sonnenhöhe (14.9.2026,
     * gleicher Gerätebefund wie oben). Ohne sie kippt die Verschattung an
     * Gratlinien hart zwischen Ja/Nein — kleinste Höhenschwankungen im Raster
     * lassen benachbarte Ausgabepixel dann unabhängig voneinander kippen
     * (Sägezahnmuster am Rand). Der Wert ist ein Toleranzband um die
     * Sonnenhöhe, in dem die Deckkraft stetig statt sprunghaft ansteigt.
     */
    edgeSoftnessRad: 0.02,
    /**
     * Weichzeichnung des Höhenrasters selbst, bevor der Sonnenstrahl-Test
     * darauf läuft — in Metern, nicht in Texeln (14.9.2026, Gerätebefund:
     * bei z14 zeigte der Schattenrand deutlich gröbere Facetten als bei z12
     * an derselben Stelle).
     *
     * **Achtung, die erste Begründung hier war falsch** und ist nach einer
     * Messung an echten swisstopo-Daten ersetzt: es hiess, swisstopo liefere
     * ab einer gewissen Zoomstufe kein feineres Dreiecksnetz mehr. Das
     * stimmt nicht — die Kantenlänge sinkt durchgehend bis Stufe 17 (am
     * Testpunkt 47.344/8.412: 349 m bei QM12, 226 m bei QM13, 87 m bei QM14,
     * 33 m bei QM15, 7 m bei QM17). Die echte Ursache lag im Terrain-Plugin
     * und ist dort behoben (siehe `MAX_SOURCE_TILES` in
     * `vendor/maplibre-gl-3dtiles-terrain/index.js`): sein Deckel von 6
     * Quellkacheln verwarf bei Mercator z14 die passende Mesh-Stufe, weil
     * die dort neun Kacheln gebraucht hätte.
     *
     * Die Weichzeichnung bleibt als **Kantenglättung**, nicht als Fix für
     * die Facetten: sie rundet die Dreieckskanten im Höhenraster ab, damit
     * einzelne Knicke nicht als gerade Linien im Schattenrand stehen. Ein
     * fester Texel-Radius hätte falsch skaliert (bei hohem Zoom, wo ein
     * Texel wenig Fläche deckt, zu wenig; bei niedrigem Zoom unnötig viel) —
     * ein Meterwert, durch `metersPerPixel` geteilt, ergibt den passenden
     * Texel-Radius je Zoomstufe. Rundet auch echte scharfe Grate leicht ab,
     * ein bewusster kleiner Genauigkeitsverlust zugunsten der Optik.
     */
    heightBlurMeters: 25,
    /**
     * Weichzeichnung des fertigen Schattenbildes, in Pixeln der Ausgabe-
     * Canvas (`outputPixels`) — zusätzlich zur Höhen-Weichzeichnung oben, aber
     * mit anderem Ziel (14.9.2026, Gerätebefund „Schatten willkürlich" auf
     * zerklüftetem Gelände). Am Höhendaten-Ausschnitt und am echten Luftbild
     * bestätigt: die einzelnen Flecken sind reales, sehr feinteiliges Gelände
     * (Schutthang), kein Rechenfehler — für das Cockpit soll es trotzdem
     * ruhiger wirken. Wirkt auf das Ergebnis, nicht auf die Höhendaten, ist
     * also reine Kosmetik und beeinflusst die Schatten-Reichweite nicht.
     * In Ausgabepixeln statt Metern: die Kante soll unabhängig vom Zoom immer
     * gleich weich aussehen, nicht wie `heightBlurMeters` mit der realen
     * Fläche mitskalieren.
     */
    postBlurPixels: 6,
    /**
     * Farbe der Schattenfläche. Reines Schwarz war am Gerät auf Wald-/Felshängen
     * kaum von den echten, zur Aufnahmezeit gehörigen Schatten im Luftbild zu
     * unterscheiden. Ein erster Versuch mit Violett (13.9.2026) verschwamm über
     * den gelb/orangen BAFU-Zonenflächen zu Magenta und lag damit zu nahe an
     * anderen Cockpit-Farben (Wanderweg-Pink, Amber-Route). Jetzt: dunkles,
     * kühles Blaugrau — dunkelt jeden Untergrund ab, ohne eine neue Mischfarbe
     * zu erzeugen.
     */
    color: [12, 20, 40],
    /**
     * Deckkraft der Schattenfläche. 0,6 war am Gerät auf dunklem Fels zu
     * unauffällig (13.9.2026) — auf 0,75 angehoben.
     */
    opacity: 0.75,
    /**
     * Nach einer Kamerabewegung oder einer Zeitänderung wird erst nach dieser
     * Ruhezeit neu gerechnet (Höhendaten laden + Verschattung im eigenen
     * WebGL-Kontext) — beides braucht seit dem Wechsel auf die `image`-Source
     * (13.9.2026) wieder eine echte Neuberechnung statt eines blossen
     * Uniform-Updates, die Rechnung selbst bleibt aber GPU-schnell.
     */
    debounceMs: 400,
    /**
     * Bei einem Fehlschlag (Netz/Worker) so oft automatisch erneut versuchen,
     * mit dieser Pause dazwischen — deckt einen kurzen Netz-Hänger beim
     * Kachel-Nachladen ab, ohne die zuletzt gezeigte Fläche unbegrenzt lange
     * stehen zu lassen (14.9.2026, Gerätebefund: eine fehlgeschlagene
     * Neuberechnung vor Sonnenaufgang blieb unbemerkt stehen und sah nach
     * Sonnenaufgang wie ein Fehler aus, weil sie nie erneuert wurde).
     */
    maxRetries: 3,
    retryDelayMs: 2000
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
    /**
     * Zeitkonstante, mit der die Kamerahöhe nachgeführt wird.
     *
     * **Die Höhe war bis zum 6.9.2026 die einzige Kameragrösse ohne
     * Interpolation.** Neigung und Kurs liefen weich, der Zoom sprang: die
     * Bodenfreiheits-Sicherung rief `applyHeight()` auf, sobald sich der
     * Geländeversatz um mehr als `heightTerrainStepMeters` geändert hatte, und
     * das setzte den Zoom in einem Bild. Beim Drehen wandert der Blickpunkt
     * übers Gelände, also geschah das im Takt der Sicherung.
     *
     * Gemessen bei einer langsamen Drehung von 25 °/s: **14 Zoomsprünge in
     * 8 Sekunden, Abstand im Median 329 ms, grösster Einzelsprung 0,238
     * Zoomstufen** — rund 18 % Massstab in einem Bild, über die ganze Drehung
     * 1,14 Zoomstufen. Das war das nervöse Zucken.
     */
    zoomTauSeconds: 0.5,
    /** Träger als die Blickrichtung: Handzittern soll das Bild nicht kippen. */
    pitchTauSeconds: 0.35,

    /**
     * Bodenfreiheit der Kamera.
     *
     * Bei fast waagrechtem Blick sitzt die Kamera nur knapp über Grund und
     * rutscht in ansteigendem Gelände hinein — man sieht den Berg dann von
     * innen. Reicht die Freiheit nicht, steigt die Kamera, bis sie wieder
     * passt (siehe `hindernisLiftMaxMeters`).
     */
    terrainClearanceMeters: 25,
    /**
     * So weit darf die Kamera steigen, um aus dem Gelände freizukommen.
     *
     * Die Kamera steht bei 80° Neigung rund 3400 m hinter dem Blickpunkt; in
     * einem Tal wie Lauterbrunnen liegt dieser Punkt tief im Fels. Früher wurde
     * dann die **Neigung** zurückgenommen, bis die Kamera freikam — der Blick
     * kippte dabei bis auf `pitchMin` nach unten, statt nach vorn aus dem Tal
     * heraus zu schauen. Stattdessen steigt jetzt die Kamera.
     *
     * Das ist selbstverstärkend: Steigen schiebt die Kamera um `tan(Neigung)`
     * pro Höhenmeter zusätzlich nach hinten, also womöglich noch tiefer in den
     * Hang. Nachgerechnet auf echtem Gelände konvergiert es trotzdem in zwei
     * bis drei Runden — Mittelland und Voralpen brauchen gar keine Anhebung,
     * Lauterbrunnen 870 bis 1220 m. Die Grenze fängt den Rest ab; darüber
     * bleibt die alte Neigungsabsenkung als Rückfall.
     */
    hindernisLiftMaxMeters: 1500,
    /** Prüftakt: die Geländeabfrage muss nicht mit der Bildrate laufen. */
    /**
     * Ab welcher Änderung des Geländeversatzes die Kamerahöhe nachgezogen wird.
     *
     * Wirkt als Totband gegen die **Amplitude**, nicht gegen die Stufigkeit —
     * die Glättung sitzt seit dem 6.9.2026 im Frame-Loop
     * (`zoomTauSeconds`). Ohne dieses Totband folgt die Höhe jeder
     * Geländewelle: nachgemessen wuchs die Zoomspanne während einer Drehung
     * von 1,08 auf 1,88 Stufen, die Ansicht zoomte also sichtbar ein und aus.
     */
    /**
     * Zeitkonstante, mit der die Geländeversätze nachgeführt werden.
     *
     * **Deutlich träger als der Zoom selbst**, und das ist Absicht: der Zoom
     * soll einem geänderten Ziel zügig folgen, das Ziel selbst aber nicht jeder
     * Geländewelle. Bis zum 6.9.2026 leistete das ein EMA im 300-ms-Takt der
     * Sicherung (Alpha 0,15, also rund 2 s Zeitkonstante). Beim Umbau auf
     * Glättung im Bildtakt ging diese Dämpfung zunächst verloren, und die
     * Zoomspanne während einer Drehung wuchs von 1,08 auf 1,88 Stufen.
     */
    gelaendeVersatzTauSeconds: 1.0,
    heightTerrainStepMeters: 15,
    /**
     * Abstand der vier Nachbarpunkte bei der Geländeabtastung, in Metern.
     *
     * Gross genug, um über Rasterpunkte und Kachelgrenzen des Höhenmodells zu
     * mitteln; klein genug, dass echte Geländeformen erhalten bleiben. Bei
     * Terrain-Zoom 14 misst eine Kachel rund 1,2 km, das Raster darin ist
     * deutlich feiner.
     */
    gelaendeAbtastungMeter: 120,
    terrainGuardIntervalMs: 300,

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
     * Wohin `anchor: 1` den eigenen Punkt setzt — als Anteil der Bildhöhe.
     *
     * Nicht 1,0, also nicht der untere Bildrand. Dort ist der Pfeil unsichtbar:
     * der Hinweisbalken beginnt bei 92,2 % der Bildhöhe, die Modusknöpfe bei
     * 87,1 %, und das Symbol ist um seinen Punkt zentriert. Gemessen am
     * 6.9.2026 sass der Marker bei Anker 1 auf 101,2 % — vollständig ausserhalb
     * des Bildes. Genau das war die Meldung „der blaue Pfeil verschwindet
     * teilweise".
     *
     * **0,95 seit dem 7.9.2026**, seit die drei Quellenzeilen oben stehen: der
     * untere Streifen ist frei, und der Auftraggeber verlangt den Pfeil
     * ausdrücklich „vertikal nahe dem unteren Bildschirmrand". Der Rest ist die
     * halbe Symbolhöhe.
     */
    anchorMaxAnteil: 0.95,
    /**
     * Mindestabstand zwischen zwei Durchläufen der Kameraführung, in
     * Millisekunden.
     *
     * **Gleichmässigkeit schlägt Höhe — und das ist am Gerät belegt.**
     * Auf einem 60-Hz-Schirm bedeutet 28 ms exakt jeder zweite Bildtakt, auf
     * einem 120-Hz-Schirm jeder vierte: gleichmässiger Abstand, und dazwischen
     * bleibt dem Gerät Zeit zum Zeichnen.
     *
     * Am 6.9.2026 wurde das versuchsweise auf 0 gesetzt, also jeder Bildtakt.
     * Anlass war die Beobachtung, dass die HUD-Zeile „Takt" am Gerät 57–60
     * gezeichnete Bilder je Sekunde meldete, aber nur 28–30 Kameradurchläufe —
     * daraus schien zu folgen, dass die Bremse Bewegung verschenkt, die das
     * Gerät liefern könnte. **Der Schluss war falsch.** Nach der Umstellung
     * meldete dasselbe Gerät `21/s Bild · 21/s Kamera`: jeder Durchlauf zieht
     * ein volles Neuzeichnen nach sich, und davon schafft es nur gut zwanzig.
     * Die 60 fps kamen nicht *trotz* der Bremse zustande, sondern *wegen* ihr.
     *
     *   mit 28 ms   60/s gezeichnet, 30/s Kamera  → Bild ändert sich 30-mal
     *   mit  0 ms   22/s gezeichnet, 22/s Kamera  → Bild ändert sich 22-mal
     *
     * Jeder Wert zwischen 17 und 33 ergibt auf 60 Hz dasselbe Verhalten; 28
     * liegt bewusst darunter, damit ein Takt, der mit etwas Jitter knapp unter
     * 33 ms ankommt, seine Runde nicht verwirft. Bei 33 schlug genau das als
     * p90 von 49 ms durch.
     *
     * Die Interpolation rechnet weiterhin mit dem *echten* `dt`, die Bewegung
     * läuft also unverändert schnell ab — nur in gröberen, dafür
     * gleichmässigen Schritten.
     */
    frameIntervalMs: 28,
    /**
     * So lange wird die Fahrt zwischen zwei Fixes höchstens weitergerechnet.
     *
     * Das GPS liefert einmal pro Sekunde. Ohne Koppelnavigation läuft die
     * Kamera nach jedem Fix mit `positionTauSeconds` auf den empfangenen Punkt
     * zu, kommt nach rund 0,75 s an und **steht dann**, bis der nächste Fix
     * eintrifft. Am Video vom 6.9.2026 bei 130 km/h nachgemessen: die
     * Bildänderung pro Frame fällt von 3,4 auf 0,12 ab und springt genau eine
     * Sekunde später wieder auf 3,6. Das ist das Rucken — kein Bildratenthema,
     * sondern eine fehlende Vorhersage. Google und Apple rechnen die Fahrt
     * zwischen den Fixes weiter und korrigieren beim nächsten sanft nach.
     *
     * Der Deckel begrenzt den Schaden bei Empfangsausfall: nach zwei Sekunden
     * ohne Fix hört die Karte auf, blind weiterzufahren. Bei 130 km/h sind das
     * 72 m Fehlweg im schlimmsten Fall.
     */
    koppelMaxSeconds: 2,
    /** Zeitkonstante der Frame-Interpolation von Position und Blickrichtung. */
    positionTauSeconds: 0.25,
    headingTauSeconds: 0.2,
    /**
     * Träger direkt über der GPS-Schwelle, bis `headingTauGpsFullSpeedMps`
     * erreicht ist — siehe `gpsHeadingTau()`. Der GPS-Kurs ist nicht bei jedem
     * Tempo „von Natur aus ruhig" (Kommentar bei `headingTauCompassSeconds`):
     * er wird aus aufeinanderfolgenden Positionen berechnet, und bei
     * Schritttempo dominiert dort die Positionsungenauigkeit den winzigen
     * Versatz je Fix. Am Gerät bei 5 km/h gemessen: Kurs wanderte 146° →
     * 144° → 146° → 151° binnen 2 s, bei `τ 0,2` fast unverzögert übernommen
     * und am unteren Bildrand verankert entsprechend verstärkt sichtbar.
     *
     * **Von 0,6 auf 1,0 erhöht (8.9.2026, 2. Rückmeldung — "reagiert noch
     * immer zu zackig").** Mit einer zweiten, ebenfalls real gemessenen
     * Kurs-Folge geprüft (5 km/h, 337-341°): grösster Schritt je Bild 3,62°
     * auf 1,42°. Gegenprobe mit einer echten 90°-Abbiegung im selben Tempo:
     * Einschwingzeit 1,7 s auf 2,6 s, noch vertretbar. 1,5 s brachte keine
     * verlässlich bessere Glättung mehr (die Kurs-Folge selbst schwankt nur
     * so viel), aber schon 3,7 s Einschwingzeit.
     */
    headingTauGpsSlowSeconds: 1.0,
    /** Ab dieser Geschwindigkeit gilt der GPS-Kurs als zuverlässig genug für `headingTauSeconds`. */
    headingTauGpsFullSpeedMps: 2.78,
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
    headingTauCompassSeconds: 0.5,
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
     * Glättung des Rohkurses **während einer Drehung**.
     *
     * `compassEmaAlpha` ist für den Stillstand ausgelegt und dort richtig: es
     * bügelt die groben Magnetometerstufen weg. Beim Drehen ist es der falsche
     * Wert — es erzeugt genau die Trägheit, die am Ende der Drehung als
     * sekundenlanges Nachkriechen sichtbar wird. Google Maps steht nach einer
     * Drehung schlagartig still (gemessen am Mitschnitt vom 6.9.2026: von 4,6
     * auf 0,05 innerhalb eines Bildes), das Cockpit kroch zwei bis drei
     * Sekunden nach.
     *
     * Dasselbe Muster wie bei der Position, wo längst zwischen
     * `positionEmaAlphaStatic` und `positionEmaAlphaMoving` umgeschaltet wird:
     * im Stand träge, in Bewegung zügig. Die Schwelle ist dieselbe Drehrate,
     * ab der auch der Vorhalt greift (`kompassVorhalteTotDegrees`) — es ist
     * derselbe Begriff von „es wird gedreht".
     */
    compassEmaAlphaDrehend: 0.35,
    /**
     * Unterhalb dieser Änderung bleibt die Blickrichtung stehen. Fängt das
     * letzte Zittern ab, ohne eine echte Drehung merklich zu verzögern.
     */
    headingDeadbandDegrees: 3,
    /**
     * Vorhalt gegen den Nachlauf beim Drehen, in Sekunden.
     *
     * Die doppelte Glättung — `compassEmaAlpha` auf dem Rohwert, danach
     * `approachAngle` auf der Kamera — erzeugt einen **festen** Nachlauf: bei
     * 60 °/s gemessene 46°, konstant, nicht schwankend. Beim Anhalten holt die
     * Karte diese 46° nach, und genau das ist das Schleudern am Ende jeder
     * Drehung.
     *
     * Ein fester Nachlauf ist exakt herausrechenbar, wenn man die Drehrate
     * kennt: Zielkurs plus `Drehrate · Vorhalt`. Das ist derselbe Gedanke wie
     * die Koppelnavigation bei der Position (siehe `koppelMaxSeconds`), nur auf
     * den Winkel angewandt — dort wird die Fahrt weitergerechnet, hier die
     * Drehung.
     */
    /**
     * **Auf null seit dem 6.9.2026 (Ratenvorschub).** Der Vorhalt und der
     * Vorschub der Kameraführung rechnen dieselbe Verzögerung heraus; beides
     * zusammen liess die kurze Drehung um 18,7° überschwingen. Der Wert bleibt
     * als Stellschraube stehen, falls der Vorschub je entfällt.
     */
    kompassVorhalteSekunden: 0.00,
    /**
     * Totzone der Drehrate in Grad pro Sekunde.
     *
     * Darunter wirkt kein Vorhalt: im Stand ist die geschätzte Drehrate nichts
     * als Magnetometerrauschen, und ein Vorhalt darauf würde das Bild genau so
     * zappeln lassen, wie die Dämpfung es verhindern soll.
     *
     * **Weich, nicht als Schalter.** Abgezogen statt verglichen — sonst spränge
     * der Zielkurs beim Überschreiten der Schwelle um `Schwelle · Vorhalt`,
     * also mehrere Grad auf einmal. So wächst der Vorhalt stetig aus null
     * heraus.
     */
    kompassVorhalteTotDegrees: 8,
    /**
     * Rauschschwelle der Drehrate **für die Koppelnavigation**, in Grad pro
     * Sekunde — bewusst viel kleiner als `kompassVorhalteTotDegrees`.
     *
     * Bis zum 14.9.2026 nutzte `koppelZiel()` dieselbe 8-°/s-Schwelle wie der
     * Vorhalt. Das war eine stille Fehlübernahme: der Vorhalt rechnet einen
     * Nachlauf der *Kamera* heraus und darf im Stand nicht auf Rauschen
     * reagieren, die Koppelnavigation dagegen beschreibt die *gefahrene
     * Bahn*. Am Gerät gemessen (Kurvenfahrt 14.9.2026): 36° Kursänderung in
     * 10 s sind 3,6 °/s — weit unter 8, die Kreisbahn-Vorhersage war über die
     * ganze Kurve abgeschaltet und der Weg wurde auf der Tangente
     * weitergerechnet. Jeder neue GPS-Fix korrigierte das dann sichtbar, im
     * Sekundentakt.
     *
     * Warum hier eine kleine Schwelle unbedenklich ist: die Koppelnavigation
     * läuft ohnehin erst ab `gpsHeadingMinSpeedMps`, im Stand also gar nicht.
     * Und selbst ±2 °/s Rauschen ergeben bei 50 km/h über eine Sekunde nur
     * rund 0,24 m seitlichen Fehler — unsichtbar gegenüber dem Tangentenschnitt,
     * den die alte Schwelle verursachte.
     */
    koppelDrehrateTotDegrees: 1.5,
    /**
     * Glättung der Drehratenschätzung. Träger als die Rate selbst gemessen
     * wird, weil eine einzelne Magnetometerstufe sonst als Drehung von
     * mehreren hundert Grad pro Sekunde durchschlüge.
     */
    /**
     * Obergrenze der Drehbeschleunigung in Grad je Sekunde im Quadrat.
     *
     * **Sanft losgehen ist kein Mangel, sondern das Gefühl von Ruhe.** Google
     * Maps braucht rund eine Sekunde, bis eine Drehung ihre volle
     * Geschwindigkeit erreicht; das Cockpit brauchte 0,30 s. Der Auftraggeber
     * beschrieb genau das als Ursache: „reagiert viel zu schnell gegenüber
     * Google, das schön sanft losgeht … und das führt auch zum Zucken."
     *
     * Beides hängt zusammen. Eine Kamera, die in 0,3 s auf volle Rate springt,
     * folgt auch jeder einzelnen Magnetometerstufe: die Drehrate schwankte
     * gemessen zwischen 47 und 74 °/s um die wahren 60. Eine Grenze für die
     * *Änderung* der Rate bremst den Anlauf und glättet zugleich die Stufen —
     * es ist derselbe Filter.
     *
     * Gemessen bei abruptem Beginn einer Drehung mit 60 °/s, Kompass in
     * 4°-Stufen, Drehrate der Karte über 250-ms-Fenster:
     *
     *   ohne Grenze   Anlauf 0,25 s   `12 66 61 61 58 54 70 62`
     *   Grenze 15     Anlauf 0,78 s   ` 2 12 53 63 69 64 66 69`
     *
     * **15 und nicht 30 ist eine Geschmacksentscheidung**, getroffen nach der
     * ausdrücklichen Aussage des Auftraggebers, Googles Verzögerung von über
     * einer Sekunde sei das Ziel. Der Preis ist Nachlauf: 14,3° statt 9,6° bei
     * 45 °/s. Wer es direkter will, setzt hier 30.
     */
    drehbeschleunigungMax: 15,
    /**
     * Obergrenze beim **Abbremsen** der Drehung, in Grad je Sekunde im Quadrat.
     *
     * Deutlich höher als `drehbeschleunigungMax`, und das ist der Kern: langsam
     * hoch, zügig runter. Eine symmetrische Grenze klingt beim Loslassen über
     * rund eine Sekunde ab, und in dieser Zeit dreht die Karte weiter — über
     * das Ziel hinaus. Gemessen bei abruptem Stopp einer Drehung mit 60 °/s:
     * **11,5° Überschiessen**. Der Auftraggeber beschrieb es als „mehr dämpfen
     * beim Abfahren, so wird Überschiessen verhindert".
     *
     * Der sanfte Anlauf bleibt davon unberührt — er hängt allein an
     * `drehbeschleunigungMax`.
     */
    drehverzoegerungMax: 150,
    drehrateEmaAlpha: 0.2,

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
    {id: 'drohnen', label: 'Einschränkungen für Drohnen', group: 'Sperrzonen', layer: 'ch.bazl.einschraenkungen-drohnen', service: 'wmts', enabled: true},
    /*
     * Wildruhezonen sind die eine Naturschutzkategorie, die die BAZL-Karte
     * **nicht** führt: sie sind kantonal. Am Trüebsee nachgemessen — der
     * Schutzlayer meldet zwei Zonen, die Drohnenkarte an derselben Stelle
     * keine. Deshalb bleibt er, während Jagdbanngebiete, Nationalpark,
     * Vogelreservate und Pro-Natura-Gebiete entfernt wurden (siehe unten).
     */
    {id: 'wildruhezonen', label: 'Wildruhezonen', group: 'Sperrzonen', layer: 'ch.bafu.wrz-wildruhezonen_portal', service: 'wmts', enabled: true},
    // Wo andere Drohnen unterwegs sind: genehmigte BVLOS-Flüge. Kein Verbot,
    // sondern Verkehr — und damit das, was die Verbotskarte nicht zeigt.
    {id: 'uas-aktivitaet', label: 'UAS-Aktivitätszonen', group: 'Sperrzonen', layer: 'ch.bazl.uas-aktivitaetszonen', service: 'wms', enabled: true},
    // Gefahrenzonen der Armee samt Schiesstagen und -zeiten.
    {id: 'schiessanzeigen', label: 'Schiessanzeigen + Gefahrenzonen', group: 'Sperrzonen', layer: 'ch.vbs.schiessanzeigen', service: 'wmts', enabled: true},
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
    {id: 'seilbahnen', label: 'Seilbahnen', group: 'Infrastruktur', layer: 'ch.swisstopo.swisstlm3d-uebrigerverkehr', service: 'wmts', enabled: true, opacity: 0.9},
    /*
     * Signalisierte Routen (Wanderweg/Bergwanderweg/Alpinwanderweg als
     * Sachdatum `hikingtype`, siehe api3) — wo mit Personen zu rechnen ist.
     * Kachel angesehen: nur Linien auf transparentem Grund, kein „-karte".
     */
    {id: 'wanderwege', label: 'Wander-/Alpinwanderwege', group: 'Wege & Routen', layer: 'ch.swisstopo.swisstlm3d-wanderwege', service: 'wmts', enabled: false, opacity: 0.9},
    /*
     * Alle Strassen und Wege (nicht nur die signalisierten Routen oben) — gegen
     * den echten Katalog geprüft, Kachel angesehen: 88 % transparent, der Rest
     * Linien in Strassenklassen-Farben, kein „-karte"-Vollflächenlayer. Aus,
     * weil es keine Flugrestriktion zeigt und bei dichtem Strassennetz schnell
     * überladen wirkt.
     */
    {id: 'strassen', label: 'Strassen und Wege', group: 'Wege & Routen', layer: 'ch.swisstopo.swisstlm3d-strassen', service: 'wmts', enabled: false, opacity: 0.9},
    /*
     * Echte Leitungsgeometrie (Leitungen, Unterwerke, Trafostationen) statt der
     * Sachplan-Korridore. Laut Legende haben noch nicht alle Netzbetreiber
     * geliefert — Ergänzung, kein Ersatz für die Sichtprüfung. Unter 36 kV
     * erfasst der Bund gar nichts.
     */
    {id: 'hochspannung', label: 'Hochspannung >36 kV', group: 'Infrastruktur', layer: 'ch.bfe.elektrische-anlagen_ueber_36', service: 'wms', enabled: true, opacity: 0.9},

    /*
     * Ab hier zuschaltbar statt vorgabemässig an. Jedes sichtbare Raster kostet
     * einen eigenen Kachelsatz und eigenes Compositing — bei tiefer Kamera sind
     * das dreistellig viele Kacheln je Layer. Die Voreinstellung trägt deshalb
     * nur, was unmittelbar den Flug betrifft.
     */
    // Hohe Hindernisse mit drehendem Rotor.
    // Einzelne Anlagen, keine Fläche.
    {id: 'windenergie', label: 'Windenergieanlagen', group: 'Infrastruktur', layer: 'ch.bfe.windenergieanlagen', service: 'wms', enabled: false, opacity: 0.9},
    // Flächen um Flugplätze, in denen Höhenbeschränkungen gelten. Grossflächig,
    // deshalb aus: eingeschaltet deckt es halbe Landstriche zu.
    {id: 'hindernisflaechen', label: 'Hindernisbegrenzungsflächen', group: 'Infrastruktur', layer: 'ch.bazl.hindernisbegrenzungsflaechen-kataster', service: 'wms', enabled: false},

    /*
     * Weitere Routen abseits der Wanderwege — saisonal/aktivitätsgebunden,
     * deshalb zuschaltbar statt vorgabemässig an. Je Kachel angesehen: reine
     * Linien auf transparentem Grund.
     */
    {id: 'skitouren', label: 'Skitouren', group: 'Wege & Routen', layer: 'ch.swisstopo-karto.skitouren', service: 'wmts', enabled: false, opacity: 0.9},
    {id: 'schneeschuhrouten', label: 'Schneeschuhrouten', group: 'Wege & Routen', layer: 'ch.swisstopo-karto.schneeschuhrouten', service: 'wmts', enabled: false, opacity: 0.9},
    {id: 'winterwanderwege', label: 'Winterwanderwege', group: 'Wege & Routen', layer: 'ch.astra.winterwanderwege', service: 'wmts', enabled: false, opacity: 0.9},
    {id: 'mountainbike', label: 'Mountainbikeland', group: 'Wege & Routen', layer: 'ch.astra.mountainbikeland', service: 'wmts', enabled: false, opacity: 0.9},

    /*
     * Naturschutz-Kontext. Diese vier bedeuten **kein** Drohnenverbot — sie
     * zeigen, wo Störungsverbote und kantonale Regeln greifen können. Deshalb
     * zuschaltbar und nicht vorgabemässig an.
     */
    {id: 'moorlandschaften', label: 'Moorlandschaften', group: 'Naturschutz', layer: 'ch.bafu.bundesinventare-moorlandschaften', service: 'wmts', enabled: false},
    {id: 'auen', label: 'Auengebiete', group: 'Naturschutz', layer: 'ch.bafu.bundesinventare-auen', service: 'wmts', enabled: false},
    {id: 'bln', label: 'BLN-Landschaften', group: 'Naturschutz', layer: 'ch.bafu.bundesinventare-bln', service: 'wmts', enabled: false},
    {id: 'waldreservate', label: 'Waldreservate', group: 'Naturschutz', layer: 'ch.bafu.waldreservate', service: 'wmts', enabled: false, maxzoom: 17},

    /*
     * Gewässer sind keine Sperrzone — aber mehrere Kantone knüpfen Regeln
     * daran, und die stehen nicht in der BAZL-Karte (dort liegen über dem
     * Vierwaldstättersee nur Luftverkehrszonen). Beispiel Luzern, § 18 der
     * Verordnung über die Schifffahrt (SRL 787, Stand 1.4.2026): für
     * Modellluftfahrzeuge ein Verbot „auf und über einem Gewässer", für
     * Drohnen eine Zurückhaltungspflicht. Der Layer zeigt, *wo* das gilt;
     * *was* gilt, steht im kantonalen Recht.
     */
    {id: 'gewaesser', label: 'Gewässer (kant. Regeln)', group: 'Naturschutz', layer: 'ch.swisstopo.swisstlm3d-gewaessernetz', service: 'wmts', enabled: false, opacity: 0.7},

    /*
     * Kartografischer Kontext, keine Restriktion: das Luftbild allein zeigt
     * keine Namen. `queryable: false`, sonst erschiene beim Antippen eines
     * Ortsnamens ein Treffer im Info-Panel statt nur der Sperrzonen-Angaben.
     *
     * Nicht `ch.swisstopo.swissnames3d` (naheliegender Name, aber eine Kachel
     * angesehen zeigt eine vollflächige farbige Landeskarte, keine
     * transparente Beschriftung — deckt das Luftbild zu). Diese Ebene ist
     * wirklich nur Text auf transparentem Grund.
     *
     * `opacity: 1`, weil der Standardwert (`WMTS.opacity`, gedacht für
     * durchscheinende Restriktionsflächen) dünne schwarze Schrift auf dem
     * Luftbild praktisch unsichtbar macht.
     *
     * `minzoom: 11` gegen das Gedränge bei ganz CH: der Layer trägt jeden
     * amtlichen Ortsnamen unabhängig vom Zoom (keine serverseitige
     * Verkleinerung/Rangfolge — geprüfte Kacheln z8–z11 über Zürich zeigen
     * bis z10 nur ein Gewimmel sich überlagernder Symbole, ab z11 lesbar).
     * Eine Vektorfassung mit zoom-/rangabhängiger Grösse gibt es zwar
     * (`ch.swisstopo.base.vt`, Feld `rank`), aber `vectortiles.geo.admin.ch`
     * liefert kein CORS — vom Browser aus nicht nutzbar.
     */
    {id: 'ortsnamen', label: 'Ortsnamen', group: 'Weiteres', layer: 'ch.swisstopo.vec200-names-namedlocation', service: 'wmts', enabled: true, queryable: false, opacity: 1, minzoom: 11}

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
    group: 'Infrastruktur',
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
    group: 'Weiteres',
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
 * Luftlinienmessung: Rechtsklick oder Long-Press öffnet ein Menü zum
 * Punktsetzen (siehe measure.js). Eigene Farbe, damit sich Linie und Punkte
 * vom Standortpfeil (ME) und den Sperrflächen abheben.
 */
export const MEASURE = {
    color: '#f2b705',
    lineWidth: 2,
    dotRadius: 5
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
    overlayDelayMaxMs: 4000,
    /**
     * Nach so viel Ruhe tritt der Knopfstapel (Layer, Modi, Zu-mir, Kompass)
     * zurück — während der Fahrt soll die Karte im Blick bleiben, nicht der
     * Rahmen drumherum. Ungeprüft am Gerät, welcher Wert sich unterwegs
     * richtig anfühlt; 5 s ist ein erster Ansatz.
     */
    controlsIdleMs: 5000
};

/**
 * „Was gilt hier?" — Antippen fragt die eingeschalteten Layer am Klickpunkt ab.
 *
 * Die Raster-Overlays zeigen nur Flächen; die Regel selbst steht in den
 * Sachdaten. Der identify-Dienst liefert sie im Klartext, etwa „Der Betrieb von
 * unbemannten Luftfahrzeugen mit einem Gewicht von mehr als 250 g ist ab einer
 * Höhe von 120 m über Grund verboten" — also genau das, was man vor dem Start
 * wissen will.
 */
import {INFO, OBSTACLES, OVERLAYS} from './config.js';

/** Sachdaten eines Treffers in eine lesbare Zeile bringen. */
function describe(properties) {
    const lower = properties.air_vol_lower_limit;
    const upper = properties.air_vol_upper_limit;
    const parts = [];
    if (properties.zone_restriction_de) parts.push(properties.zone_restriction_de);
    if (lower || upper) {
        const ref = properties.air_vol_lower_vref ?? properties.air_vol_upper_vref ?? '';
        parts.push(`Höhe: ${lower ?? 'Boden'} – ${upper ?? 'offen'} ${ref}`.trim());
    }
    if (properties.zone_message_de) parts.push(properties.zone_message_de);
    // Luftfahrthindernisse tragen andere Felder als die Zonen.
    if (properties.maxheightagl) {
        parts.push(`Hindernis ${properties.obstacletype ?? ''}, ${Math.round(properties.maxheightagl)} m über Grund`.trim());
    }
    const authority = [].concat(properties.auth_name_de ?? []).join(', ');
    if (authority) parts.push(`Zuständig: ${authority}`);
    return parts;
}

function titleOf(properties) {
    return properties.zone_name_de
        ?? properties.label
        ?? properties.registrationnumber
        ?? 'Ohne Bezeichnung';
}

/**
 * Worum es sich handelt — steht im Panel über dem Namen.
 *
 * Der Dienst liefert die Bezeichnung normalerweise selbst mit; fehlt sie,
 * greifen die eigenen Layer-Namen aus der Konfiguration, und erst zuletzt ein
 * neutraler Text. Ein „undefined" über dem Treffer wäre schlimmer als eine
 * unscharfe Bezeichnung.
 */
function layerLabel(hit) {
    if (hit.layerName) return hit.layerName;
    const overlay = OVERLAYS.find((candidate) => candidate.layer === hit.layerBodId);
    if (overlay) return overlay.label;
    if (hit.layerBodId === OBSTACLES.layer) return OBSTACLES.label;
    return 'Treffer';
}

/**
 * Amtliche Sachdaten eines Treffers holen und in Beschriftung/Wert-Paare
 * zerlegen.
 *
 * Der Dienst antwortet mit HTML. Das wird **nicht** in die Seite eingesetzt,
 * sondern mit `DOMParser` in ein eigenes, inertes Dokument geparst — dort läuft
 * kein Skript und wird nichts nachgeladen — und daraus nur Text entnommen.
 * Fremde Daten bleiben so Daten.
 *
 * Vom einzigen Link, den diese Popups kennen („Online-Informationen"), wird das
 * Ziel übernommen, aber nur über HTTPS; alles andere fällt auf reinen Text
 * zurück.
 *
 * @returns {Promise<{header: string|null, rows: Array<{label: string, value: string, href: string|null}>}|null>}
 */
async function fetchDetails(layer, id) {
    const url = INFO.htmlPopupUrl.replace('{layer}', layer).replace('{id}', id)
        + '?lang=de&sr=4326';
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const document_ = new DOMParser().parseFromString(await response.text(), 'text/html');

    const rows = [...document_.querySelectorAll('tr')].map((row) => {
        const cells = row.querySelectorAll('td');
        if (cells.length < 2) return null;
        const label = cells[0].textContent.trim().replace(/\s*:$/, '');
        const value = cells[1].textContent.trim();
        const link = cells[1].querySelector('a[href]');
        const href = link?.getAttribute('href') ?? '';
        // Leere Felder weglassen: das Popup führt sie mit, im Cockpit sind sie
        // nur Zeilen ohne Aussage.
        if (!label || (!value && !href)) return null;
        return {label, value, href: href.startsWith('https://') ? href : null};
    }).filter(Boolean);

    return {header: document_.querySelector('.htmlpopup-header')?.textContent.trim() || null, rows};
}

/**
 * @param {import('maplibre-gl').Map} map
 * @param {{overlays: object, obstacles: object}} layers
 * @param {{panel: HTMLElement, body: HTMLElement, close: HTMLElement}} els
 */
export function createInfo(map, {overlays, obstacles}, els) {
    /**
     * Nur abfragen, was auch zu sehen ist — sonst erklärt das Panel
     * Unsichtbares.
     *
     * `queryable: false` schliesst zusätzlich Layer aus, die zwar Kacheln
     * liefern, aber keine Sachdatentabelle haben. Das ist kein Verzicht auf
     * Bequemlichkeit: der Dienst beantwortet alle Layer in *einer* Anfrage, und
     * ein einziger solcher Layer lässt sie vollständig mit HTTP 400 scheitern —
     * das Antippen fiele dann für jeden Layer aus (siehe `nationalpark` in
     * config.js).
     */
    function visibleLayers() {
        const ids = OVERLAYS
            .filter((o) => o.queryable !== false && overlays.isVisible(o.id))
            .map((o) => o.layer);
        if (obstacles.isVisible()) ids.push(OBSTACLES.layer);
        return ids;
    }

    function render(children) {
        els.body.replaceChildren(...children);
        els.panel.hidden = false;
    }

    function line(text, className) {
        const el = document.createElement(className === 'info-title' ? 'h2' : 'p');
        el.className = className;
        el.textContent = text;
        return el;
    }

    /** Eine Sachdaten-Zeile: Beschriftung links, Wert rechts. */
    function detailRow({label, value, href}) {
        const row = document.createElement('div');
        row.className = 'info-row';
        const name = document.createElement('span');
        name.className = 'info-key';
        name.textContent = label;
        const content = document.createElement('span');
        content.className = 'info-value';
        if (href) {
            const anchor = document.createElement('a');
            anchor.href = href;
            anchor.target = '_blank';
            // Kein Zugriff des Ziels auf diese Seite, kein Referrer.
            anchor.rel = 'noopener noreferrer';
            anchor.textContent = value || 'Link';
            content.append(anchor);
        } else {
            content.textContent = value;
        }
        row.append(name, content);
        return row;
    }

    async function query(lngLat) {
        const layers = visibleLayers();
        if (layers.length === 0) {
            render([line('Keine Layer eingeschaltet.', 'info-empty')]);
            return;
        }
        render([line('Wird geprüft …', 'info-empty')]);

        const b = map.getBounds();
        const extent = `${b.getWest()},${b.getSouth()},${b.getEast()},${b.getNorth()}`;
        const canvas = map.getCanvas();
        const url = `${INFO.identifyUrl}?geometryType=esriGeometryPoint`
            + `&geometry=${lngLat.lng},${lngLat.lat}&mapExtent=${extent}`
            + `&imageDisplay=${canvas.clientWidth},${canvas.clientHeight},96`
            + `&tolerance=${INFO.tolerancePx}&layers=all:${layers.join(',')}`
            + `&sr=4326&geometryFormat=geojson&returnGeometry=false&limit=${INFO.limit}`;

        try {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const results = (await response.json()).results ?? [];
            if (results.length === 0) {
                render([
                    line('An dieser Stelle ist in den eingeschalteten Layern nichts erfasst.', 'info-empty'),
                    // Wichtig: das ist keine Freigabe. Eine Lücke in den Daten
                    // sieht genauso aus wie eine Fläche ohne Einschränkung.
                    line('Das heisst nicht, dass hier geflogen werden darf.', 'info-warn')
                ]);
                return;
            }
            /*
             * Zusammenfassen: der Dienst liefert eine Zone oft in mehreren
             * Teilstücken — dieselbe Regel stand dann fünfmal untereinander.
             * Schlüssel ist der Layer plus der ganze Sachdatensatz: identische
             * Teilstücke fallen zusammen, unterschiedliche Zonen desselben
             * Layers bleiben einzeln stehen.
             */
            const gesehen = new Map();
            for (const hit of results) {
                const schluessel = `${hit.layerBodId}\u0000${JSON.stringify(hit.properties ?? {})}`;
                if (!gesehen.has(schluessel)) gesehen.set(schluessel, hit);
                if (gesehen.size >= INFO.limit) break;
            }
            const treffer = [...gesehen.values()];

            /*
             * Die amtlichen Sachdaten je Treffer nachladen — parallel und
             * gedeckelt. Schlägt einer fehl, fällt genau dieser Treffer auf die
             * eingebaute Kurzfassung zurück; die übrigen bleiben vollständig.
             */
            const details = await Promise.all(treffer.map(async (hit, index) => {
                if (index >= INFO.detailLimit) return null;
                try {
                    return await fetchDetails(hit.layerBodId, hit.id ?? hit.featureId);
                } catch {
                    return null;
                }
            }));

            const children = [];
            treffer.forEach((hit, index) => {
                const properties = hit.properties ?? {};
                const titel = titleOf(properties);
                // Zuoberst, worum es sich überhaupt handelt: „Trüebsee
                // (Nr. 14.3)" allein sagt nicht, dass es eine Wildruhezone ist.
                children.push(line(layerLabel(hit), 'info-layer'));
                children.push(line(titel, 'info-title'));

                const rows = details[index]?.rows ?? [];
                if (rows.length === 0) {
                    // Ohne Sachdaten bleibt die eingebaute Kurzfassung.
                    for (const part of describe(properties)) {
                        children.push(line(part, 'info-detail'));
                    }
                    return;
                }
                // Die Zeile, die bloss den Namen wiederholt, steht schon als
                // Überschrift darüber.
                rows.filter((row) => row.value !== titel)
                    .forEach((row) => children.push(detailRow(row)));
            });
            render(children);
        } catch (error) {
            render([line(`Abfrage fehlgeschlagen: ${error?.message ?? error}`, 'info-warn')]);
        }
    }

    map.on('click', (event) => query(event.lngLat));
    els.close.addEventListener('click', () => {
        els.panel.hidden = true;
    });
}

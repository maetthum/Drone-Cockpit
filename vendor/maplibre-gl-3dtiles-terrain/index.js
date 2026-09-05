// Quantized-mesh (3D Tiles terrain) plugin for MapLibre GL JS.
//
// Serves a Cesium-style quantized-mesh terrain dataset as an ordinary
// `raster-dem` source: each requested Web-Mercator tile is resampled from the
// irregular TIN onto a regular grid and terrarium-packed, so map.setTerrain(),
// queryTerrainElevation(), hillshade and 2D-layer draping work with no core
// changes. See MAPLIBRE-PLUGIN-3DTILES.md for the design.

const DEFAULT_TILE_SIZE = 256;
const DEFAULT_FALLBACK_HEIGHT = 1500;

// The quantized-mesh grid is EPSG:4326 TMS (2 tiles wide at zoom 0,
// y growing northward), not the Web Mercator grid MapLibre requests.
function qmTileBounds(z, x, y) {
    const lonWidth = 360 / (2 * (2 ** z));
    const latHeight = 180 / (2 ** z);
    const west = -180 + x * lonWidth;
    const south = -90 + y * latHeight;
    return {west, south, east: west + lonWidth, north: south + latHeight};
}

function mercatorTileBounds(z, x, y) {
    const n = 2 ** z;
    const lat = (yTile) => (180 / Math.PI) * Math.atan(Math.sinh(Math.PI * (1 - 2 * yTile / n)));
    return {west: x / n * 360 - 180, east: (x + 1) / n * 360 - 180, north: lat(y), south: lat(y + 1)};
}

function boundsOverlap(a, b) {
    return a.west < b.east && a.east > b.west && a.south < b.north && a.north > b.south;
}

// Barycentric interpolation over the decoded TIN, with a coarse bucket
// index so each query only tests a handful of triangles. The decoder
// returns planar vertex data: u values, then v, then height.
function buildTriangleIndex(decoded, bucketsPerAxis = 16) {
    const {vertexData, triangleIndices} = decoded;
    const vertexCount = vertexData.length / 3;
    const buckets = new Map();
    const cellSize = 32768 / bucketsPerAxis;
    const clampBucket = (b) => Math.max(0, Math.min(bucketsPerAxis - 1, b));
    for (let t = 0; t < triangleIndices.length / 3; t++) {
        const i0 = triangleIndices[t * 3], i1 = triangleIndices[t * 3 + 1], i2 = triangleIndices[t * 3 + 2];
        const bxMin = clampBucket(Math.floor(Math.min(vertexData[i0], vertexData[i1], vertexData[i2]) / cellSize));
        const bxMax = clampBucket(Math.floor(Math.max(vertexData[i0], vertexData[i1], vertexData[i2]) / cellSize));
        const byMin = clampBucket(Math.floor(Math.min(vertexData[i0 + vertexCount], vertexData[i1 + vertexCount], vertexData[i2 + vertexCount]) / cellSize));
        const byMax = clampBucket(Math.floor(Math.max(vertexData[i0 + vertexCount], vertexData[i1 + vertexCount], vertexData[i2 + vertexCount]) / cellSize));
        for (let bx = bxMin; bx <= bxMax; bx++) {
            for (let by = byMin; by <= byMax; by++) {
                const key = by * bucketsPerAxis + bx;
                if (!buckets.has(key)) buckets.set(key, []);
                buckets.get(key).push(t);
            }
        }
    }
    return {buckets, bucketsPerAxis, cellSize, vertexCount};
}

function barycentricHeight(decoded, index, queryU, queryV) {
    const {vertexData, triangleIndices} = decoded;
    const {buckets, bucketsPerAxis, cellSize, vertexCount} = index;
    const bx = Math.max(0, Math.min(bucketsPerAxis - 1, Math.floor(queryU / cellSize)));
    const by = Math.max(0, Math.min(bucketsPerAxis - 1, Math.floor(queryV / cellSize)));
    for (const t of buckets.get(by * bucketsPerAxis + bx) || []) {
        const i0 = triangleIndices[t * 3], i1 = triangleIndices[t * 3 + 1], i2 = triangleIndices[t * 3 + 2];
        const x0 = vertexData[i0], y0 = vertexData[i0 + vertexCount];
        const x1 = vertexData[i1], y1 = vertexData[i1 + vertexCount];
        const x2 = vertexData[i2], y2 = vertexData[i2 + vertexCount];
        const denom = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2);
        if (denom === 0) continue;
        const w0 = ((y1 - y2) * (queryU - x2) + (x2 - x1) * (queryV - y2)) / denom;
        const w1 = ((y2 - y0) * (queryU - x2) + (x0 - x2) * (queryV - y2)) / denom;
        const w2 = 1 - w0 - w1;
        if (w0 >= -1e-6 && w1 >= -1e-6 && w2 >= -1e-6) {
            return w0 * vertexData[i0 + vertexCount * 2] + w1 * vertexData[i1 + vertexCount * 2] + w2 * vertexData[i2 + vertexCount * 2];
        }
    }
    return null;
}

// Tries covering meshes in order (deepest zoom first), so each point
// gets the highest-resolution data available there.
function multiMeshElevationAt(coveringMeshes, lng, lat) {
    for (const {decoded, bounds, index} of coveringMeshes) {
        if (lng < bounds.west || lng > bounds.east || lat < bounds.south || lat > bounds.north) continue;
        const qu = Math.max(0, Math.min(32767, ((lng - bounds.west) / (bounds.east - bounds.west)) * 32767));
        const qv = Math.max(0, Math.min(32767, ((lat - bounds.south) / (bounds.north - bounds.south)) * 32767));
        const quantHeight = barycentricHeight(decoded, index, qu, qv);
        if (quantHeight === null) continue;
        const range = decoded.header.maxHeight - decoded.header.minHeight || 1;
        return decoded.header.minHeight + (quantHeight / 32767) * range;
    }
    return null;
}

// Terrarium encoding: height = R*256 + G + B/256 - 32768.
function packTerrarium(height) {
    const value = Math.round((height + 32768) * 256);
    return [Math.floor(value / 65536) % 256, Math.floor(value / 256) % 256, value % 256];
}

// Fades points outside the dataset's coverage toward one fixed height.
// A pure function of (lng, lat) and world constants, so adjacent
// Mercator tiles compute identical heights at shared points (no seams).
// The boundary height is averaged over a window that widens with
// distance, so single edge ridges do not smear into long stripes.
function geographicFallbackHeight(lng, lat, coveringMeshes, bounds, fadeDistanceDeg, fallbackHeight) {
    const clampLng = (v) => Math.max(bounds.west, Math.min(bounds.east, v));
    const clampLat = (v) => Math.max(bounds.south, Math.min(bounds.north, v));
    const dLng = lng - clampLng(lng);
    const dLat = lat - clampLat(lat);
    const dist = Math.sqrt(dLng * dLng + dLat * dLat);
    const t = Math.min(1, dist / fadeDistanceDeg);
    if (t >= 1) return fallbackHeight;
    const weight = t * t * (3 - 2 * t);
    let sum = 0;
    let count = 0;
    for (let ring = 0; ring <= 4; ring++) {
        const radius = 5 * dist * ring / 4;
        const steps = ring === 0 ? 1 : 8 * ring;
        for (let s = 0; s < steps; s++) {
            const angle = 2 * Math.PI * s / steps;
            const h = multiMeshElevationAt(coveringMeshes, clampLng(lng + radius * Math.cos(angle)), clampLat(lat + radius * Math.sin(angle)));
            if (h !== null) {
                sum += h;
                count++;
            }
        }
    }
    return count === 0 ? fallbackHeight : (sum / count) * (1 - weight) + fallbackHeight * weight;
}

// Available tiles intersecting the requested bounds, deepest zoom first,
// from layer.json's per-zoom `available` rectangles. Gaps at one zoom
// stack over lower-zoom parents. Zooms needing more than 6 source tiles
// for one output tile are skipped: the output cannot express their
// resolution, and a full pyramid would fan out into hundreds of fetches.
function qmTileRange(z, bounds) {
    const tilesX = 2 * (2 ** z);
    const tilesY = 2 ** z;
    return {
        xMin: Math.max(0, Math.floor((bounds.west + 180) / 360 * tilesX)),
        xMax: Math.min(tilesX - 1, Math.floor((bounds.east + 180) / 360 * tilesX)),
        yMin: Math.max(0, Math.floor((bounds.south + 90) / 180 * tilesY)),
        yMax: Math.min(tilesY - 1, Math.floor((bounds.north + 90) / 180 * tilesY))
    };
}

function collectAvailableTiles(rectangles, qz, range, mercatorBounds, covering) {
    let fullyCovered = true;
    for (let x = range.xMin; x <= range.xMax; x++) {
        for (let y = range.yMin; y <= range.yMax; y++) {
            const bounds = qmTileBounds(qz, x, y);
            if (!boundsOverlap(bounds, mercatorBounds)) continue;
            if (rectangles.some((r) => x >= r.startX && x <= r.endX && y >= r.startY && y <= r.endY)) {
                covering.push({z: qz, x, y, bounds});
            } else {
                fullyCovered = false;
            }
        }
    }
    return fullyCovered;
}

function findCoveringQMTiles(available, mercatorBounds) {
    const covering = [];
    let coarsestWithData = -1;
    for (let qz = available.length - 1; qz >= 0; qz--) {
        const rectangles = available[qz] || [];
        if (rectangles.length === 0) continue;
        coarsestWithData = qz;
        const range = qmTileRange(qz, mercatorBounds);
        if ((range.xMax - range.xMin + 1) * (range.yMax - range.yMin + 1) > 6) continue;
        if (collectAvailableTiles(rectangles, qz, range, mercatorBounds, covering) && covering.length > 0) {
            return covering;
        }
    }
    // Every zoom with data was finer than the guard allows (a small
    // dataset seen from far away): take the coarsest zoom with data.
    if (covering.length === 0 && coarsestWithData >= 0) {
        const range = qmTileRange(coarsestWithData, mercatorBounds);
        collectAvailableTiles(available[coarsestWithData], coarsestWithData, range, mercatorBounds, covering);
    }
    return covering;
}

// Resamples covering meshes onto a terrain-RGB tile. lng/lat come from
// global (z, x, y, pixel) coordinates so adjacent tiles' shared-edge
// pixels evaluate identically (no floating-point seams).
function mercatorPixelToLngLat(z, x, y, px, py, size) {
    const n = 2 ** z;
    const lng = (x + px / (size - 1)) / n * 360 - 180;
    const lat = (180 / Math.PI) * Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + py / (size - 1)) / n)));
    return {lng, lat};
}

function buildTerrainRgbImageData(coveringMeshes, dataset, tileZ, tileX, tileY, size, fallbackHeight, signal) {
    const heights = new Float64Array(size * size);
    for (let row = 0; row < size; row++) {
        if (signal?.aborted) throw new DOMException('Tile request aborted', 'AbortError');
        for (let col = 0; col < size; col++) {
            const {lng, lat} = mercatorPixelToLngLat(tileZ, tileX, tileY, col, row, size);
            const inBounds = lng >= dataset.bounds.west && lng <= dataset.bounds.east &&
                lat >= dataset.bounds.south && lat <= dataset.bounds.north;
            const h = inBounds ? multiMeshElevationAt(coveringMeshes, lng, lat) : null;
            heights[row * size + col] = h !== null
                ? h
                : geographicFallbackHeight(lng, lat, coveringMeshes, dataset.bounds, dataset.fadeDistanceDeg, fallbackHeight);
        }
    }
    const rgba = new Uint8ClampedArray(size * size * 4);
    for (let i = 0; i < size * size; i++) {
        const [r, g, b] = packTerrarium(heights[i]);
        rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b; rgba[i * 4 + 3] = 255;
    }
    return new ImageData(rgba, size, size);
}

/**
 * Loads a quantized-mesh dataset's `layer.json` and returns a descriptor:
 * `{available, bounds, minZoom, maxZoom, fadeDistanceDeg, attribution, tileUrl(z,x,y)}`.
 *
 * @param {string} layerJsonUrl - URL of the dataset's layer.json.
 * @param {object} [options]
 * @param {{west,south,east,north}} [options.boundsOverride] - synthesize
 *   availability over these bounds for endpoints that omit `available`
 *   (e.g. swisstopo).
 * @param {number} [options.maxZoom] - cap synthesized availability.
 * @param {string} [options.attribution] - fallback if layer.json omits it.
 */
export async function loadQuantizedMeshDataset(layerJsonUrl, options = {}) {
    const res = await fetch(layerJsonUrl);
    if (!res.ok) throw new Error(`layer.json request failed: HTTP ${res.status}`);
    const layer = await res.json();
    if (layer.format !== 'quantized-mesh-1.0') throw new Error(`unsupported terrain format: ${layer.format}`);
    const available = layer.available || [];
    if (available.length === 0 && options.boundsOverride) {
        for (let z = layer.minzoom || 0; z <= Math.min(layer.maxzoom, options.maxZoom); z++) {
            const range = qmTileRange(z, options.boundsOverride);
            available[z] = [{startX: range.xMin, startY: range.yMin, endX: range.xMax, endY: range.yMax}];
        }
    }
    const zoomsWithTiles = available.map((rectangles, z) => (rectangles || []).length > 0 ? z : -1).filter((z) => z >= 0);
    if (zoomsWithTiles.length === 0) throw new Error('layer.json declares no available tiles');
    const bounds = options.boundsOverride ||
        {west: layer.bounds[0], south: layer.bounds[1], east: layer.bounds[2], north: layer.bounds[3]};
    const template = layerJsonUrl.replace(/[^/]*$/, '') + layer.tiles[0];
    return {
        available,
        bounds,
        minZoom: Math.min(...zoomsWithTiles),
        maxZoom: Math.max(...zoomsWithTiles),
        fadeDistanceDeg: Math.max(bounds.east - bounds.west, bounds.north - bounds.south) / 4,
        attribution: layer.attribution || options.attribution,
        tileUrl: (z, x, y) => template
            .replace('{z}', z).replace('{x}', x).replace('{y}', y)
            .replace('{version}', layer.version || '1.0.0')
    };
}

/**
 * Registers a MapLibre protocol that serves terrarium `raster-dem` tiles
 * resampled from a quantized-mesh dataset, and returns a ready-made source spec.
 *
 * @param {object} maplibregl - the maplibre-gl module (for `addProtocol`).
 * @param {object} options
 * @param {object} options.dataset - result of {@link loadQuantizedMeshDataset}.
 * @param {(buffer: ArrayBuffer) => object} options.decode - quantized-mesh
 *   decoder returning `{header:{minHeight,maxHeight}, vertexData, triangleIndices}`
 *   (e.g. `@here/quantized-mesh-decoder`).
 * @param {string} [options.protocol='quantized-mesh'] - protocol scheme.
 * @param {number} [options.tileSize=256] - output raster-dem tile size.
 * @param {number} [options.fallbackHeight=1500] - apron height outside coverage.
 * @returns {{protocol: string, sourceSpec: object, unregister: () => void}}
 */
export function registerQuantizedMeshTerrain(maplibregl, options) {
    const {
        dataset, decode,
        protocol = 'quantized-mesh',
        tileSize = DEFAULT_TILE_SIZE,
        fallbackHeight = DEFAULT_FALLBACK_HEIGHT
    } = options;
    if (!dataset) throw new Error('registerQuantizedMeshTerrain requires a dataset');
    if (typeof decode !== 'function') throw new Error('registerQuantizedMeshTerrain requires a decode function');

    const meshCache = new Map();
    function getMesh(url, signal) {
        if (!meshCache.has(url)) {
            const promise = fetch(url, {signal}).then(async (res) => {
                // Tiles the availability ranges promise but the server lacks:
                // treat as no coverage (404 is usual; swisstopo answers 403).
                if (res.status === 404 || res.status === 403) return null;
                if (!res.ok) throw new Error(`terrain tile request failed: HTTP ${res.status}`);
                const decoded = decode(await res.arrayBuffer());
                return {decoded, index: buildTriangleIndex(decoded)};
            });
            promise.catch(() => meshCache.delete(url));
            meshCache.set(url, promise);
        }
        return meshCache.get(url);
    }

    maplibregl.addProtocol(protocol, async ({url}, abortController) => {
        const signal = abortController?.signal;
        const [, z, x, y] = url.match(new RegExp(`^${protocol}://(\\d+)/(\\d+)/(\\d+)$`)).map(Number);
        const covering = findCoveringQMTiles(dataset.available, mercatorTileBounds(z, x, y));
        const meshes = (await Promise.all(covering.map(async (tile) => {
            const entry = await getMesh(dataset.tileUrl(tile.z, tile.x, tile.y), signal);
            return entry && {decoded: entry.decoded, index: entry.index, bounds: tile.bounds};
        }))).filter(Boolean);
        const imageData = buildTerrainRgbImageData(meshes, dataset, z, x, y, tileSize, fallbackHeight, signal);
        return {data: await createImageBitmap(imageData)};
    });

    return {
        protocol,
        unregister: () => maplibregl.removeProtocol(protocol),
        sourceSpec: {
            type: 'raster-dem',
            encoding: 'terrarium',
            tiles: [`${protocol}://{z}/{x}/{y}`],
            tileSize,
            attribution: dataset.attribution,
            // minzoom pins the TileManager low-zoom safety-net tile to a zoom
            // the dataset covers; maxzoom lets MapLibre overscale deeper zooms;
            // bounds makes the built-in raster-dem hasTile() skip requests
            // outside coverage.
            minzoom: dataset.minZoom,
            maxzoom: dataset.maxZoom,
            bounds: [dataset.bounds.west, dataset.bounds.south, dataset.bounds.east, dataset.bounds.north]
        }
    };
}

/**
 * Core GIS algorithms for watershed delineation.
 *
 * All functions operate on flat typed arrays (Float32Array, Uint8Array,
 * Int32Array) representing 2-D grids stored in row-major order:
 *   index = row * width + col
 *
 * They are deliberately free of DOM/GeoLibre imports so they can run inside a
 * Web Worker (see delineation.worker.ts) without any issues.
 */

import { MinHeap } from './heap';

// ---------------------------------------------------------------------------
// Neighbour direction tables (shared by every algorithm below)
// ---------------------------------------------------------------------------

/** Row offsets for the 8 neighbours, in the same order as D8_CODES. */
const D_ROW = [-1, -1, -1, 0, 0, 1, 1, 1];

/** Column offsets for the 8 neighbours, in the same order as D8_CODES. */
const D_COL = [-1, 0, 1, -1, 1, -1, 0, 1];

/**
 * D8 flow-direction codes for each of the 8 neighbour directions, matching
 * the standard Arc/INFO D8 convention:
 *
 *   32  64  128
 *   16   •    1
 *    8   4    2
 *
 * The index in this array corresponds to the same index in D_ROW / D_COL.
 */
const D8_CODES = [32, 64, 128, 16, 1, 8, 4, 2];

/**
 * Euclidean distance to each neighbour.
 * Orthogonal = 1.0, diagonal = √2.
 */
const DISTANCES = [
  Math.SQRT2, 1.0, Math.SQRT2,
  1.0,              1.0,
  Math.SQRT2, 1.0, Math.SQRT2,
];

// ---------------------------------------------------------------------------
// Internal helper: resolve a D8 code to a flat-array neighbour index
// ---------------------------------------------------------------------------
function d8Neighbor(u: number, code: number, width: number, height: number): number {
  const r = Math.floor(u / width);
  const c = u % width;
  let nr = r;
  let nc = c;
  if (code === 32 || code === 64 || code === 128) nr--;
  if (code === 8  || code === 4  || code === 2)   nr++;
  if (code === 32 || code === 16 || code === 8)   nc--;
  if (code === 128 || code === 1 || code === 2)   nc++;
  if (nr >= 0 && nr < height && nc >= 0 && nc < width) {
    return nr * width + nc;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Step 2: Sink-fill — Wang & Liu (2006) priority-queue approach
// ---------------------------------------------------------------------------

/**
 * Fill depressions (sinks) in a DEM using a priority-queue flood algorithm.
 *
 * @param width        Grid width in pixels.
 * @param height       Grid height in pixels.
 * @param elevation    Input Float32Array of elevation values (row-major).
 * @param noDataValue  Value indicating no-data cells (they are never filled).
 * @param zLimit       Maximum fill depth allowed. Cells that would be raised
 *                     more than `zLimit` above their original elevation are
 *                     left at their original value (i.e. the sink is not
 *                     filled). Pass `Infinity` (default) to fill all sinks.
 * @returns A new Float32Array with depressions filled.
 */
export function sinkFill(
  width: number,
  height: number,
  elevation: Float32Array,
  noDataValue: number,
  zLimit: number = Infinity,
): Float32Array {
  const size = width * height;
  const filled = new Float32Array(size);
  filled.fill(Infinity);

  const heap = new MinHeap<{ idx: number; val: number }>(
    (a, b) => a.val - b.val,
  );
  const visited = new Uint8Array(size);

  // ----- Initialise boundary cells ----------------------------------------
  for (let i = 0; i < size; i++) {
    const r = Math.floor(i / width);
    const c = i % width;
    const isBoundary = r === 0 || r === height - 1 || c === 0 || c === width - 1;
    const isNoData = elevation[i] === noDataValue;

    if (isNoData || isBoundary) {
      filled[i] = elevation[i];
      visited[i] = 1;
      if (!isNoData) {
        heap.push({ idx: i, val: elevation[i] });
      }
    }
  }

  // ----- Priority-queue propagation ----------------------------------------
  while (heap.length > 0) {
    const curr = heap.pop()!;
    const u = curr.idx;
    const r = Math.floor(u / width);
    const c = u % width;

    for (let d = 0; d < 8; d++) {
      const nr = r + D_ROW[d];
      const nc = c + D_COL[d];
      if (nr < 0 || nr >= height || nc < 0 || nc >= width) continue;

      const v = nr * width + nc;
      if (visited[v] !== 0) continue;

      visited[v] = 1;
      const origVal = elevation[v];

      if (origVal === noDataValue) {
        filled[v] = noDataValue;
        // Do not push no-data cells into the heap
        continue;
      }

      const fillVal = Math.max(origVal, filled[u]);
      // If depth would exceed the z-limit keep the original elevation
      filled[v] = fillVal - origVal <= zLimit ? fillVal : origVal;
      heap.push({ idx: v, val: filled[v] });
    }
  }

  return filled;
}

// ---------------------------------------------------------------------------
// Step 3: D8 flow direction + flow accumulation
// ---------------------------------------------------------------------------

/**
 * Compute D8 flow direction and upstream cell-count (flow accumulation).
 *
 * Flow is directed to the steepest downslope neighbour.
 * Accumulation is computed in O(N) time via a topological sort that starts
 * from ridge cells (in-degree = 0) and propagates downslope.
 *
 * @param width       Grid width.
 * @param height      Grid height.
 * @param filledDEM   Sink-filled elevation array.
 * @param noDataValue No-data sentinel value.
 * @returns `flowDirection` (Uint8Array, D8 codes) and
 *          `flowAccumulation` (Float32Array, number of upstream cells including self).
 */
export function computeD8AndAccumulation(
  width: number,
  height: number,
  filledDEM: Float32Array,
  noDataValue: number,
): { flowDirection: Uint8Array; flowAccumulation: Float32Array } {
  const size = width * height;
  const flowDirection = new Uint8Array(size);
  const flowAccumulation = new Float32Array(size);
  flowAccumulation.fill(1.0); // every cell drains itself

  const inDegree = new Int32Array(size);

  // ----- Pass 1: determine steepest downslope direction for each cell -------
  for (let u = 0; u < size; u++) {
    if (filledDEM[u] === noDataValue) continue;

    const r = Math.floor(u / width);
    const c = u % width;
    let maxSlope = 0;
    let bestCode = 0;
    let targetIdx = -1;

    for (let d = 0; d < 8; d++) {
      const nr = r + D_ROW[d];
      const nc = c + D_COL[d];
      if (nr < 0 || nr >= height || nc < 0 || nc >= width) continue;

      const v = nr * width + nc;
      if (filledDEM[v] === noDataValue) continue;

      const slope = (filledDEM[u] - filledDEM[v]) / DISTANCES[d];
      if (slope > maxSlope) {
        maxSlope = slope;
        bestCode = D8_CODES[d];
        targetIdx = v;
      }
    }

    flowDirection[u] = bestCode;
    if (targetIdx !== -1) {
      inDegree[targetIdx]++;
    }
  }

  // ----- Pass 2: accumulate in topological (ridge-to-outlet) order ----------
  const queue: number[] = [];
  for (let i = 0; i < size; i++) {
    if (filledDEM[i] !== noDataValue && inDegree[i] === 0) {
      queue.push(i);
    }
  }

  let head = 0;
  while (head < queue.length) {
    const u = queue[head++];
    const code = flowDirection[u];
    if (code === 0) continue;

    const v = d8Neighbor(u, code, width, height);
    if (v !== -1 && filledDEM[v] !== noDataValue) {
      flowAccumulation[v] += flowAccumulation[u];
      inDegree[v]--;
      if (inDegree[v] === 0) {
        queue.push(v);
      }
    }
  }

  return { flowDirection, flowAccumulation };
}

// ---------------------------------------------------------------------------
// Step 4: Channel network and junction extraction
// ---------------------------------------------------------------------------

/** GeoJSON Feature-compatible lightweight shape (avoids importing geojson types in worker). */
interface GeoFeature {
  type: 'Feature';
  properties: Record<string, unknown>;
  geometry: {
    type: string;
    coordinates: unknown;
  };
}

interface GeoFeatureCollection {
  type: 'FeatureCollection';
  features: GeoFeature[];
}

/**
 * Extract the stream-channel network from the flow accumulation grid.
 *
 * Cells are considered channels when their accumulation value meets or exceeds
 * the `threshold`.  Adjacent channel cells are connected via their D8
 * downstream links and traced into GeoJSON LineStrings.  Cells where two or
 * more channels converge are identified as junction points, which become the
 * outlet pour-points for basin delineation in Step 5.
 *
 * @param width             Grid width.
 * @param height            Grid height.
 * @param flowDirection     Uint8Array of D8 codes (from Step 3).
 * @param flowAccumulation  Float32Array of upstream cell counts (from Step 3).
 * @param threshold         Minimum accumulation to start/maintain a stream.
 * @param geotransform      Six-element affine transform [originX, scaleX, 0,
 *                          originY, 0, scaleY].  scaleY is typically negative.
 * @returns `channelNetwork` (GeoJSON FeatureCollection of LineStrings) and
 *          `junctionPoints` (GeoJSON FeatureCollection of Points).
 */
export function extractChannels(
  width: number,
  height: number,
  flowDirection: Uint8Array,
  flowAccumulation: Float32Array,
  threshold: number,
  geotransform: number[],
): { channelNetwork: GeoFeatureCollection; junctionPoints: GeoFeatureCollection } {
  const size = width * height;
  const isChannel = new Uint8Array(size);
  const chanInDegree = new Uint8Array(size);
  const nextCell = new Int32Array(size);
  nextCell.fill(-1);

  /** Convert flat pixel index to [longitude, latitude] (or projected coordinates). */
  const pixelToCoords = (idx: number): [number, number] => {
    const r = Math.floor(idx / width);
    const c = idx % width;
    const x = geotransform[0] + c * geotransform[1] + r * geotransform[2];
    const y = geotransform[3] + c * geotransform[4] + r * geotransform[5];
    return [x, y];
  };

  // ----- Identify channel cells and their downstream neighbour -------------
  for (let u = 0; u < size; u++) {
    if (flowAccumulation[u] < threshold) continue;
    isChannel[u] = 1;
    const code = flowDirection[u];
    if (code === 0) continue;
    const v = d8Neighbor(u, code, width, height);
    if (v !== -1 && flowAccumulation[v] >= threshold) {
      nextCell[u] = v;
    }
  }

  // ----- Count in-degrees to find sources (0) and junctions (≥2) ----------
  for (let u = 0; u < size; u++) {
    if (isChannel[u] && nextCell[u] !== -1) {
      chanInDegree[nextCell[u]]++;
    }
  }

  const junctions: GeoFeature[] = [];
  for (let i = 0; i < size; i++) {
    if (isChannel[i] && chanInDegree[i] >= 2) {
      junctions.push({
        type: 'Feature',
        properties: { cellIndex: i, inDegree: chanInDegree[i] },
        geometry: { type: 'Point', coordinates: pixelToCoords(i) },
      });
    }
  }

  // ----- Trace channel segments starting from sources or junctions ----------
  const lines: GeoFeature[] = [];
  const visited = new Uint8Array(size);

  for (let u = 0; u < size; u++) {
    if (!isChannel[u] || visited[u]) continue;
    // Only start traces from channel heads (inDegree===0) or junctions
    if (chanInDegree[u] !== 0 && chanInDegree[u] < 2) continue;

    let curr = u;
    const coords: [number, number][] = [pixelToCoords(curr)];
    visited[curr] = 1;

    while (nextCell[curr] !== -1) {
      const next = nextCell[curr];
      coords.push(pixelToCoords(next));

      // Stop at the next junction or at an already-visited cell
      if (chanInDegree[next] >= 2 || visited[next]) break;

      visited[next] = 1;
      curr = next;
    }

    if (coords.length > 1) {
      lines.push({
        type: 'Feature',
        properties: { sourceIndex: u, segmentLength: coords.length },
        geometry: { type: 'LineString', coordinates: coords },
      });
    }
  }

  return {
    channelNetwork: { type: 'FeatureCollection', features: lines },
    junctionPoints: { type: 'FeatureCollection', features: junctions },
  };
}

// ---------------------------------------------------------------------------
// Step 5: Basin delineation
// ---------------------------------------------------------------------------

/**
 * Delineate subbasins by tracing upstream from each junction point.
 *
 * Uses iterative BFS (breadth-first search) to avoid call-stack overflows on
 * large grids — never use recursion here.
 *
 * @param width          Grid width.
 * @param height         Grid height.
 * @param flowDirection  Uint8Array of D8 codes (from Step 3).
 * @param junctions      Array of GeoJSON point features produced by
 *                       `extractChannels`, each carrying `cellIndex` in its
 *                       `properties` object.
 * @returns `basinIdArray` — Int32Array the same size as the DEM.  Each cell
 *          contains the 1-based ID of the subbasin it belongs to, or 0 for
 *          cells not assigned to any basin.
 */
export function delineateBasins(
  width: number,
  height: number,
  flowDirection: Uint8Array,
  junctions: GeoFeature[],
): Int32Array {
  const size = width * height;
  const basinIdArray = new Int32Array(size); // 0 = unassigned

  /**
   * Return true when `neighborIdx` has a D8 code that points *into* `centerIdx`.
   * We need to map the displacement vector (neighborRow - centerRow,
   * neighborCol - centerCol) to the D8 code that the neighbour would have if
   * it flowed toward the center.
   *
   * Displacement table (neighbour relative to center → required D8 code):
   *   (-1,-1)→SE(2)   (-1,0)→S(4)   (-1,+1)→SW(8)
   *   ( 0,-1)→E(1)                  ( 0,+1)→W(16)
   *   (+1,-1)→NE(128) (+1,0)→N(64)  (+1,+1)→NW(32)
   */
  const requiredCodeForInflowTo = (neighborIdx: number, centerIdx: number): number => {
    const nr = Math.floor(neighborIdx / width);
    const nc = neighborIdx % width;
    const cr = Math.floor(centerIdx / width);
    const cc = centerIdx % width;
    const dr = nr - cr;
    const dc = nc - cc;
    if (dr === -1 && dc === -1) return 2;   // SE
    if (dr === -1 && dc ===  0) return 4;   // S
    if (dr === -1 && dc ===  1) return 8;   // SW
    if (dr ===  0 && dc === -1) return 1;   // E
    if (dr ===  0 && dc ===  1) return 16;  // W
    if (dr ===  1 && dc === -1) return 128; // NE
    if (dr ===  1 && dc ===  0) return 64;  // N
    if (dr ===  1 && dc ===  1) return 32;  // NW
    return 0;
  };

  junctions.forEach((juncFeature, i) => {
    const startIdx = juncFeature.properties.cellIndex as number;
    const basinId = i + 1; // IDs start at 1

    basinIdArray[startIdx] = basinId;
    const queue: number[] = [startIdx];
    let head = 0;

    while (head < queue.length) {
      const u = queue[head++];
      const r = Math.floor(u / width);
      const c = u % width;

      for (let d = 0; d < 8; d++) {
        const nr = r + D_ROW[d];
        const nc = c + D_COL[d];
        if (nr < 0 || nr >= height || nc < 0 || nc >= width) continue;

        const v = nr * width + nc;
        if (basinIdArray[v] !== 0) continue; // already claimed

        const requiredCode = requiredCodeForInflowTo(v, u);
        if (flowDirection[v] === requiredCode) {
          basinIdArray[v] = basinId;
          queue.push(v);
        }
      }
    }
  });

  return basinIdArray;
}

// ---------------------------------------------------------------------------
// Step 6: Vectorise basins (edge-tracing → GeoJSON polygons)
// ---------------------------------------------------------------------------

/**
 * Convert the categorical `basinIdArray` raster into GeoJSON polygons.
 *
 * Algorithm:
 *  1. For every pair of adjacent pixels that belong to different basins
 *     (or where one pixel is outside the basin), emit a directed edge along
 *     the shared cell boundary so that the basin interior is always to the
 *     *left* of the directed edge (counterclockwise exterior ring convention).
 *  2. Build an adjacency map from node-label → next-node-label.
 *  3. Walk the adjacency map to assemble closed rings.
 *  4. Convert corner coordinates from pixel-corner space to map coordinates
 *     using the geotransform.
 *
 * @param width        Grid width.
 * @param height       Grid height.
 * @param basinIdArray Int32Array of basin IDs (from Step 5).
 * @param geotransform Six-element affine transform.
 * @returns GeoJSON FeatureCollection of Polygon features.
 */
export function vectorizeBasins(
  width: number,
  height: number,
  basinIdArray: Int32Array,
  geotransform: number[],
): GeoFeatureCollection {
  /** Convert pixel *corner* (col, row) to geographic coordinates. */
  const cornerToCoords = (col: number, row: number): [number, number] => {
    const x = geotransform[0] + col * geotransform[1] + row * geotransform[2];
    const y = geotransform[3] + col * geotransform[4] + row * geotransform[5];
    return [x, y];
  };

  // Collect unique basin IDs (excluding 0 = unassigned)
  const uniqueIds = new Set<number>();
  for (let i = 0; i < basinIdArray.length; i++) {
    if (basinIdArray[i] > 0) uniqueIds.add(basinIdArray[i]);
  }

  const features: GeoFeature[] = [];

  for (const basinId of uniqueIds) {
    // --- Build directed boundary edges for this basin ---
    // Each edge is stored as a string key "fromNode->toNode" where a node is
    // "col,row" in pixel-corner coordinates.
    //
    // Convention (interior to the left):
    //   Top boundary (above pixel r,c where above is different):
    //     interior below → edge goes LEFT: from corner (c+1,r) to (c,r)
    //   Bottom boundary:
    //     interior above → edge goes RIGHT: from corner (c,r+1) to (c+1,r+1)
    //   Left boundary:
    //     interior to right → edge goes DOWN: from corner (c,r) to (c,r+1)
    //   Right boundary:
    //     interior to left → edge goes UP: from corner (c+1,r+1) to (c+1,r)

    const adj = new Map<string, string>();

    const addEdge = (fc: number, fr: number, tc: number, tr: number) => {
      adj.set(`${fc},${fr}`, `${tc},${tr}`);
    };

    for (let r = 0; r < height; r++) {
      for (let c = 0; c < width; c++) {
        const inBasin = basinIdArray[r * width + c] === basinId;
        if (!inBasin) continue;

        // Top edge: above pixel
        const aboveBasin = r > 0 && basinIdArray[(r - 1) * width + c] === basinId;
        if (!aboveBasin) addEdge(c + 1, r, c, r);

        // Bottom edge: below pixel
        const belowBasin = r < height - 1 && basinIdArray[(r + 1) * width + c] === basinId;
        if (!belowBasin) addEdge(c, r + 1, c + 1, r + 1);

        // Left edge: left of pixel
        const leftBasin = c > 0 && basinIdArray[r * width + c - 1] === basinId;
        if (!leftBasin) addEdge(c, r, c, r + 1);

        // Right edge: right of pixel
        const rightBasin = c < width - 1 && basinIdArray[r * width + c + 1] === basinId;
        if (!rightBasin) addEdge(c + 1, r + 1, c + 1, r);
      }
    }

    // --- Walk edges to form closed rings ---
    const rings: [number, number][][] = [];

    while (adj.size > 0) {
      const startNode = adj.keys().next().value as string;
      let curr = startNode;
      const ring: [number, number][] = [];

      while (adj.has(curr)) {
        const [col, row] = curr.split(',').map(Number);
        ring.push(cornerToCoords(col, row));
        const next = adj.get(curr)!;
        adj.delete(curr);
        curr = next;
        if (curr === startNode) {
          // Close the ring
          const [sc, sr] = startNode.split(',').map(Number);
          ring.push(cornerToCoords(sc, sr));
          break;
        }
      }

      if (ring.length > 3) {
        rings.push(ring);
      }
    }

    if (rings.length > 0) {
      features.push({
        type: 'Feature',
        properties: { basinId },
        geometry: { type: 'Polygon', coordinates: rings },
      });
    }
  }

  return { type: 'FeatureCollection', features };
}

// ---------------------------------------------------------------------------
// Steps 7 & 8: Clip DEM and compute elevation statistics
// ---------------------------------------------------------------------------

export interface ElevationStatistics {
  min: number;
  max: number;
  mean: number;
  stdDev: number;
  count: number;
}

/**
 * Clip the filled DEM to a single subbasin and compute basic elevation metrics.
 *
 * @param width            Grid width.
 * @param height           Grid height.
 * @param filledElevation  The sink-filled elevation array (from Step 2).
 * @param basinIdArray     Int32Array of basin IDs (from Step 5).
 * @param selectedBasinId  Target basin ID to clip to.
 * @param noDataValue      Sentinel value used for out-of-basin cells.
 * @returns `clippedElevation` (Float32Array masked to the selected basin) and
 *          `statistics` (min, max, mean, stdDev, count).
 */
export function clipAndComputeStats(
  width: number,
  height: number,
  filledElevation: Float32Array,
  basinIdArray: Int32Array,
  selectedBasinId: number,
  noDataValue: number,
): { clippedElevation: Float32Array; statistics: ElevationStatistics } {
  const clippedElevation = new Float32Array(width * height);
  clippedElevation.fill(noDataValue);

  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let count = 0;

  for (let i = 0; i < width * height; i++) {
    if (basinIdArray[i] !== selectedBasinId) continue;

    const val = filledElevation[i];
    if (val === noDataValue || isNaN(val)) continue;

    clippedElevation[i] = val;
    if (val < min) min = val;
    if (val > max) max = val;
    sum += val;
    count++;
  }

  const mean = count > 0 ? sum / count : 0;

  let sumSqDiff = 0;
  for (let i = 0; i < width * height; i++) {
    if (basinIdArray[i] !== selectedBasinId) continue;
    const val = filledElevation[i];
    if (val === noDataValue || isNaN(val)) continue;
    sumSqDiff += (val - mean) ** 2;
  }

  const stdDev = count > 0 ? Math.sqrt(sumSqDiff / count) : 0;

  return {
    clippedElevation,
    statistics: {
      min: min === Infinity ? noDataValue : min,
      max: max === -Infinity ? noDataValue : max,
      mean,
      stdDev,
      count,
    },
  };
}

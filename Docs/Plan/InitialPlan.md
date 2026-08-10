# Implementation Plan: Watershed Delineation Plugin

This document provides a step-by-step implementation guide for building the **GeoLibre Watershed Delineation Plugin** based on [/Docs/Analysis/Specifications.md](file:///c:/Users/erwin/OneDrive/Documents/Learning/Plugin%20Spatio/WatershedDelineation/Docs/Analysis/Specifications.md). It is structured specifically for a junior developer or a cheaper AI agent to execute sequentially with minimal ambiguity.

---

## 1. Architectural Strategy & Performance Guideline

To handle grids up to **2048 x 2048 (4.19 million pixels)** without freezing the browser UI, all spatial computations must run in a **Web Worker**. The main UI thread will handle file loading, user controls, rendering layers on the map via the GeoLibre host API, and managing file downloads.

### Core File Structure to Implement
```text
src/
├── lib/
│   ├── delineation/
│   │   ├── delineation.worker.ts  # Web Worker executing steps 2-8
│   │   ├── algorithms.ts          # Core GIS mathematical algorithms (sink-fill, D8, etc.)
│   │   ├── heap.ts                # Min-Heap/PriorityQueue helper
│   │   └── index.ts               # Worker wrapper and main thread coordinator
│   ├── utils/
│   │   └── geotiff-writer.ts      # Pure JS/TS Float32 GeoTIFF Encoder
│   └── geolibre/
│       └── right-panel.ts         # User interface controls, progress, and downloads
```

---

## 2. Step-by-Step Task Breakdown

### Task 1: Create the Float32 GeoTIFF Writer
Since `geotiff.js` has limited native writing support for `Float32` files, we will use a custom, lightweight TIFF encoder to pack the processed arrays back into valid GeoTIFF blobs for MapLibre/GeoLibre rendering and file downloads.

#### Action:
Create [geotiff-writer.ts](file:///c:/Users/erwin/OneDrive/Documents/Learning/Plugin%20Spatio/WatershedDelineation/src/lib/utils/geotiff-writer.ts) and add the following complete encoder:

```typescript
/**
 * Encodes a Float32Array into a standard uncompressed Float32 GeoTIFF.
 * Compatible with geotiff.js parsing and GIS software (GDAL/QGIS).
 */
export function writeFloat32GeoTIFF(
  width: number,
  height: number,
  data: Float32Array,
  geotransform: [number, number, number, number, number, number],
  crsCode: number = 3857
): ArrayBuffer {
  const isGeographic = crsCode === 4326;
  const crsKey = isGeographic ? 2048 : 3072; // GeographicTypeGeoKey vs ProjectedCSTypeGeoKey

  const headerSize = 8;
  const ifdEntriesCount = 12;
  const ifdSize = 2 + ifdEntriesCount * 12 + 4; // 150 bytes
  
  // Align offsets to 8-byte boundaries
  const pixelScaleOffset = 160; 
  const tiepointOffset = pixelScaleOffset + 3 * 8; // 184
  const geokeysCount = 16; // 4 header + 3 keys * 4 = 16 shorts (32 bytes)
  const geokeysOffset = tiepointOffset + 6 * 8; // 232
  const pixelDataOffset = geokeysOffset + geokeysCount * 2; // 264 (already 8-byte aligned)

  const totalSize = pixelDataOffset + width * height * 4;
  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);
  
  // 1. Header (Little-endian 'II*')
  view.setUint8(0, 0x49); // 'I'
  view.setUint8(1, 0x49); // 'I'
  view.setUint16(2, 42, true);
  view.setUint32(4, 8, true); // IFD starts at offset 8

  // 2. Write IFD
  let offset = 8;
  view.setUint16(offset, ifdEntriesCount, true);
  offset += 2;

  const writeTag = (tag: number, type: number, count: number, valOrOffset: number) => {
    view.setUint16(offset, tag, true);
    view.setUint16(offset + 2, type, true);
    view.setUint32(offset + 4, count, true);
    view.setUint32(offset + 8, valOrOffset, true);
    offset += 12;
  };

  const scaleX = geotransform[1];
  const scaleY = geotransform[5];
  const originX = geotransform[0];
  const originY = geotransform[3];

  writeTag(256, 4, 1, width); // ImageWidth
  writeTag(257, 4, 1, height); // ImageLength
  writeTag(258, 3, 1, 32); // BitsPerSample = 32
  writeTag(259, 3, 1, 1); // Compression = None
  writeTag(262, 3, 1, 1); // PhotometricInterpretation = BlackIsZero
  writeTag(273, 4, 1, pixelDataOffset); // StripOffsets
  writeTag(278, 4, 1, height); // RowsPerStrip
  writeTag(279, 4, 1, width * height * 4); // StripByteCounts
  writeTag(339, 3, 1, 3); // SampleFormat = 3 (Floating Point)
  writeTag(33550, 12, 3, pixelScaleOffset); // ModelPixelScaleTag
  writeTag(33922, 12, 6, tiepointOffset); // ModelTiepointTag
  writeTag(34735, 3, geokeysCount, geokeysOffset); // GeoKeyDirectoryTag

  view.setUint32(offset, 0, true); // No next IFD
  
  // 3. Write ModelPixelScale (3 doubles)
  view.setFloat64(pixelScaleOffset, scaleX, true);
  view.setFloat64(pixelScaleOffset + 8, Math.abs(scaleY), true);
  view.setFloat64(pixelScaleOffset + 16, 0.0, true);

  // 4. Write ModelTiepoint (6 doubles)
  view.setFloat64(tiepointOffset, 0.0, true);
  view.setFloat64(tiepointOffset + 8, 0.0, true);
  view.setFloat64(tiepointOffset + 16, 0.0, true);
  view.setFloat64(tiepointOffset + 24, originX, true);
  view.setFloat64(tiepointOffset + 32, originY, true);
  view.setFloat64(tiepointOffset + 40, 0.0, true);

  // 5. Write GeoKeyDirectory (16 shorts)
  let kOffset = geokeysOffset;
  view.setUint16(kOffset, 1, true); // DirectoryVersion
  view.setUint16(kOffset + 2, 1, true); // Revision
  view.setUint16(kOffset + 4, 0, true); // MinorRevision
  view.setUint16(kOffset + 6, 3, true); // NumberOfKeys
  kOffset += 8;

  // Key 1: GTModelTypeGeoKey
  view.setUint16(kOffset, 1024, true);
  view.setUint16(kOffset + 2, 0, true);
  view.setUint16(kOffset + 4, 1, true);
  view.setUint16(kOffset + 6, isGeographic ? 2 : 1, true); 
  kOffset += 8;

  // Key 2: GTRasterTypeGeoKey
  view.setUint16(kOffset, 1025, true);
  view.setUint16(kOffset + 2, 0, true);
  view.setUint16(kOffset + 4, 1, true);
  view.setUint16(kOffset + 6, 1, true); // RasterPixelIsArea
  kOffset += 8;

  // Key 3: CRS Code Key
  view.setUint16(kOffset, crsKey, true);
  view.setUint16(kOffset + 2, 0, true);
  view.setUint16(kOffset + 4, 1, true);
  view.setUint16(kOffset + 6, crsCode, true);

  // 6. Write Pixel Data
  const pixelFloatView = new Float32Array(buffer, pixelDataOffset, width * height);
  pixelFloatView.set(data);

  return buffer;
}
```

---

### Task 2: Create the Priority Queue (Min-Heap)
A performant sink-filling algorithm depends on a priority queue. Since JavaScript lacks a native heap structure, you must implement one.

#### Action:
Create [heap.ts](file:///c:/Users/erwin/OneDrive/Documents/Learning/Plugin%20Spatio/WatershedDelineation/src/lib/delineation/heap.ts):

```typescript
export class MinHeap<T> {
  private heap: T[] = [];
  constructor(private compare: (a: T, b: T) => number) {}

  push(val: T) {
    this.heap.push(val);
    this.up(this.heap.length - 1);
  }

  pop(): T | undefined {
    if (this.heap.length === 0) return undefined;
    const top = this.heap[0];
    const bottom = this.heap.pop();
    if (this.heap.length > 0 && bottom !== undefined) {
      this.heap[0] = bottom;
      this.down(0);
    }
    return top;
  }

  get length(): number {
    return this.heap.length;
  }

  private up(i: number) {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.compare(this.heap[i], this.heap[p]) >= 0) break;
      this.swap(i, p);
      i = p;
    }
  }

  private down(i: number) {
    const len = this.heap.length;
    while ((i << 1) + 1 < len) {
      let child = (i << 1) + 1;
      if (child + 1 < len && this.compare(this.heap[child + 1], this.heap[child]) < 0) {
        child++;
      }
      if (this.compare(this.heap[i], this.heap[child]) <= 0) break;
      this.swap(i, child);
      i = child;
    }
  }

  private swap(i: number, j: number) {
    const temp = this.heap[i];
    this.heap[i] = this.heap[j];
    this.heap[j] = temp;
  }
}
```

---

### Task 3: Implement Core Delineation Algorithms
Create [algorithms.ts](file:///c:/Users/erwin/OneDrive/Documents/Learning/Plugin%20Spatio/WatershedDelineation/src/lib/delineation/algorithms.ts) containing the step-by-step algorithms.

#### Action:

#### 1. Sink-filling (Wang & Liu 2006 / Priority Queue)
Implement the sink-filling algorithm to resolve depressions:
- **Concept:** Initialize the boundaries with their original heights, set inner cells to `Infinity`. Push boundary cells into the heap. Step-by-step, pop the lowest cell and update its unvisited neighbors to `Math.max(neighborElevation, currentPoppedElevation)`.

```typescript
import { MinHeap } from "./heap";

export function sinkFill(
  width: number,
  height: number,
  elevation: Float32Array,
  noDataValue: number,
  zLimit: number = Infinity
): Float32Array {
  const size = width * height;
  const filled = new Float32Array(size);
  filled.fill(Infinity);

  const heap = new MinHeap<{ idx: number; val: number }>((a, b) => a.val - b.val);
  const visited = new Uint8Array(size);

  // Helper to check if a cell is on the boundary
  const isBoundary = (idx: number) => {
    const r = Math.floor(idx / width);
    const c = idx % width;
    return r === 0 || r === height - 1 || c === 0 || c === width - 1;
  };

  // 1. Initialize boundary and NoData cells
  for (let i = 0; i < size; i++) {
    if (elevation[i] === noDataValue || isBoundary(i)) {
      filled[i] = elevation[i];
      visited[i] = 1;
      if (elevation[i] !== noDataValue) {
        heap.push({ idx: i, val: elevation[i] });
      }
    }
  }

  // 2. Priority queue propagation
  const dRow = [-1, -1, -1, 0, 0, 1, 1, 1];
  const dCol = [-1, 0, 1, -1, 1, -1, 0, 1];

  while (heap.length > 0) {
    const curr = heap.pop()!;
    const u = curr.idx;
    const r = Math.floor(u / width);
    const c = u % width;

    for (let i = 0; i < 8; i++) {
      const nr = r + dRow[i];
      const nc = c + dCol[i];
      if (nr >= 0 && nr < height && nc >= 0 && nc < width) {
        const v = nr * width + nc;
        if (visited[v] === 0) {
          visited[v] = 1;
          const origVal = elevation[v];
          if (origVal === noDataValue) {
            filled[v] = noDataValue;
            continue;
          }

          // Apply Z-limit constraints if depth is bounded
          const fillVal = Math.max(origVal, filled[u]);
          if (fillVal - origVal <= zLimit) {
            filled[v] = fillVal;
          } else {
            filled[v] = origVal; // Keep original if it exceeds limit
          }

          heap.push({ idx: v, val: filled[v] });
        }
      }
    }
  }

  return filled;
}
```

#### 2. D8 Flow Direction and Accumulation
Implement flow direction using the steepest descent slope and flow accumulation via an in-degree topological sort.
- **Steepest Slope formula:** `Slope = (elevation[u] - elevation[v]) / distance`. Distances: Orthogonal = `1.0`, Diagonal = `Math.SQRT2`.
- **Topological propagation:** Compute `inDegree` for all cells. Start a queue with cells having `inDegree = 0` (ridges) and propagate downslope, accumulating catchment counts.

```typescript
export function computeD8AndAccumulation(
  width: number,
  height: number,
  filledDEM: Float32Array,
  noDataValue: number
): { flowDirection: Uint8Array; flowAccumulation: Float32Array } {
  const size = width * height;
  const flowDirection = new Uint8Array(size);
  const flowAccumulation = new Float32Array(size);
  flowAccumulation.fill(1.0); // Every cell drains itself initially

  const dRow = [-1, -1, -1, 0, 0, 1, 1, 1];
  const dCol = [-1, 0, 1, -1, 1, -1, 0, 1];
  
  // D8 codes: East (1), Southeast (2), South (4), Southwest (8),
  // West (16), Northwest (32), North (64), Northeast (128)
  const d8Codes = [32, 64, 128, 16, 1, 8, 4, 2];
  const distances = [Math.SQRT2, 1.0, Math.SQRT2, 1.0, 1.0, Math.SQRT2, 1.0, Math.SQRT2];

  const inDegree = new Int32Array(size);

  // 1. Calculate D8 Flow Direction
  for (let u = 0; u < size; u++) {
    if (filledDEM[u] === noDataValue) {
      flowDirection[u] = 0;
      continue;
    }
    const r = Math.floor(u / width);
    const c = u % width;

    let maxSlope = 0;
    let bestDir = 0;
    let targetIdx = -1;

    for (let i = 0; i < 8; i++) {
      const nr = r + dRow[i];
      const nc = c + dCol[i];
      if (nr >= 0 && nr < height && nc >= 0 && nc < width) {
        const v = nr * width + nc;
        if (filledDEM[v] === noDataValue) continue;

        const slope = (filledDEM[u] - filledDEM[v]) / distances[i];
        if (slope > maxSlope) {
          maxSlope = slope;
          bestDir = d8Codes[i];
          targetIdx = v;
        }
      }
    }

    flowDirection[u] = bestDir;
    if (targetIdx !== -1) {
      inDegree[targetIdx]++;
    }
  }

  // 2. Compute Flow Accumulation via topological sorting (O(N) linear complexity)
  const queue: number[] = [];
  for (let i = 0; i < size; i++) {
    if (filledDEM[i] !== noDataValue && inDegree[i] === 0) {
      queue.push(i);
    }
  }

  // Map D8 code to flat neighbor index offset
  const getD8NeighborOffset = (u: number, code: number) => {
    const r = Math.floor(u / width);
    const c = u % width;
    let nr = r;
    let nc = c;
    if (code === 32 || code === 64 || code === 128) nr--;
    if (code === 8 || code === 4 || code === 2) nr++;
    if (code === 32 || code === 16 || code === 8) nc--;
    if (code === 128 || code === 1 || code === 2) nc++;
    
    if (nr >= 0 && nr < height && nc >= 0 && nc < width) {
      return nr * width + nc;
    }
    return -1;
  };

  let head = 0;
  while (head < queue.length) {
    const u = queue[head++];
    const dir = flowDirection[u];
    if (dir === 0) continue;

    const v = getD8NeighborOffset(u, dir);
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
```

#### 3. Channel Network and Junction extraction
Define channels where `accumulation >= threshold` and merge them into GeoJSON LineStrings. Find junctions where in-degree >= 2.

```typescript
export function extractChannels(
  width: number,
  height: number,
  flowDirection: Uint8Array,
  flowAccumulation: Float32Array,
  threshold: number,
  geotransform: number[]
): { channelNetwork: any; junctionPoints: any } {
  const size = width * height;
  const isChannel = new Uint8Array(size);
  const chanInDegree = new Uint8Array(size);
  const nextOffset = new Int32Array(size);
  nextOffset.fill(-1);

  // Helper to map pixel to GeoJSON spatial coordinates
  const pixelToCoords = (idx: number): [number, number] => {
    const r = Math.floor(idx / width);
    const c = idx % width;
    const x = geotransform[0] + c * geotransform[1] + r * geotransform[2];
    const y = geotransform[3] + c * geotransform[4] + r * geotransform[5];
    return [x, y];
  };

  const getNeighbor = (u: number, code: number) => {
    const r = Math.floor(u / width);
    const c = u % width;
    let nr = r, nc = c;
    if (code === 32 || code === 64 || code === 128) nr--;
    if (code === 8 || code === 4 || code === 2) nr++;
    if (code === 32 || code === 16 || code === 8) nc--;
    if (code === 128 || code === 1 || code === 2) nc++;
    return (nr >= 0 && nr < height && nc >= 0 && nc < width) ? nr * width + nc : -1;
  };

  // Identify channel cells and compute downstream links
  for (let u = 0; u < size; u++) {
    if (flowAccumulation[u] >= threshold) {
      isChannel[u] = 1;
      const dir = flowDirection[u];
      if (dir !== 0) {
        const v = getNeighbor(u, dir);
        if (v !== -1 && flowAccumulation[v] >= threshold) {
          nextOffset[u] = v;
        }
      }
    }
  }

  // Count channel in-degrees to identify sources and junctions
  for (let u = 0; u < size; u++) {
    if (isChannel[u] && nextOffset[u] !== -1) {
      chanInDegree[nextOffset[u]]++;
    }
  }

  const lines: any[] = [];
  const visited = new Uint8Array(size);
  const junctions: any[] = [];

  // Identify junction points (in-degree >= 2)
  for (let i = 0; i < size; i++) {
    if (isChannel[i] && chanInDegree[i] >= 2) {
      junctions.push({
        type: "Feature",
        properties: { cellIndex: i, inDegree: chanInDegree[i] },
        geometry: { type: "Point", coordinates: pixelToCoords(i) }
      });
    }
  }

  // Trace channels starting from channel sources (in-degree === 0) or junctions
  for (let u = 0; u < size; u++) {
    if (isChannel[u] && (chanInDegree[u] === 0 || chanInDegree[u] >= 2) && !visited[u]) {
      let curr = u;
      const coords: [number, number][] = [pixelToCoords(curr)];
      visited[curr] = 1;

      while (nextOffset[curr] !== -1) {
        const next = nextOffset[curr];
        coords.push(pixelToCoords(next));
        
        // Stop if the next cell is a junction or has already been visited
        if (chanInDegree[next] >= 2 || visited[next]) {
          break;
        }
        
        visited[next] = 1;
        curr = next;
      }

      if (coords.length > 1) {
        lines.push({
          type: "Feature",
          properties: { sourceIndex: u, length: coords.length },
          geometry: { type: "LineString", coordinates: coords }
        });
      }
    }
  }

  return {
    channelNetwork: { type: "FeatureCollection", features: lines },
    junctionPoints: { type: "FeatureCollection", features: junctions }
  };
}
```

#### 4. Basin Delineation
Trace upstream from junctions recursively (or iteratively using a queue to prevent stack overflow) based on the `flowDirection` array.

```typescript
export function delineateBasins(
  width: number,
  height: number,
  flowDirection: Uint8Array,
  junctions: any[]
): Int32Array {
  const size = width * height;
  const basinIdArray = new Int32Array(size); // 0 means unassigned basin
  const dRow = [-1, -1, -1, 0, 0, 1, 1, 1];
  const dCol = [-1, 0, 1, -1, 1, -1, 0, 1];
  const oppositeCodes = [4, 8, 16, 1, 2, 32, 64, 128]; // codes flowing into center cell

  const getOppositeCodeIdx = (r1: number, c1: number, r2: number, c2: number) => {
    const dr = r1 - r2;
    const dc = c1 - c2;
    // Map relative displacement back to opposite direction codes
    if (dr === -1 && dc === -1) return 4;
    if (dr === -1 && dc === 0) return 8;
    if (dr === -1 && dc === 1) return 16;
    if (dr === 0 && dc === -1) return 1;
    if (dr === 0 && dc === 1) return 2;
    if (dr === 1 && dc === -1) return 32;
    if (dr === 1 && dc === 0) return 64;
    if (dr === 1 && dc === 1) return 128;
    return 0;
  };

  const checkFlowsTo = (neighborIdx: number, centerIdx: number) => {
    const nr = Math.floor(neighborIdx / width);
    const nc = neighborIdx % width;
    const cr = Math.floor(centerIdx / width);
    const cc = centerIdx % width;
    const requiredCode = getOppositeCodeIdx(nr, nc, cr, cc);
    return flowDirection[neighborIdx] === requiredCode;
  };

  // Perform iterative upstream BFS for each junction to assign a basin ID
  junctions.forEach((juncFeature, i) => {
    const startIdx = juncFeature.properties.cellIndex;
    const basinId = i + 1; // IDs start at 1
    const queue: number[] = [startIdx];
    basinIdArray[startIdx] = basinId;

    let head = 0;
    while (head < queue.length) {
      const u = queue[head++];
      const r = Math.floor(u / width);
      const c = u % width;

      for (let d = 0; d < 8; d++) {
        const nr = r + dRow[d];
        const nc = c + dCol[d];
        if (nr >= 0 && nr < height && nc >= 0 && nc < width) {
          const v = nr * width + nc;
          if (basinIdArray[v] === 0 && checkFlowsTo(v, u)) {
            basinIdArray[v] = basinId;
            queue.push(v);
          }
        }
      }
    }
  });

  return basinIdArray;
}
```

#### 5. Vectorize Basins (Marching Squares / Contour Tracing)
Generate simplified bounding polygon coordinates for each subbasin.
- **Trace Boundaries:** Locate edges separating pixels of `basinId = X` from outer pixels, construct loops, and convert them to GeoJSON coordinates using the geotransform structure.

```typescript
export function vectorizeBasins(
  width: number,
  height: number,
  basinIdArray: Int32Array,
  geotransform: number[]
): any {
  const features: any[] = [];
  const uniqueBasinIds = Array.from(new Set(basinIdArray)).filter(id => id > 0);

  const pixelToCoords = (col: number, row: number): [number, number] => {
    const x = geotransform[0] + col * geotransform[1] + row * geotransform[2];
    const y = geotransform[3] + col * geotransform[4] + row * geotransform[5];
    return [x, y];
  };

  uniqueBasinIds.forEach(basinId => {
    // Generate horizontal and vertical cell boundary edges
    const edges = new Set<string>();
    for (let r = 0; r < height; r++) {
      for (let c = 0; c < width; c++) {
        const u = r * width + c;
        const inBasin = basinIdArray[u] === basinId;

        // Check horizontal boundary (edge above pixel)
        const aboveBasin = r > 0 ? (basinIdArray[(r - 1) * width + c] === basinId) : false;
        if (inBasin !== aboveBasin) {
          const key = inBasin ? `${c},${r}->${c+1},${r}` : `${c+1},${r}->${c},${r}`;
          edges.add(key);
        }

        // Check vertical boundary (edge left of pixel)
        const leftBasin = c > 0 ? (basinIdArray[r * width + c - 1] === basinId) : false;
        if (inBasin !== leftBasin) {
          const key = inBasin ? `${c},${r+1}->${c},${r}` : `${c},${r}->${c},${r+1}`;
          edges.add(key);
        }

        // Bottom and right edge boundaries
        if (inBasin) {
          if (r === height - 1) edges.add(`${c+1},${r+1}->${c},${r+1}`);
          if (c === width - 1) edges.add(`${c+1},${r}->${c+1},${r+1}`);
        }
      }
    }

    // Connect directed boundary edges into closed loops
    const adj = new Map<string, string>();
    edges.forEach(e => {
      const [from, to] = e.split("->");
      adj.set(from, to);
    });

    const loops: [number, number][][] = [];
    while (adj.size > 0) {
      const startNode = adj.keys().next().value!;
      let curr = startNode;
      const path: [number, number][] = [];

      while (curr && adj.has(curr)) {
        const [c, r] = curr.split(",").map(Number);
        path.push(pixelToCoords(c, r));
        const next = adj.get(curr)!;
        adj.delete(curr);
        curr = next;
        if (curr === startNode) {
          const [cStart, rStart] = cStart = startNode.split(",").map(Number);
          path.push(pixelToCoords(cStart, rStart));
          break;
        }
      }
      if (path.length > 2) {
        loops.push(path);
      }
    }

    features.push({
      type: "Feature",
      properties: { basinId },
      geometry: { type: "Polygon", coordinates: loops }
    });
  });

  return { type: "FeatureCollection", features };
}
```

---

### Task 4: Setup Web Worker Integration
Create [delineation.worker.ts](file:///c:/Users/erwin/OneDrive/Documents/Learning/Plugin%20Spatio/WatershedDelineation/src/lib/delineation/delineation.worker.ts) to manage the execution order of the steps using transferable Float32Arrays.

#### Action:
Create the worker script:

```typescript
import {
  sinkFill,
  computeD8AndAccumulation,
  extractChannels,
  delineateBasins,
  vectorizeBasins
} from "./algorithms";

self.onmessage = async (e: MessageEvent) => {
  const { type, payload } = e.data;
  if (type !== "RUN_DELINEATION") return;

  const { width, height, elevation, noDataValue, geotransform, zLimit, threshold, crsCode } = payload;

  try {
    // Step 2: Sink-fill
    self.postMessage({ type: "PROGRESS", step: 2, msg: "Sink-filling DEM..." });
    const filledElevation = sinkFill(width, height, elevation, noDataValue, zLimit);

    // Step 3: Flow Accumulation
    self.postMessage({ type: "PROGRESS", step: 3, msg: "Calculating flow direction and accumulation..." });
    const { flowDirection, flowAccumulation } = computeD8AndAccumulation(width, height, filledElevation, noDataValue);

    // Step 4: Channel Network Extraction
    self.postMessage({ type: "PROGRESS", step: 4, msg: "Extracting stream network..." });
    const { channelNetwork, junctionPoints } = extractChannels(
      width,
      height,
      flowDirection,
      flowAccumulation,
      threshold,
      geotransform
    );

    // Step 5: Delineate Watersheds
    self.postMessage({ type: "PROGRESS", step: 5, msg: "Delineating basins..." });
    const basinIdArray = delineateBasins(width, height, flowDirection, junctionPoints.features);

    // Step 6: Vectorize Basins
    self.postMessage({ type: "PROGRESS", step: 6, msg: "Vectorizing basin outlines..." });
    const basinPolygons = vectorizeBasins(width, height, basinIdArray, geotransform);

    // Send everything back using Transferable objects
    self.postMessage({
      type: "COMPLETE",
      payload: {
        filledElevation,
        flowDirection,
        flowAccumulation,
        channelNetwork,
        junctionPoints,
        basinIdArray,
        basinPolygons
      }
    }, [
      filledElevation.buffer,
      flowDirection.buffer,
      flowAccumulation.buffer,
      basinIdArray.buffer
    ]);

  } catch (error: any) {
    self.postMessage({ type: "ERROR", error: error.message });
  }
};
```

---

### Task 5: Implement UI & Right Workbench Panel
Integrate the control inputs, step actions, download logic, and MapLibre layers rendering.

#### Action:
Modify [right-panel.ts](file:///c:/Users/erwin/OneDrive/Documents/Learning/Plugin%20Spatio/WatershedDelineation/src/lib/geolibre/right-panel.ts). Set up the HTML controls matching Section 5 specifications:

- **Interactive Selection:** When a basin polygon is clicked on the map, parse the feature's `basinId` property, set it as the active `Target Basin ID`, run **Step 7 & 8** (Clip and Statistics) on the worker or UI thread, and display the metrics:
  - Minimum elevation
  - Maximum elevation
  - Average/Mean elevation
  - Standard deviation

#### Delineation Pipeline Execution Hook Example:
```typescript
import { fromBlob } from "geotiff";
import { writeFloat32GeoTIFF } from "../utils/geotiff-writer";

let worker: Worker | null = null;
let currentDem: {
  width: number;
  height: number;
  elevation: Float32Array;
  noDataValue: number;
  geotransform: [number, number, number, number, number, number];
  crsCode: number;
} | null = null;

// Pipeline run state caches
let resultsCache: any = null;

function initDelineationUI(container: HTMLElement, app: any) {
  // Build panels, file uploads, sliders, parameters
  
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = ".tif,.tiff";
  
  fileInput.onchange = async () => {
    const file = fileInput.files?.[0];
    if (!file) return;

    if (file.size > 50 * 1024 * 1024) {
       alert("Error: File exceeds maximum limit (50MB).");
       return;
    }

    const tiff = await fromBlob(file);
    const image = await tiff.getImage();
    const width = image.getWidth();
    const height = image.getHeight();
    
    if (width * height > 4194304) {
      alert("Error: Pixel dimensions exceed 2048 x 2048 grid size limit.");
      return;
    }
    
    const rasters = await image.readRasters();
    const elevation = rasters[0] as Float32Array;
    const fileDirectory = image.getFileDirectory();
    const noDataValue = fileDirectory.GDAL_NODATA ? parseFloat(fileDirectory.GDAL_NODATA) : -9999;
    
    // Read geotransform parameters
    const modelPixelScale = fileDirectory.ModelPixelScale;
    const modelTiepoint = fileDirectory.ModelTiepoint;
    const scaleX = modelPixelScale ? modelPixelScale[0] : 1.0;
    const scaleY = modelPixelScale ? -modelPixelScale[1] : -1.0;
    const originX = modelTiepoint ? modelTiepoint[3] : 0.0;
    const originY = modelTiepoint ? modelTiepoint[4] : 0.0;
    
    // Read CRS
    const geoKeyDirectory = fileDirectory.GeoKeyDirectory;
    let crsCode = 3857;
    if (geoKeyDirectory) {
      const numKeys = geoKeyDirectory[3];
      for (let i = 0; i < numKeys; i++) {
        const keyId = geoKeyDirectory[4 + i * 4];
        if (keyId === 3072 || keyId === 2048) {
          crsCode = geoKeyDirectory[4 + i * 4 + 3];
          break;
        }
      }
    }

    currentDem = {
      width,
      height,
      elevation,
      noDataValue,
      geotransform: [originX, scaleX, 0, originY, 0, scaleY],
      crsCode
    };
  };

  const runBtn = document.createElement("button");
  runBtn.textContent = "Run Delineation Analysis";
  
  runBtn.onclick = () => {
    if (!currentDem) return;
    
    if (!worker) {
      worker = new Worker(new URL("../delineation/delineation.worker.ts", import.meta.url), { type: "module" });
    }
    
    worker.postMessage({
      type: "RUN_DELINEATION",
      payload: {
        ...currentDem,
        zLimit: parseFloat((document.getElementById("z-limit") as HTMLInputElement)?.value || "Infinity"),
        threshold: parseInt((document.getElementById("threshold") as HTMLInputElement)?.value || "500"),
      }
    });

    worker.onmessage = async (e) => {
      const { type, step, msg, payload, error } = e.data;
      if (type === "PROGRESS") {
        updateProgressUI(step, msg);
      } else if (type === "COMPLETE") {
        resultsCache = payload;
        
        // 1. Add COG raster layers
        const sinkFilledBuffer = writeFloat32GeoTIFF(currentDem!.width, currentDem!.height, payload.filledElevation, currentDem!.geotransform, currentDem!.crsCode);
        const sinkFilledUrl = URL.createObjectURL(new Blob([sinkFilledBuffer], { type: "image/tiff" }));
        await app.addCogLayer?.("Sink-filled DEM", sinkFilledUrl, { colormap: "terrain", nodata: currentDem!.noDataValue });

        const accumBuffer = writeFloat32GeoTIFF(currentDem!.width, currentDem!.height, payload.flowAccumulation, currentDem!.geotransform, currentDem!.crsCode);
        const accumUrl = URL.createObjectURL(new Blob([accumBuffer], { type: "image/tiff" }));
        await app.addCogLayer?.("Flow Accumulation", accumUrl, { colormap: "blues", nodata: currentDem!.noDataValue });
        
        // 2. Add GeoJSON Vector layers
        app.addGeoJsonLayer("Channel Network", payload.channelNetwork);
        app.addGeoJsonLayer("Watershed Basins", payload.basinPolygons);
        
        setupDownloadLinks(payload);
        enableBasinSelection(payload.basinPolygons, app);
      } else if (type === "ERROR") {
        alert("Pipeline failed: " + error);
      }
    };
  };
}

function enableBasinSelection(basinPolygons: any, app: any) {
  const map = app.getMap?.();
  if (!map) return;

  // Add click handler to query selected subbasins
  map.on("click", "Watershed Basins", (e: any) => {
    if (!e.features || e.features.length === 0) return;
    const basinId = e.features[0].properties.basinId;
    calculateAndShowStatistics(basinId);
  });
}

function calculateAndShowStatistics(selectedBasinId: number) {
  if (!currentDem || !resultsCache) return;
  const { width, height, noDataValue, geotransform } = currentDem;
  const { filledElevation, basinIdArray } = resultsCache;

  // Step 7: Clip
  const clipped = new Float32Array(width * height);
  let min = Infinity, max = -Infinity, sum = 0, count = 0;

  for (let i = 0; i < width * height; i++) {
    if (basinIdArray[i] === selectedBasinId) {
      clipped[i] = filledElevation[i];
      const val = filledElevation[i];
      if (val !== noDataValue && !isNaN(val)) {
        if (val < min) min = val;
        if (val > max) max = val;
        sum += val;
        count++;
      }
    } else {
      clipped[i] = noDataValue;
    }
  }

  const mean = count > 0 ? sum / count : 0;
  let sumSqDiff = 0;
  for (let i = 0; i < width * height; i++) {
    if (basinIdArray[i] === selectedBasinId) {
      const val = filledElevation[i];
      if (val !== noDataValue && !isNaN(val)) {
        sumSqDiff += (val - mean) ** 2;
      }
    }
  }
  const stdDev = count > 0 ? Math.sqrt(sumSqDiff / count) : 0;

  // Update DOM metrics elements
  document.getElementById("stat-basin-id")!.textContent = selectedBasinId.toString();
  document.getElementById("stat-min")!.textContent = min !== Infinity ? `${min.toFixed(1)}m` : "-";
  document.getElementById("stat-max")!.textContent = max !== -Infinity ? `${max.toFixed(1)}m` : "-";
  document.getElementById("stat-mean")!.textContent = count > 0 ? `${mean.toFixed(1)}m` : "-";
  document.getElementById("stat-stddev")!.textContent = count > 0 ? `${stdDev.toFixed(1)}m` : "-";
  
  // Set up download for statistics and clipped raster
  setupClippedDownload(clipped);
}
```

---

## 3. Verification & Testing Instructions

To verify that the code was implemented correctly:

1. **Verify Web Worker Building:**
   - Execute `npm run build:geolibre` and check for any TypeScript errors in the worker file or algorithm imports.
   
2. **Verify Loading and Constraints:**
   - Attempt to upload a small `DEM` (< 50MB, e.g. `256 x 256` px). Verify it loads successfully.
   - Attempt to upload a massive `DEM` (e.g. `4000 x 4000` px) or a file > 50MB. Ensure that the validation flags prevent execution and display the error message.

3. **Verify Raster Layer Generation:**
   - Execute the delineation pipeline.
   - Confirm that "Sink-filled DEM" and "Flow Accumulation" display on the map view as new raster layers with functional colormaps.
   - Download the generated `.tif` files and attempt to open them in QGIS. Verify that the raster bounds and spatial projection match the original input file.

4. **Verify Statistics Delineation:**
   - Click a generated basin polygon on the map view.
   - Verify that the stats readouts (Min, Max, Mean, StdDev) populate with valid numbers.
   - Verify that downloading the Clipped DEM produces a raster containing only data in the bounds of the chosen basin.

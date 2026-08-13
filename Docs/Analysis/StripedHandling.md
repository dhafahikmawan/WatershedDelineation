# Technical Analysis: Client-Side Striped to Tiled Raster Conversion

This document describes how the Watershed Delineation plugin natively handles the conversion of in-memory row-major elevation arrays into **tiled, uncompressed Float32 GeoTIFF** files. This analysis is designed to serve as an implementation guide for junior developers or AI agents attempting to port this functionality to other GeoLibre plugins.

---

## 1. Context & The Core Problem

### The Limitations of GeoLibre / MapLibre COG Loading
GeoLibre uses `addCogLayer` (which relies on `geotiff.js` and MapLibre's COG source internally) to render raster layers on the map canvas. 
- A standard **striped raster** (or scanline-oriented TIFF) organizes pixel data row-by-row. Reading arbitrary spatial bounding boxes from a striped TIFF requires loading large portions of the file, causing high memory usage and latency.
- A **tiled raster** divides the image into uniform rectangular blocks (tiles), allowing the client to selectively request and decode only the tiles covering the visible viewport.
- If a plugin attempts to output a striped GeoTIFF, `geotiff.js` or the COG source will fail to load or fail to display the raster layer dynamically.

### The Client-Side Constraint
To maintain a serverless, offline-capable architecture that works seamlessly on both GeoLibre Desktop (Tauri) and the Web App, the conversion must run entirely in the browser thread or a Web Worker. Wrapping external tools like GDAL (`gdal_translate`) is not feasible due to binary packaging size constraints.

Therefore, the plugin implements a **manual binary GeoTIFF writer** that builds a valid tiled GeoTIFF structure directly into an `ArrayBuffer` in memory.

---

## 2. Dependencies

- **Runtime Dependencies**: **None**. The encoder is built using vanilla TypeScript/JavaScript leveraging standard browser APIs (`ArrayBuffer`, `DataView`, `Blob`).
- **Validation/Reading Dependencies**: `geotiff.js` is utilized in tests and in the plugin UI to parse and read incoming GeoTIFF layers.

---

## 3. Reference: How the Plugin Reads Raster Files

Before writing tiled GeoTIFFs, the plugin must load and parse input DEM files selected by the user. This is done entirely client-side using `geotiff.js`.

### Step-by-Step Raster Parsing Pipeline
1. **Load Blob**: Parse the input file blob using `fromBlob(file)`.
2. **Retrieve Image**: Get the primary image directory (first page) using `tiff.getImage()`.
3. **Read Pixel Data**: Extract raw pixels into a flattened typed array using `image.readRasters({ interleave: true })` and coerce it to a `Float32Array`.
4. **Extract Metadata**: Query the TIFF file directory directory tags using `image.getFileDirectory()` to retrieve coordinate transformation, NoData value, and projection information.

### Reading Code Implementation
The reading logic is structured inside [`right-panel.ts`](file:///c:/Users/erwin/OneDrive/Documents/Learning/Plugin%20Spatio/WatershedDelineation/src/lib/geolibre/right-panel.ts):

```typescript
import { fromBlob } from 'geotiff';

// 1. Open the file blob
const tiff = await fromBlob(file);
const image = await tiff.getImage();
const width = image.getWidth();
const height = image.getHeight();

// 2. Read the raster data array
const rasters = await image.readRasters({ interleave: true });
// Coerce geotiff.js typed array wrapper to Float32Array
const rawRaster = rasters as unknown as { [index: number]: number } & { length: number };
const elevation = new Float32Array(rawRaster.length);
for (let i = 0; i < rawRaster.length; i++) {
  elevation[i] = rawRaster[i];
}

// 3. Extract metadata tags
const fd = image.getFileDirectory() as unknown as Record<string, unknown>;

// NoData Value (GDAL_NODATA tag 42113)
const noDataValue = fd['GDAL_NODATA'] != null ? parseFloat(String(fd['GDAL_NODATA'])) : -9999;

// Spatial Geotransform (ModelPixelScale and ModelTiepoint tags)
const pixelScale = fd['ModelPixelScale'] as number[] | undefined;
const tiepoint = fd['ModelTiepoint'] as number[] | undefined;
const scaleX = pixelScale ? pixelScale[0] : 1.0;
const scaleY = pixelScale ? -pixelScale[1] : -1.0; // South-positive to negative scale
const originX = tiepoint ? tiepoint[3] : 0.0;
const originY = tiepoint ? tiepoint[4] : 0.0;
const geotransform = [originX, scaleX, 0, originY, 0, scaleY];

// 4. Extract EPSG code from GeoKeyDirectory (Tag 34735)
const geoKeys = fd['GeoKeyDirectory'] as number[] | undefined;
let crsCode = 3857; // Default fallback to Web Mercator
if (geoKeys) {
  const numKeys = geoKeys[3];
  for (let i = 0; i < numKeys; i++) {
    const keyId = geoKeys[4 + i * 4];
    // 3072 = ProjectedCSTypeGeoKey, 2048 = GeographicTypeGeoKey
    if (keyId === 3072 || keyId === 2048) {
      crsCode = geoKeys[4 + i * 4 + 3];
      break;
    }
  }
}
```

---

## 4. Tiled TIFF Binary Structure

The generated file follows the standard TIFF specifications but enforces a tiled layout instead of a striped layout.

### A. TIFF Header (8 bytes)
All writes are configured to use **Little-Endian** byte order.

| Offset | Data Type | Value | Description |
|---|---|---|---|
| `0` | `char[2]` | `'II'` (0x49, 0x49) | Byte order indicator (Intel/Little-Endian) |
| `2` | `uint16` | `42` (0x002A) | TIFF Magic Number |
| `4` | `uint32` | `8` | Byte offset of the first Image File Directory (IFD) |

### B. Image File Directory (IFD)
The IFD contains a 2-byte count of directory entries, followed by 14 entries (12 bytes each), and a 4-byte offset pointing to the next IFD (set to `0` as there is only one page).

#### Critical Tag Requirements (Ascending Order)
TIFF specification requires that **all tags be sorted in ascending numerical order** by their Tag ID. If they are not sorted, GIS software (such as QGIS, GDAL, or geotiff.js) will treat the file as corrupted.

| Tag ID (Dec) | Tag ID (Hex) | Tag Name | Type | Count | Value / Offset | Description |
|---|---|---|---|---|---|---|
| **256** | `0x0100` | `ImageWidth` | `LONG` (4) | 1 | `width` | Image width in pixels |
| **257** | `0x0101` | `ImageLength` | `LONG` (4) | 1 | `height` | Image height in pixels |
| **258** | `0x0102` | `BitsPerSample` | `SHORT` (3) | 1 | `32` | 32 bits per pixel (Float32) |
| **259** | `0x0103` | `Compression` | `SHORT` (3) | 1 | `1` | 1 = No compression |
| **262** | `0x0106` | `PhotometricInterpretation` | `SHORT` (3) | 1 | `1` | 1 = BlackIsZero |
| **277** | `0x0115` | `SamplesPerPixel` | `SHORT` (3) | 1 | `1` | 1 sample per pixel (Single band) |
| **322** | `0x0142` | `TileWidth` | `LONG` (4) | 1 | `256` | Width of each tile (Must be multiple of 16) |
| **323** | `0x0143` | `TileLength` | `LONG` (4) | 1 | `256` | Height of each tile (Must be multiple of 16) |
| **324** | `0x0144` | `TileOffsets` | `LONG` (4) | `numTiles` | `tileOffsetsOffset` | Array of absolute byte offsets for each tile |
| **325** | `0x0145` | `TileByteCounts` | `LONG` (4) | `numTiles` | `tileByteCountsOffset` | Array of byte sizes for each tile |
| **339** | `0x0153` | `SampleFormat` | `SHORT` (3) | 1 | `3` | 3 = IEEE floating point |
| **33550** | `0x830E` | `ModelPixelScaleTag` | `DOUBLE` (12) | 3 | `pixelScaleOffset` | Map resolution scales (scaleX, scaleY, scaleZ) |
| **33922** | `0x830F` | `ModelTiepointTag` | `DOUBLE` (12) | 6 | `tiepointOffset` | Pixel-to-Map tiepoint coordinates |
| **34735** | `0x87B1` | `GeoKeyDirectoryTag` | `SHORT` (3) | 16 | `geokeysOffset` | CRS projection directory |

> [!IMPORTANT]
> To convert a striped TIFF to a tiled TIFF, we replace tags **`273` (`StripOffsets`)**, **`278` (`RowsPerStrip`)**, and **`279` (`StripByteCounts`)** with the tile-specific tags **`322` (`TileWidth`)**, **`323` (`TileLength`)**, **`324` (`TileOffsets`)**, and **`325` (`TileByteCounts`)**.

---

## 5. Memory Layout & 8-Byte Alignment

To prevent alignment faults on architectures that strictly enforce typed array addresses (especially Float64 and Float32 views), all multi-byte metadata structures and arrays must start on 8-byte boundary alignments.

### Layout Map

```
+-----------------------------------------------------------+
| Offset (Bytes) | Size (Bytes) | Data Block                |
+----------------+--------------+---------------------------+
| 0              | 8            | TIFF Header ('II' + 42)   |
| 8              | 174          | IFD Table                 |
| 182            | 2            | Alignment Padding (0x00)  |
| 184            | 24           | ModelPixelScale (3x f64)  |
| 208            | 48           | ModelTiepoint (6x f64)    |
| 256            | 32           | GeoKeyDirectory (16x u16) |
| 288            | numTiles * 4 | TileOffsets Array         |
| 288+numTiles*4 | numTiles * 4 | TileByteCounts Array      |
| [Padded Start] | ...          | Pixel Data Block          |
+----------------+--------------+---------------------------+
```

### Padding Calculations
1. **Metadata Start**: The IFD table ends at byte `181`. The next 8-byte aligned offset is calculated as:
   $$\text{pixelScaleOffset} = 184$$
2. **Pixel Data Start**: The `TileByteCounts` array ends at `288 + numTiles * 8`. To ensure the float values inside the pixel buffer are aligned, we pad the start of the pixel data block to the next 8-byte boundary:
   $$\text{pixelDataOffset} = \lceil \frac{288 + (\text{numTiles} \times 8)}{8} \rceil \times 8$$

---

## 6. Implementation Issue: Single-Tile Offset Handling

During implementation, a critical issue arose regarding how TIFF parsers (such as `geotiff.js`) handle single-tile layouts versus multi-tile layouts.

### The Problem: IFD Entry Value/Offset Rules
In the TIFF specification, a 12-byte IFD entry is structured as:
- **Bytes 0–1**: Tag ID (e.g., `324` or `325`)
- **Bytes 2–3**: Tag Type (e.g., `4` for `LONG`)
- **Bytes 4–7**: Count (number of values)
- **Bytes 8–11**: Value or Offset

The specification dictates that **if the data size of the tag values fits within 4 bytes (i.e. Count $\times$ Size $\le$ 4), the actual value must be written directly inside Bytes 8–11**. If the size exceeds 4 bytes, Bytes 8–11 must contain a file offset pointing to where the values are stored.

When the raster image is small enough to fit within a single $256 \times 256$ tile (meaning `numTiles === 1`):
1. The **Count** for `TileOffsets` (Tag `324`) and `TileByteCounts` (Tag `325`) is exactly `1`.
2. Since a single `LONG` value (4 bytes) fits within the Value/Offset field, the reader (`geotiff.js`) expects the **actual pixel data offset** and **actual tile byte count** to be written directly inside the IFD entry.
3. If the writer writes the pointer offset (e.g., `tileOffsetsOffset` pointing to byte `288` containing `pixelDataOffset`), `geotiff.js` interprets the pointer address (`288`) as the actual pixel data offset.
4. Consequently, `geotiff.js` attempts to read pixel data from byte `288`, and reads `288` (or `292`) bytes instead of the actual `singleTileBytes` (`262,144` bytes), throwing `RangeError` (out-of-bounds array buffer slice errors) when trying to read or decode the raster.

### The Solution: Conditional Tag Writing
To resolve this, the writer conditionally adjusts what is written into the tag's Value/Offset field based on `numTiles`:

```typescript
// If numTiles === 1, write values directly.
// If numTiles > 1, write file offset pointers to arrays.
writeTag(324, 4, numTiles, numTiles === 1 ? pixelDataOffset : tileOffsetsOffset);    // TileOffsets
writeTag(325, 4, numTiles, numTiles === 1 ? singleTileBytes : tileByteCountsOffset); // TileByteCounts
```

---

## 7. Tile-Major Pixel Reordering Algorithm

The input elevation array is a standard row-major (scanline) contiguous Float32 array representing the raster from top-left to bottom-right. 

```
Row-Major Input Data:
[ r0c0, r0c1, r0c2, ..., r1c0, r1c1, ... ]
```

We must write this data out in **Tile-Major** order, where every tile is a self-contained contiguous sub-grid of dimension $256 \times 256$.

### Coordinate Mapping Math
For a grid of width $W$ and height $H$, with tile width $T_w = 256$ and tile length $T_h = 256$:
1. The grid of tiles has dimensions:
   $$\text{tilesAcross} = \lceil \frac{W}{T_w} \rceil, \quad \text{tilesDown} = \lceil \frac{H}{T_h} \rceil$$
2. For each tile index $t \in [0, \text{numTiles}-1]$:
   - Identify the tile's grid coordinates:
     $$\text{ty} = \lfloor \frac{t}{\text{tilesAcross}} \rfloor, \quad \text{tx} = t \pmod{\text{tilesAcross}}$$
3. Iterate over the local coordinates of the tile ($y \in [0, T_h - 1]$ and $x \in [0, T_w - 1]$):
   - Map local tile coordinates to absolute image coordinates:
     $$\text{imgX} = \text{tx} \times T_w + x, \quad \text{imgY} = \text{ty} \times T_h + y$$
   - If the coordinate lies within the image boundary ($\text{imgX} < W$ and $\text{imgY} < H$):
     $$\text{value} = \text{inputData}[\text{imgY} \times W + \text{imgX}]$$
   - Otherwise (padding region for boundary/edge tiles):
     $$\text{value} = 0.0 \quad \text{(or a designated NoData value)}$$

```
Tile-Major Output Structure:
+-------------------+-------------------+---
| Tile 0 (256x256)  | Tile 1 (256x256)  | ...
| [ p0, p1, ... ]   | [ p0, p1, ... ]   | 
+-------------------+-------------------+---
```

---

## 8. Reference Implementation

Below is the annotated TypeScript implementation for writing a tiled Float32 GeoTIFF. 

```typescript
export function writeFloat32GeoTIFF(
  width: number,
  height: number,
  data: Float32Array,
  geotransform: [number, number, number, number, number, number],
  crsCode: number = 3857,
): ArrayBuffer {
  const isGeographic = crsCode === 4326 || (crsCode >= 4000 && crsCode < 5000);
  const crsKey = isGeographic ? 2048 : 3072;

  // Define tile dimensions
  const TILE_W = 256;
  const TILE_H = 256;
  const tilesAcross = Math.ceil(width / TILE_W);
  const tilesDown = Math.ceil(height / TILE_H);
  const numTiles = tilesAcross * tilesDown;

  // Memory offsets layout calculations
  const ifdEntriesCount = 14;
  const pixelScaleOffset = 184; 
  const tiepointOffset = pixelScaleOffset + 3 * 8; // 208
  const geokeysCount = 16; 
  const geokeysOffset = tiepointOffset + 6 * 8; // 256
  const tileOffsetsOffset = geokeysOffset + geokeysCount * 2; // 288
  const tileByteCountsOffset = tileOffsetsOffset + numTiles * 4;
  const pixelDataOffset = Math.ceil((tileByteCountsOffset + numTiles * 4) / 8) * 8;

  const singleTileBytes = TILE_W * TILE_H * 4; // Float32 = 4 bytes per sample
  const totalSize = pixelDataOffset + numTiles * singleTileBytes;
  
  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);

  // 1. Write TIFF Header
  view.setUint8(0, 0x49); // 'I' (Little-Endian)
  view.setUint8(1, 0x49);
  view.setUint16(2, 42, true); // Magic Number
  view.setUint32(4, 8, true); // First IFD offset

  // 2. Write IFD Entries
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

  // IFD tags must be written in ascending numerical order!
  writeTag(256, 4, 1, width);                       // ImageWidth
  writeTag(257, 4, 1, height);                      // ImageLength
  writeTag(258, 3, 1, 32);                          // BitsPerSample
  writeTag(259, 3, 1, 1);                           // Compression
  writeTag(262, 3, 1, 1);                           // PhotometricInterpretation
  writeTag(277, 3, 1, 1);                           // SamplesPerPixel
  writeTag(322, 4, 1, TILE_W);                      // TileWidth
  writeTag(323, 4, 1, TILE_H);                      // TileLength
  writeTag(324, 4, numTiles, numTiles === 1 ? pixelDataOffset : tileOffsetsOffset);    // TileOffsets
  writeTag(325, 4, numTiles, numTiles === 1 ? singleTileBytes : tileByteCountsOffset); // TileByteCounts
  writeTag(339, 3, 1, 3);                           // SampleFormat (IEEE Float)
  writeTag(33550, 12, 3, pixelScaleOffset);         // ModelPixelScaleTag
  writeTag(33922, 12, 6, tiepointOffset);           // ModelTiepointTag
  writeTag(34735, 3, geokeysCount, geokeysOffset);  // GeoKeyDirectoryTag

  view.setUint32(offset, 0, true); // End of IFD

  // 3. Write ModelPixelScale (scaleX, scaleY, scaleZ)
  view.setFloat64(pixelScaleOffset, geotransform[1], true);
  view.setFloat64(pixelScaleOffset + 8, Math.abs(geotransform[5]), true);
  view.setFloat64(pixelScaleOffset + 16, 0.0, true);

  // 4. Write ModelTiepoint (pixel coords mapping to georeferenced coords)
  view.setFloat64(tiepointOffset, 0.0, true);
  view.setFloat64(tiepointOffset + 8, 0.0, true);
  view.setFloat64(tiepointOffset + 16, 0.0, true);
  view.setFloat64(tiepointOffset + 24, geotransform[0], true); // Origin X
  view.setFloat64(tiepointOffset + 32, geotransform[3], true); // Origin Y
  view.setFloat64(tiepointOffset + 40, 0.0, true);

  // 5. Write GeoKeyDirectory (Projection & CRS keys)
  let kOffset = geokeysOffset;
  view.setUint16(kOffset, 1, true);     // DirectoryVersion
  view.setUint16(kOffset + 2, 1, true); // Revision
  view.setUint16(kOffset + 4, 0, true); // MinorRevision
  view.setUint16(kOffset + 6, 3, true); // NumberOfKeys = 3
  kOffset += 8;

  // GTModelTypeGeoKey
  view.setUint16(kOffset, 1024, true);
  view.setUint16(kOffset + 2, 0, true);
  view.setUint16(kOffset + 4, 1, true);
  view.setUint16(kOffset + 6, isGeographic ? 2 : 1, true);
  kOffset += 8;

  // GTRasterTypeGeoKey (RasterPixelIsArea)
  view.setUint16(kOffset, 1025, true);
  view.setUint16(kOffset + 2, 0, true);
  view.setUint16(kOffset + 4, 1, true);
  view.setUint16(kOffset + 6, 1, true);
  kOffset += 8;

  // CRS Type Key
  view.setUint16(kOffset, crsKey, true);
  view.setUint16(kOffset + 2, 0, true);
  view.setUint16(kOffset + 4, 1, true);
  view.setUint16(kOffset + 6, crsCode, true);

  // 6. Populate Tile Offsets & Tile Byte Counts arrays (only written to buffer if numTiles > 1)
  if (numTiles > 1) {
    for (let i = 0; i < numTiles; i++) {
      view.setUint32(tileOffsetsOffset + i * 4, pixelDataOffset + i * singleTileBytes, true);
      view.setUint32(tileByteCountsOffset + i * 4, singleTileBytes, true);
    }
  }

  // 7. Write Pixel Data in Tile-Major layout
  const pixelFloatView = new Float32Array(buffer, pixelDataOffset, numTiles * TILE_W * TILE_H);
  let destIdx = 0;
  for (let ty = 0; ty < tilesDown; ty++) {
    for (let tx = 0; tx < tilesAcross; tx++) {
      for (let y = 0; y < TILE_H; y++) {
        const imgY = ty * TILE_H + y;
        for (let x = 0; x < TILE_W; x++) {
          const imgX = tx * TILE_W + x;
          if (imgX < width && imgY < height) {
            pixelFloatView[destIdx] = data[imgY * width + imgX];
          } else {
            pixelFloatView[destIdx] = 0.0; // padding for partial/edge tiles
          }
          destIdx++;
        }
      }
    }
  }

  return buffer;
}
```

---

## 9. Porting Guide for Other Geolibre Plugins

When adapting this conversion mechanism to other plugins, keep the following considerations in mind:

### Changing Data Types (e.g., Int16 or Float64)
- **`BitsPerSample` (Tag 258)**: Adjust to matching bit size (e.g., `16` for Int16, `64` for Float64).
- **`SampleFormat` (Tag 339)**:
  - `1` = Unsigned Integer
  - `2` = Two's complement signed integer (typical for Int16 elevation rasters)
  - `3` = IEEE floating point
- **Byte Calculations**: Modify instances of `* 4` (denoting 4 bytes for Float32) to matching bytes per pixel (e.g., `* 2` for Int16, `* 8` for Float64).
- **Typed Views**: Use the appropriate array constructor (e.g., `Int16Array`, `Float64Array`) for the output buffer view in Step 7.

### Multi-band Support
- **`SamplesPerPixel` (Tag 277)**: Increase this value to represent the number of bands.
- **`ExtraSamples` (Tag 338)**: Set if storing alpha channels or auxiliary bands.
- **Pixel Layout**: Change the iteration loop. By default, GeoTIFF uses planar configuration `1` (Chunky format: RGBRGBRGB...), meaning you need to interleave band data pixel by pixel within each tile.

### Memory Optimization for Large Rasters
- For large images, the `ArrayBuffer` allocation can hit browser memory limits. 
- **Solution**: Execute the conversion inside a **Web Worker** to avoid freezing the UI thread, and transfer the output `ArrayBuffer` as a transferable object to eliminate copy overhead.

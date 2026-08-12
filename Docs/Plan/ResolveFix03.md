# Implementation Plan: Convert Striped GeoTIFF to Tiled GeoTIFF

This plan outlines the steps required to resolve the issue where the GeoLibre map engine fails to load the output DEM rasters because it does not support striped rasters and requires tiled rasters (specifically Cloud Optimized GeoTIFF/tiled format compatible with MapLibre's COG source).

---

## 1. Problem Description & Options

Currently, `src/lib/utils/geotiff-writer.ts` manually encodes standard scanline-based (striped) GeoTIFFs. It uses:
* Tag `273` (`StripOffsets`)
* Tag `278` (`RowsPerStrip` set to the image height)
* Tag `279` (`StripByteCounts`)

GeoLibre's `addCogLayer` (which integrates with MapLibre and `geotiff.js` internally) expects **tiled rasters** rather than single-strip or multi-strip rasters.

### Options considered:
1. **Option 1 (Recommended): Upgrade `geotiff-writer.ts` to output tiled TIFFs natively.** This keeps the application self-contained, light, and requires no external binaries or dependencies in the browser/Tauri environment.
2. **Option 2: Use an external library/binary (like GDAL / `gdal_translate`).** This is not practical for our frontend/Tauri environment as it requires packaging large GDAL binaries.

Therefore, we will implement **Option 1**.

---

## 2. Proposed Changes

We will modify `src/lib/utils/geotiff-writer.ts` to produce a tiled TIFF layout.

### A. Tiled TIFF Specification Changes
We will replace the striped tags with tiled tags. In the TIFF specification, all tags must be written in ascending numerical order:

| Tag ID | Tag Name | Type | Count | Description |
|---|---|---|---|---|
| `256` (`0x0100`) | `ImageWidth` | `LONG` | 1 | Image width in pixels |
| `257` (`0x0101`) | `ImageLength` | `LONG` | 1 | Image height in pixels |
| `258` (`0x0102`) | `BitsPerSample` | `SHORT` | 1 | 32 (for Float32) |
| `259` (`0x0103`) | `Compression` | `SHORT` | 1 | 1 (No compression) |
| `262` (`0x0106`) | `PhotometricInterpretation` | `SHORT` | 1 | 1 (BlackIsZero) |
| `277` (`0x0115`) | `SamplesPerPixel` | `SHORT` | 1 | 1 (Single band) |
| **`322` (`0x0142`)** | **`TileWidth`** | `SHORT` or `LONG` | 1 | E.g., `256` (Must be multiple of 16) |
| **`323` (`0x0143`)** | **`TileLength`** | `SHORT` or `LONG` | 1 | E.g., `256` (Must be multiple of 16) |
| **`324` (`0x0144`)** | **`TileOffsets`** | `LONG` | `numTiles` | Offset of each tile in the file |
| **`325` (`0x0145`)** | **`TileByteCounts`** | `LONG` | `numTiles` | Number of bytes in each tile |
| `339` (`0x0153`) | `SampleFormat` | `SHORT` | 1 | 3 (IEEE floating point) |
| `33550` (`0x830E`) | `ModelPixelScaleTag` | `DOUBLE` | 3 | scaleX, scaleY, scaleZ |
| `33922` (`0x830F`) | `ModelTiepointTag` | `DOUBLE` | 6 | tiepoints mapping |
| `34735` (`0x87B1`) | `GeoKeyDirectoryTag` | `SHORT` | 16 | Coordinate reference system |

Total IFD entries: **14** (instead of 13).

### B. Memory Layout Recalculation
Let `tileWidth = 256` and `tileLength = 256`.
Let `tilesAcross = Math.ceil(width / tileWidth)`.
Let `tilesDown = Math.ceil(height / tileLength)`.
Let `numTiles = tilesAcross * tilesDown`.

With 14 IFD entries, the file buffer is arranged as follows:
* **TIFF Header**: 8 bytes (offsets `0` to `7`)
* **IFD Directory**: 2 bytes (entry count) + 14 entries * 12 bytes + 4 bytes (offset to next IFD) = `174` bytes (offsets `8` to `181`).
* **Alignment Boundary**: Align next metadata to 8-byte boundary -> `184`.
* **Metadata & Array Offsets**:
  * `pixelScaleOffset` = `184` (24 bytes: 3 × double)
  * `tiepointOffset` = `208` (48 bytes: 6 × double)
  * `geokeysOffset` = `256` (32 bytes: 16 × uint16)
  * `tileOffsetsOffset` = `288` (`numTiles * 4` bytes: `numTiles` × uint32)
  * `tileByteCountsOffset` = `288 + numTiles * 4` (`numTiles * 4` bytes: `numTiles` × uint32)
  * `pixelDataOffset` = Align `tileByteCountsOffset + numTiles * 4` to the next 8-byte boundary:
    `pixelDataOffset = Math.ceil((288 + numTiles * 8) / 8) * 8`

Total file size: `pixelDataOffset + numTiles * tileWidth * tileLength * 4` bytes.

### C. Pixel Reordering Logic
Since the input `data` array is a standard contiguous Float32 scanline array of size `width * height`, we must map and re-order it into tile-by-tile order:
1. Initialize the pixel float view in the array buffer starting at `pixelDataOffset` with the total tiled buffer size.
2. For each tile index `t` from `0` to `numTiles - 1`:
   * Determine the tile coordinates:
     `ty = Math.floor(t / tilesAcross)`
     `tx = t % tilesAcross`
   * Write tile pixel data:
     Loop `y` from `0` to `tileLength - 1`:
     Loop `x` from `0` to `tileWidth - 1`:
     * Target coordinate in the original image:
       `imgX = tx * tileWidth + x`
       `imgY = ty * tileLength + y`
     * If `imgX < width` and `imgY < height`:
       Value = `data[imgY * width + imgX]`
     * Else (padding region):
       Value = `0` (or `noDataValue` if we want to support it, but `0` is safe)
     * Write Value to the correct position in the output float array.

---

## 3. Implementation Step-by-Step

### Component: GeoTIFF Writer Utilities

#### [MODIFY] [geotiff-writer.ts](file:///c:/Users/erwin/OneDrive/Documents/Learning/Plugin%20Spatio/WatershedDelineation/src/lib/utils/geotiff-writer.ts)

Replace `writeFloat32GeoTIFF` implementation:

```typescript
export function writeFloat32GeoTIFF(
  width: number,
  height: number,
  data: Float32Array,
  geotransform: [number, number, number, number, number, number],
  crsCode: number = 3857,
): ArrayBuffer {
  const isGeographic = crsCode === 4326;
  const crsKey = isGeographic ? 2048 : 3072;

  // Define tile sizes
  const tileWidth = 256;
  const tileLength = 256;
  const tilesAcross = Math.ceil(width / tileWidth);
  const tilesDown = Math.ceil(height / tileLength);
  const numTiles = tilesAcross * tilesDown;

  // Offset calculations
  const ifdEntriesCount = 14;
  const pixelScaleOffset = 184;
  const tiepointOffset = pixelScaleOffset + 3 * 8; // 208
  const geokeysCount = 16;
  const geokeysOffset = tiepointOffset + 6 * 8; // 256
  const tileOffsetsOffset = geokeysOffset + geokeysCount * 2; // 288
  const tileByteCountsOffset = tileOffsetsOffset + numTiles * 4;
  const pixelDataOffset = Math.ceil((tileByteCountsOffset + numTiles * 4) / 8) * 8;

  const totalSize = pixelDataOffset + numTiles * tileWidth * tileLength * 4;
  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);

  // 1. TIFF header
  view.setUint8(0, 0x49); // 'I'
  view.setUint8(1, 0x49); // 'I'
  view.setUint16(2, 42, true); // TIFF magic
  view.setUint32(4, 8, true); // Offset to first IFD

  // 2. Image File Directory (IFD)
  let offset = 8;
  view.setUint16(offset, ifdEntriesCount, true);
  offset += 2;

  const writeTag = (
    tag: number,
    type: number,
    count: number,
    valOrOffset: number,
  ): void => {
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
  writeTag(259, 3, 1, 1); // Compression = No compression
  writeTag(262, 3, 1, 1); // PhotometricInterpretation
  writeTag(277, 3, 1, 1); // SamplesPerPixel = 1
  writeTag(322, 4, 1, tileWidth); // TileWidth
  writeTag(323, 4, 1, tileLength); // TileLength
  writeTag(324, 4, numTiles, tileOffsetsOffset); // TileOffsets
  writeTag(325, 4, numTiles, tileByteCountsOffset); // TileByteCounts
  writeTag(339, 3, 1, 3); // SampleFormat = 3 (float)
  writeTag(33550, 12, 3, pixelScaleOffset); // ModelPixelScaleTag
  writeTag(33922, 12, 6, tiepointOffset); // ModelTiepointTag
  writeTag(34735, 3, geokeysCount, geokeysOffset); // GeoKeyDirectoryTag

  view.setUint32(offset, 0, true); // End of IFD

  // 3. ModelPixelScale
  view.setFloat64(pixelScaleOffset, scaleX, true);
  view.setFloat64(pixelScaleOffset + 8, Math.abs(scaleY), true);
  view.setFloat64(pixelScaleOffset + 16, 0.0, true);

  // 4. ModelTiepoint
  view.setFloat64(tiepointOffset, 0.0, true);
  view.setFloat64(tiepointOffset + 8, 0.0, true);
  view.setFloat64(tiepointOffset + 16, 0.0, true);
  view.setFloat64(tiepointOffset + 24, originX, true);
  view.setFloat64(tiepointOffset + 32, originY, true);
  view.setFloat64(tiepointOffset + 40, 0.0, true);

  // 5. GeoKeyDirectory
  let kOffset = geokeysOffset;
  view.setUint16(kOffset, 1, true);
  view.setUint16(kOffset + 2, 1, true);
  view.setUint16(kOffset + 4, 0, true);
  view.setUint16(kOffset + 6, 3, true);
  kOffset += 8;

  view.setUint16(kOffset, 1024, true);
  view.setUint16(kOffset + 2, 0, true);
  view.setUint16(kOffset + 4, 1, true);
  view.setUint16(kOffset + 6, isGeographic ? 2 : 1, true);
  kOffset += 8;

  view.setUint16(kOffset, 1025, true);
  view.setUint16(kOffset + 2, 0, true);
  view.setUint16(kOffset + 4, 1, true);
  view.setUint16(kOffset + 6, 1, true);
  kOffset += 8;

  view.setUint16(kOffset, crsKey, true);
  view.setUint16(kOffset + 2, 0, true);
  view.setUint16(kOffset + 4, 1, true);
  view.setUint16(kOffset + 6, crsCode, true);

  // 6. Write Tile Offsets & Tile Byte Counts arrays
  const singleTileSize = tileWidth * tileLength * 4;
  for (let i = 0; i < numTiles; i++) {
    view.setUint32(tileOffsetsOffset + i * 4, pixelDataOffset + i * singleTileSize, true);
    view.setUint32(tileByteCountsOffset + i * 4, singleTileSize, true);
  }

  // 7. Reorder & copy Pixel Data into tiled structure
  const pixelFloatView = new Float32Array(buffer, pixelDataOffset, numTiles * tileWidth * tileLength);
  let destIdx = 0;
  for (let ty = 0; ty < tilesDown; ty++) {
    for (let tx = 0; tx < tilesAcross; tx++) {
      for (let y = 0; y < tileLength; y++) {
        const imgY = ty * tileLength + y;
        for (let x = 0; x < tileWidth; x++) {
          const imgX = tx * tileWidth + x;
          if (imgX < width && imgY < height) {
            pixelFloatView[destIdx++] = data[imgY * width + imgX];
          } else {
            pixelFloatView[destIdx++] = 0.0; // padding
          }
        }
      }
    }
  }

  return buffer;
}
```

---

## 4. Verification Plan

### Automated Tests
Verify that the generated tiled GeoTIFF can be correctly parsed by the standard `geotiff` parser.

Modify/update [`tests/geotiff-writer.test.ts`](file:///c:/Users/erwin/OneDrive/Documents/Learning/Plugin%20Spatio/WatershedDelineation/tests/geotiff-writer.test.ts):
```typescript
import { describe, it, expect } from 'vitest';
import { fromArrayBuffer } from 'geotiff';
import { writeFloat32GeoTIFF } from '../src/lib/utils/geotiff-writer';

describe('writeFloat32GeoTIFF (tiled)', () => {
  it('should generate a valid TILED GeoTIFF readable by geotiff.js', async () => {
    const width = 300; // larger than 256 to force multiple tiles
    const height = 300;
    const data = new Float32Array(width * height);
    for (let i = 0; i < data.length; i++) {
      data[i] = i % 100;
    }
    const geotransform: [number, number, number, number, number, number] = [0, 1, 0, 0, 0, -1];
    const buffer = writeFloat32GeoTIFF(width, height, data, geotransform, 3857);

    // Parse the generated buffer
    const tiff = await fromArrayBuffer(buffer);
    const image = await tiff.getImage();

    expect(image.getWidth()).toBe(width);
    expect(image.getHeight()).toBe(height);
    expect(image.isTiled()).toBe(true);
    expect(image.getTileWidth()).toBe(256);
    expect(image.getTileLength()).toBe(256);

    const rasters = await image.readRasters();
    const rasterData = rasters[0] as Float32Array;
    
    // Check pixel at boundary to ensure correctness
    expect(rasterData[0]).toBe(0);
    expect(rasterData[1]).toBe(1);
    expect(rasterData[width + 1]).toBe((width + 1) % 100);
  });
});
```

Run tests using:
```bash
npx vitest tests/geotiff-writer.test.ts
```

### Manual Verification
1. Run "Run Analysis" on `/Docs/Plan/Samples/output_hh.tif` with a Z-Limit of `0.2` in the plugin UI.
2. Verify that GeoLibre loads the generated "Sink-filled DEM" layer and other intermediate layers on the map view successfully without failing to load the raster layers.

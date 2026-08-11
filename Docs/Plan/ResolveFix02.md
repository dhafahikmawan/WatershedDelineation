# Implementation Plan: Resolve Missing SamplesPerPixel Tag in Manually Generated GeoTIFF

This plan outlines the steps required to fix the following runtime pipeline error when running the Watershed Delineation analysis:
```
[WatershedDelineation] Pipeline error: Error: SamplesPerPixel tag should always exist.
  at v (http://tauri.localhost/assets/maplibre-DH7n_4OM.js:12176:71536)
  ...
```

---

## 1. Problem Description

The custom GeoTIFF writer `src/lib/utils/geotiff-writer.ts` manually constructs a binary single-band Float32 GeoTIFF from scratch.
However, it only writes 12 TIFF directory entries (tags) and omits the standard `SamplesPerPixel` tag (Tag ID `277` / `0x0115`).
While some basic TIFF parsers can default to 1 sample per pixel, `geotiff.js` (used in MapLibre / GeoLibre's `addCogLayer` via `fromTiff`) strictly requires this tag to exist. When the tag is missing, `geotiff.js` throws an error: `SamplesPerPixel tag should always exist.`.

For a single-band DEM (elevation raster), the `SamplesPerPixel` value must be set to `1`.

---

## 2. Proposed Changes

We will modify the manually constructed TIFF structure to:
1. Increase the IFD (Image File Directory) entry count from `12` to `13`.
2. Add the `SamplesPerPixel` tag (ID `277`, type `3` (SHORT), count `1`, value `1`).
3. Maintain the ascending order of Tag IDs required by the TIFF specification by inserting the `SamplesPerPixel` tag between `StripOffsets` (ID `273`) and `RowsPerStrip` (ID `278`).
4. Shift and recalculate the subsequent binary structure offsets to ensure they remain aligned to 8-byte boundaries.

### Recalculation of Offsets
With 13 IFD entries, the memory layout shifts as follows:
* **TIFF Header**: 8 bytes (offsets `0` to `7`)
* **IFD Directory**: 2 bytes (entry count) + 13 entries * 12 bytes + 4 bytes (offset to next IFD) = `162` bytes (offsets `8` to `169`).
* **Next 8-Byte Boundary**: `176` (rounded up from `170` to a multiple of 8).
* **Double/Metadata Offsets**:
  * `pixelScaleOffset` = `176` (previously `160`)
  * `tiepointOffset` = `176` + 3 doubles * 8 bytes = `200` (previously `184`)
  * `geokeysOffset` = `200` + 6 doubles * 8 bytes = `248` (previously `232`)
  * `pixelDataOffset` = `248` + 16 uint16s * 2 bytes = `280` (previously `264`)

---

### Component: GeoTIFF Writer Utilities

#### [MODIFY] [geotiff-writer.ts](file:///c:/Users/erwin/OneDrive/Documents/Learning/Plugin%20Spatio/WatershedDelineation/src/lib/utils/geotiff-writer.ts)

Update the layout constants and the IFD writing section:

```diff
   // -----------------------------------------------------------------------
   // Memory layout (all offsets aligned to 8-byte boundaries):
-  //   0       - TIFF header (8 bytes)
-  //   8       - IFD: 2-byte entry count + 12 entries * 12 bytes + 4-byte next-IFD = 162 bytes
-  //   160     - ModelPixelScale data (3 × float64 = 24 bytes)
-  //   184     - ModelTiepoint data   (6 × float64 = 48 bytes)
-  //   232     - GeoKeyDirectory      (16 × uint16  = 32 bytes)
-  //   264     - Pixel data           (width * height * 4 bytes)
+  //   0       - TIFF header (8 bytes)
+  //   8       - IFD: 2-byte entry count + 13 entries * 12 bytes + 4-byte next-IFD = 168 bytes
+  //   176     - ModelPixelScale data (3 × float64 = 24 bytes)
+  //   200     - ModelTiepoint data   (6 × float64 = 48 bytes)
+  //   248     - GeoKeyDirectory      (16 × uint16  = 32 bytes)
+  //   280     - Pixel data           (width * height * 4 bytes)
   // -----------------------------------------------------------------------
-  const ifdEntriesCount = 12;
-  const pixelScaleOffset = 160;
-  const tiepointOffset = pixelScaleOffset + 3 * 8; // 184
+  const ifdEntriesCount = 13;
+  const pixelScaleOffset = 176;
+  const tiepointOffset = pixelScaleOffset + 3 * 8; // 200
   const geokeysCount = 16; // 4-word header + 3 keys × 4 words each
-  const geokeysOffset = tiepointOffset + 6 * 8; // 232
+  const geokeysOffset = tiepointOffset + 6 * 8; // 248
   const pixelDataOffset = geokeysOffset + geokeysCount * 2; // 264
```

And insert the `SamplesPerPixel` write call:

```diff
   writeTag(259, 3, 1, 1); // Compression = No compression  (SHORT)
   writeTag(262, 3, 1, 1); // PhotometricInterpretation = BlackIsZero  (SHORT)
   writeTag(273, 4, 1, pixelDataOffset); // StripOffsets -> pixel data area  (LONG)
+  writeTag(277, 3, 1, 1); // SamplesPerPixel = 1  (SHORT)
   writeTag(278, 4, 1, height); // RowsPerStrip = all rows  (LONG)
   writeTag(279, 4, 1, width * height * 4); // StripByteCounts  (LONG)
```

---

## 3. Verification Plan

### Automated Tests

Create a new test file [`tests/geotiff-writer.test.ts`](file:///c:/Users/erwin/OneDrive/Documents/Learning/Plugin%20Spatio/WatershedDelineation/tests/geotiff-writer.test.ts) to verify the output buffer format and successful parsing by `geotiff`:

```typescript
import { describe, it, expect } from 'vitest';
import { fromArrayBuffer } from 'geotiff';
import { writeFloat32GeoTIFF } from '../src/lib/utils/geotiff-writer';

describe('writeFloat32GeoTIFF', () => {
  it('should generate a valid GeoTIFF readable by geotiff.js with SamplesPerPixel = 1', async () => {
    const width = 4;
    const height = 4;
    const data = new Float32Array(width * height).fill(10.5);
    const geotransform: [number, number, number, number, number, number] = [0, 1, 0, 0, 0, -1];
    const buffer = writeFloat32GeoTIFF(width, height, data, geotransform, 3857);

    // Parse the generated buffer using geotiff.js
    const tiff = await fromArrayBuffer(buffer);
    const image = await tiff.getImage();

    expect(image.getWidth()).toBe(width);
    expect(image.getHeight()).toBe(height);
    expect(image.getSamplesPerPixel()).toBe(1);

    const rasters = await image.readRasters();
    const rasterData = rasters[0] as Float32Array;
    expect(rasterData).toHaveLength(width * height);
    expect(rasterData[0]).toBe(10.5);
  });
});
```

Run the tests to verify the fix works correctly:
```bash
npx vitest tests/geotiff-writer.test.ts
```

### Manual Verification
1. Run "Run Analysis" on `/Docs/Plan/Samples/output_hh.tif` with a Z-Limit of `0.2` in the plugin UI.
2. Confirm the pipeline completes successfully without producing the `SamplesPerPixel tag should always exist` error.

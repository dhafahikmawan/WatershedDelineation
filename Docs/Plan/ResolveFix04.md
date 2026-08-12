# Implementation Plan: Resolve Coordinates and CRS Preservation, and Load Source Raster

This plan outlines the steps required to resolve the issues described in `Docs/Fix/Fix04.md`:
1. The result rasters (e.g. Sink-filled DEM) rendering at coordinates `0,0` or being misaligned due to incorrect extraction of the CRS/geotransform metadata.
2. The plugin failing to load the source/user uploaded raster onto the map prior to running the analysis pipeline.

---

## 1. Problem Description & Root Cause

### A. Geotransform and CRS Metadata Extraction Bug
In `src/lib/geolibre/right-panel.ts`, the file input handler parses the uploaded GeoTIFF using `geotiff.js` and attempts to extract spatial references (pixel scale, tiepoint, CRS, and nodata value) by reading properties directly from the directory object:
```typescript
const fd = image.getFileDirectory() as unknown as Record<string, unknown>;
const noDataValue = fd['GDAL_NODATA'] != null ? parseFloat(String(fd['GDAL_NODATA'])) : -9999;
const pixelScale = fd['ModelPixelScale'] as number[] | undefined;
const tiepoint = fd['ModelTiepoint'] as number[] | undefined;
const geoKeys = fd['GeoKeyDirectory'] as number[] | undefined;
```
Because the `ImageFileDirectory` object returned by `image.getFileDirectory()` does not expose these properties as own properties or getters directly, they evaluate to `undefined`. As a result:
- The geotransform defaults to `originX = 0`, `originY = 0`, `scaleX = 1`, `scaleY = -1`.
- The `crsCode` defaults to `3857`.
- The output GeoTIFF files generated via `writeFloat32GeoTIFF` are encoded with these incorrect values, causing them to render at `0,0`.

**Solution**: Use the geotiff.js `ImageFileDirectory.prototype.getValue(tag)` method (e.g., `fd.getValue('ModelPixelScale')`) to safely retrieve these metadata tags, and use the official `image.getGeoKeys()` method to read CRS keys.

### B. Geographic CRS Robustness
In `src/lib/utils/geotiff-writer.ts`, the check for geographic coordinate systems is hardcoded strictly to EPSG 4326:
```typescript
const isGeographic = crsCode === 4326;
```
If a user uploads a GeoTIFF using a different geographic coordinate system (e.g. EPSG 4269), it defaults to projected, writing the wrong GeoTIFF headers.

**Solution**: Generalize the geographic CRS check to include other typical geographic coordinate reference systems (e.g., in the range `[4000, 4999]`).

### C. Load Source Raster Prior to Analysis
The original uploaded DEM is currently parsed to set internal state but never loaded onto the map.

**Solution**: In the file input handler, right after parsing the image and setting `currentDem`, immediately generate an object URL from the uploaded file and load it using `app.addCogLayer`.

---

## 2. Proposed Changes

### Component 1: Right Panel UI
#### [MODIFY] [right-panel.ts](file:///c:/Users/erwin/OneDrive/Documents/Learning/Plugin%20Spatio/WatershedDelineation/src/lib/geolibre/right-panel.ts)

- Update metadata extraction inside the file `change` event listener to use `fd.getValue` and `image.getGeoKeys()`.
- Load the uploaded file onto the map as "Source DEM" using `app.addCogLayer`.

### Component 2: GeoTIFF Writer Utilities
#### [MODIFY] [geotiff-writer.ts](file:///c:/Users/erwin/OneDrive/Documents/Learning/Plugin%20Spatio/WatershedDelineation/src/lib/utils/geotiff-writer.ts)

- Update the `isGeographic` check to cover the `[4000, 4999]` range.

---

## 3. Implementation Step-by-Step

### Step 1: Update metadata extraction and load the source raster in `right-panel.ts`

In `src/lib/geolibre/right-panel.ts`, locate the `fileInput` change event listener (around line 200) and replace the metadata reading and state setting logic with the following:

```typescript
      const rasters = await image.readRasters({ interleave: true });
      // geotiff.js returns a typed array — coerce to Float32Array
      const rawRaster = rasters as unknown as { [index: number]: number } & { length: number };
      const elevation = new Float32Array(rawRaster.length);
      for (let i = 0; i < rawRaster.length; i++) elevation[i] = rawRaster[i];

      // Retrieve properties safely using getValue() and getGeoKeys()
      const fd = image.getFileDirectory();
      const noDataValueRaw = fd.getValue('GDAL_NODATA');
      const noDataValue = noDataValueRaw != null ? parseFloat(String(noDataValueRaw)) : -9999;

      const pixelScale = fd.getValue('ModelPixelScale') as number[] | undefined;
      const tiepoint = fd.getValue('ModelTiepoint') as number[] | undefined;
      const scaleX = pixelScale ? pixelScale[0] : 1.0;
      const scaleY = pixelScale ? -pixelScale[1] : -1.0; // south-positive → negative
      const originX = tiepoint ? tiepoint[3] : 0.0;
      const originY = tiepoint ? tiepoint[4] : 0.0;

      // Extract EPSG code from GeoKeys
      const geoKeys = image.getGeoKeys();
      let crsCode = 3857;
      if (geoKeys) {
        if (geoKeys.ProjectedCSTypeGeoKey) {
          crsCode = geoKeys.ProjectedCSTypeGeoKey;
        } else if (geoKeys.GeographicTypeGeoKey) {
          crsCode = geoKeys.GeographicTypeGeoKey;
        }
      }

      currentDem = {
        width,
        height,
        elevation,
        noDataValue,
        geotransform: [originX, scaleX, 0, originY, 0, scaleY],
        crsCode,
      };
      delineationResult = null;
      refreshRunButton();

      badge1.className = 'wd-badge wd-badge--ok';
      badge1.textContent = 'Loaded';
      fileNameEl.textContent = `${file.name} — ${width} × ${height} px`;

      // Load the source/user uploaded raster on the map
      const sourceDemUrl = URL.createObjectURL(file);
      createdObjectUrls.push(sourceDemUrl);
      await app.addCogLayer?.('Source DEM', sourceDemUrl, {
        colormap: 'terrain',
        nodata: noDataValue,
      });
```

### Step 2: Make `isGeographic` check robust in `geotiff-writer.ts`

In `src/lib/utils/geotiff-writer.ts` (around line 21), replace the `isGeographic` definition:

```typescript
  // Geographic type checks cover WGS 84 (4326) and typical geographic EPSG code ranges [4000, 4999]
  const isGeographic = crsCode === 4326 || (crsCode >= 4000 && crsCode < 5000);
```

---

## 4. Verification Plan

### Automated Tests
Run the unit test suite to make sure that GeoTIFF writing and coordinate formatting remains correct:
```bash
npm run test
```

### Manual Verification
1. Open the plugin UI.
2. Click **Input DEM** and upload `Docs/Samples/output_hh.tif`.
3. Verify that the **Source DEM** layer immediately loads onto the map at the correct coordinates (latitude ~ -7.19, longitude ~ 112.72) and not at `0,0`.
4. Enter a Z-limit of `0.2` and click the run button.
5. Verify that the output analysis layers (e.g. **Sink-filled DEM**, **Flow Accumulation**) load and align perfectly on top of the loaded **Source DEM** layer.

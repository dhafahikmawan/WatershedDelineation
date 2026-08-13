**Plan: Add Raw (Linear) Flow Accumulation Layer + Download**

Objective

- Add an additional map layer containing the raw (integer) flow accumulation values so users can inspect linear counts directly in GeoLibre/QGIS.
- Ensure the plugin's downloadable `flow-accumulation.tif` is clearly documented and contains the linear accumulation values (not the log-scaled visualization).

Why

- The plugin currently writes a log-scaled (`log1p`) accumulation raster to the COG used for the map, which produces non-integer display values (e.g. ~0.69–4.5). Log scaling is useful for visualization but obscures raw counts. Adding a linear layer preserves interpretability while keeping the visual layer.

High-level steps

1. Code changes (small)
   - Edit `src/lib/geolibre/right-panel.ts` → `addResultLayers()`:
     - Before or after creating `logAcc`, also create a Float32 COG from `result.flowAccumulation` (the raw accumulation array).
     - Use `writeFloat32GeoTIFFBlob(dem.width, dem.height, result.flowAccumulation, dem.geotransform, dem.crsCode)` to produce a Blob URL.
     - Call `app.addCogLayer?.('Flow Accumulation (raw)', rawAccUrl, { colormap: 'blues', rescaleMin: 0, rescaleMax: maxAccum, nodata: dem.noDataValue })`.
     - Push the URL into `createdObjectUrls` so it gets revoked on cleanup.
   - Update labels (either here or elsewhere) to indicate the visual COG is log-scaled, e.g. rename existing layer to `Flow Accumulation (log)` and add `Flow Accumulation (raw)`.

2. Download behavior (verify / adjust)
   - Confirm the existing download button `dlFlowAcc` writes the linear `result.flowAccumulation` (it currently does). If not, update the download handler to write the raw accumulation array (not `logAcc`).
   - If desired, add a second download button named `Download flow-accumulation-raw.tif` to make intent explicit.

3. UI tweaks
   - Update the legend, layer names, or panel text to explain that `Flow Accumulation (log)` is for visualization and `Flow Accumulation (raw)` contains counts.
   - Optionally add a toggle that shows/hides the raw layer by default (hide to avoid clutter but allow inspection).

4. Tests & verification
   - Manual: Build and run the plugin, run a delineation, and open the map in GeoLibre. Confirm two layers appear:
     - `Flow Accumulation (log)` shows approximate values like 0.69–4.5.
     - `Flow Accumulation (raw)` shows integer-like counts (0,1,2,... though stored as Float32). Use the map layer inspector or `gdalinfo -stats` on the Blob URL or downloaded file.
   - Automated (optional): Add a unit test that checks `addResultLayers()` calls `app.addCogLayer` with two different URLs and that the raw accum COG contains expected min/max for a test DEM.

5. Documentation
   - Update `Docs/Analysis/Accumulation.md` to mention the new raw layer and how to access/download it.
   - Add a short note in `README.md` or plugin UI text describing the two alternatives and when to use each.

Implementation details & code pointers

- Primary file to edit: `src/lib/geolibre/right-panel.ts`.
- Function to modify: `addResultLayers()` — add a block that creates raw accumulation `rawAccUrl` and calls `app.addCogLayer?.('Flow Accumulation (raw)', rawAccUrl, {...})`.
- Use `writeFloat32GeoTIFFBlob(...)` (already imported) to create the Blob URL exactly like other layers.
- Compute `maxAccum` by scanning `result.flowAccumulation` as is done for `maxAcc` with `logAcc`.

Quick verification commands

- Build/serve plugin (from project root):

```bash
npm run package:geolibre
# or run the dev example as appropriate
```

- Inspect the downloaded COGs with GDAL:

```bash
gdalinfo -stats flow-accumulation.tif
gdalinfo -stats flow-accumulation-raw.tif
```

- Python check (invert log for the visual COG):

```python
import rasterio
import numpy as np

with rasterio.open('flow-accumulation-log.tif') as src:
    a = src.read(1).astype('float32')
raw = np.expm1(a)
print('visual min/max', a.min(), a.max())
print('recovered min/max', raw.min(), raw.max())
```

Risk/Notes

- Adding another COG layer increases memory and network usage; keep the raw layer off by default if map clutter or performance is a concern.
- The raw accumulation array is integer counts but stored in Float32 for the COG writer; this is fine and expected.

Estimated effort

- Code edits: ~30–60 minutes
- Manual verification: ~15–30 minutes
- Tests/docs: ~20–40 minutes

Next actions

- I can implement the code changes in `src/lib/geolibre/right-panel.ts` and update the UI labels now. Would you like me to proceed and create the change as a patch?
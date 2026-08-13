**Analysis: Flow Accumulation Values Appear Non-integer**

- **Context:** When loading the Flow Accumulation layer produced by the plugin into GeoLibre or QGIS, the raster shows a minimum around 0.69 and a maximum around 4.5. Expected raw flow-accumulation values are integer counts of upstream cells (0, 1, 2, ...).

- **Key finding:** The plugin intentionally converts the accumulation raster to a log-scaled Float32 array before adding the COG layer to the map. See the layer creation in [src/lib/geolibre/right-panel.ts](src/lib/geolibre/right-panel.ts) where a `logAcc` array is produced using `Math.log1p()` then written to a COG. That transformation produces non-integer values.

- **Why the values look like ~0.69 → 4.5:** The plugin uses the natural log of (1 + accumulation). If the visualized value is `v`, the original integer accumulation `x` can be recovered as

  - $v = \ln(1 + x)$
  - $x = e^{v} - 1$

  Example:
  - $v_{\min} \approx 0.693 \Rightarrow x = e^{0.693} - 1 \approx 1$ (one upstream cell)
  - $v_{\max} \approx 4.5 \Rightarrow x = e^{4.5} - 1 \approx 89$ (about 89 upstream cells)

  So the displayed min/max are consistent with a log1p transform of integer accumulation counts.

- **Where this happens in the code:** In [src/lib/geolibre/right-panel.ts](src/lib/geolibre/right-panel.ts) the map-visible flow accumulation COG is created from `logAcc` (the log1p-transformed accumulation). The plugin then writes that `logAcc` into a Float32 GeoTIFF blob and adds it as the "Flow Accumulation" layer. The raw (integer) accumulation is still available in the delineation results, and the downloadable `flow-accumulation.tif` written from the pipeline uses the raw `result.flowAccumulation` array (but still stored as Float32). In short: visualization uses log-scaled data; the raw integers are preserved separately.

- **How to verify locally:**

  1. Inspect the COG added by the plugin (the one served in the map): it is the log-scaled raster. Use `gdalinfo` to view statistics:

     ```bash
     gdalinfo -stats flow_accumulation_cog.tif
     ```

     The reported min/max will match the ~0.69–4.5 numbers.

  2. Convert back to original accumulation values with a small Python snippet (requires `rasterio` and `numpy`):

     ```python
     import rasterio
     import numpy as np

     with rasterio.open('flow_accumulation_cog.tif') as src:
         a = src.read(1).astype('float32')
     raw = np.expm1(a)  # invert log1p
     print('visualized min/max:', float(a.min()), float(a.max()))
     print('recovered min/max:', float(raw.min()), float(raw.max()))
     ```

  3. Alternatively, download the "flow-accumulation.tif" provided by the plugin's download button (this file is written from `result.flowAccumulation`) and open it in QGIS — you should see integer-like values (even if encoded as Float32). Use the Raster Layer statistics dialog or `gdalinfo -stats` to confirm.

- **Recommendations / Next steps:**

  - If you want the map layer to show raw accumulation (integers), change the layer creation in [src/lib/geolibre/right-panel.ts](src/lib/geolibre/right-panel.ts) to write `result.flowAccumulation` (possibly scaled) instead of `logAcc`. Note that large accumulation ranges commonly benefit from log scaling for visualization contrast.
  - Keep the current log-scaled COG for visual display, but add an additional "Raw Flow Accumulation (linear)" layer (or toggle) so users can inspect the integer counts directly.
  - When exporting for external use, document whether the TIFF is log-scaled or linear. The plugin already offers a download of the linear `flow-accumulation.tif` — ensure users know which file is which.

- **Summary:** The non-integer min/max values are expected — they come from a deliberate $
\ln(1+x)$ visualization transform. The underlying accumulation values are integer counts and can be recovered (or downloaded) using the methods above.

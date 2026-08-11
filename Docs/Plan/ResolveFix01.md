# Implementation Plan: Resolve Relative Module Resolution Error in GeoLibre Plugin

This plan outlines the steps required to fix the following runtime error when loading the Watershed Delineation plugin:
```
Failed to resolve module specifier "./globals-B9FiI9ma.js". Invalid relative url or base scheme isn't hierarchical.
```

---

## 1. Problem Description

GeoLibre loads external plugins dynamically using `blob:` URLs (`import(URL.createObjectURL(blob))`). 
Because `blob:` is not a hierarchical URI scheme, any relative imports (such as `import "./globals-B9FiI9ma.js"`) fail to resolve at runtime.

By default, Vite's build for the GeoLibre target (`vite.geolibre.config.ts`):
1. Performs code splitting and creates chunks for dependencies (e.g. `geotiff`).
2. Emits a separate file for the Web Worker (`delineation.worker.ts`) using the standard `new URL(..., import.meta.url)` syntax, which fails to resolve relative to a blob base URL.

To fix this, we must configure Vite/Rollup to bundle the entire plugin (including the Web Worker and all dependency chunks) into a **single, self-contained file**.

---

## 2. Proposed Changes

### Component 1: Inline the Web Worker
We will use Vite's built-in inline worker import syntax (`?worker&inline`) to bundle the Web Worker directly into the main module.

#### [MODIFY] [index.ts](file:///c:/Users/erwin/OneDrive/Documents/Learning/Plugin%20Spatio/WatershedDelineation/src/lib/delineation/index.ts)

Replace lines 39-50 with an inlined worker instantiation:

```diff
+import DelineationWorker from './delineation.worker?worker&inline';
+
 let _worker: Worker | null = null;
 
 /** Lazily create the delineation web worker. */
 function getWorker(): Worker {
   if (!_worker) {
-    _worker = new Worker(
-      new URL('./delineation.worker.ts', import.meta.url),
-      { type: 'module' },
-    );
+    _worker = new DelineationWorker();
   }
   return _worker;
 }
```

---

### Component 2: Disable Code Splitting in Vite Config
We will update the Rollup output options to turn off code splitting.

#### [MODIFY] [vite.geolibre.config.ts](file:///c:/Users/erwin/OneDrive/Documents/Learning/Plugin%20Spatio/WatershedDelineation/vite.geolibre.config.ts)

Add `codeSplitting: false` inside the `rollupOptions.output` block:

```diff
     rollupOptions: {
       external: [],
       output: {
         assetFileNames: () => "style.css",
+        codeSplitting: false,
       },
     },
```

---

## 3. Verification Plan

### Automated Verification
1. Run the build command:
   ```bash
   npm run build:geolibre
   ```
2. Verify that the command succeeds with exit code `0`.
3. Check the output directory `geolibre-plugin/dist/` and ensure **only** the following two files are present:
   - `index.js`
   - `style.css`
4. Confirm that **no** files are generated under `geolibre-plugin/dist/assets/` or other separate JS chunk files (e.g. `globals-*.js`).

/**
 * Watershed Delineation — GeoLibre Right-Sidebar Panel
 *
 * This module renders the complete step-by-step UI in GeoLibre's right panel.
 * It owns:
 *   - DEM file loading and validation (Steps 1)
 *   - Pipeline parameter controls (Z-limit, accumulation threshold)
 *   - Triggering the delineation worker (Steps 2-6)
 *   - Adding result layers to the map via the GeoLibre API (addCogLayer / addGeoJsonLayer)
 *   - Download links for every output (Steps 2-6)
 *   - Basin selection and elevation statistics display (Steps 7-8)
 *
 * CSS is loaded from ../styles/watershed-panel.css, scoped to .wd-panel.
 */

import type { GeoLibreAppAPI, GeoLibreControl } from './host-api';
import '../styles/watershed-panel.css';
import { fromBlob } from 'geotiff';
import {
  runDelineation,
  terminateWorker,
  type DemData,
  type DelineationResult,
} from '../delineation/index';
import {
  clipAndComputeStats,
  type ElevationStatistics,
} from '../delineation/algorithms';
import {
  writeFloat32GeoTIFF,
  writeFloat32GeoTIFFBlob,
} from '../utils/geotiff-writer';

// ---------------------------------------------------------------------------
// Constants (developer-controlled limits)
// ---------------------------------------------------------------------------
const MAX_DEM_PIXELS = 16_777_216; // 4096 × 4096
const MAX_FILE_SIZE_MB = 50;

/** Stable panel ID — used by geolibre.ts to open/close the panel. */
export const RIGHT_PANEL_ID = 'watershed-delineation-panel';

// ---------------------------------------------------------------------------
// Module-level state (survives panel collapse / expand)
// ---------------------------------------------------------------------------
let currentDem: DemData | null = null;
let delineationResult: DelineationResult | null = null;

// Revocable Object-URLs created for map layers — cleaned up on deactivation
const createdObjectUrls: string[] = [];

function revokeAllUrls(): void {
  for (const url of createdObjectUrls) {
    URL.revokeObjectURL(url);
  }
  createdObjectUrls.length = 0;
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  children: (HTMLElement | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const child of children) {
    if (typeof child === 'string') {
      node.appendChild(document.createTextNode(child));
    } else {
      node.appendChild(child);
    }
  }
  return node;
}

function makeSection(title: string): { section: HTMLDivElement; header: HTMLDivElement; badge: HTMLSpanElement } {
  const badge = el('span', { className: 'wd-badge' });
  const header = el('div', { className: 'wd-section-header' }, [
    el('span', { className: 'wd-section-title' }, [title]),
    badge,
  ]);
  const section = el('div', { className: 'wd-section' }, [header]);
  return { section, header, badge };
}

function makeRow(
  labelText: string,
  control: HTMLElement,
  extra?: HTMLElement,
): HTMLDivElement {
  const row = el('div', { className: 'wd-row' });
  row.appendChild(el('span', { className: 'wd-label' }, [labelText]));
  row.appendChild(control);
  if (extra) row.appendChild(extra);
  return row;
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function downloadJson(data: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: 'application/json',
  });
  downloadBlob(blob, filename);
}

function downloadGeojson(fc: GeoJSON.FeatureCollection, filename: string): void {
  downloadJson(fc, filename);
}

function downloadCsv(stats: ElevationStatistics, filename: string): void {
  const lines = [
    'metric,value',
    `min,${stats.min}`,
    `max,${stats.max}`,
    `mean,${stats.mean}`,
    `stdDev,${stats.stdDev}`,
    `count,${stats.count}`,
  ];
  downloadBlob(new Blob([lines.join('\n')], { type: 'text/csv' }), filename);
}

// ---------------------------------------------------------------------------
// Panel render function
// ---------------------------------------------------------------------------

/**
 * Register and open the Watershed Delineation right sidebar panel.
 *
 * @param app  GeoLibre host API.
 * @returns    A disposer that closes and unregisters the panel, or `null` if
 *             the host does not support right panels.
 */
export function registerWatershedRightPanel<TControl extends GeoLibreControl>(
  app: GeoLibreAppAPI<TControl>,
): (() => void) | null {
  if (!app.registerRightPanel) return null;

  const unregister = app.registerRightPanel({
    id: RIGHT_PANEL_ID,
    title: 'Watershed Delineation',
    defaultWidth: 340,
    render(container) {
      buildUI(container, app);
      // Cleanup on panel close
      return () => {
        revokeAllUrls();
        terminateWorker();
      };
    },
  });

  app.openRightPanel?.(RIGHT_PANEL_ID);

  return () => {
    app.closeRightPanel?.(RIGHT_PANEL_ID);
    unregister();
  };
}

// ---------------------------------------------------------------------------
// UI builder
// ---------------------------------------------------------------------------

function buildUI<TControl extends GeoLibreControl>(
  container: HTMLElement,
  app: GeoLibreAppAPI<TControl>,
): void {
  const panel = el('div', { className: 'wd-panel' });
  container.appendChild(panel);

  // =========================================================================
  // Section 1: Load DEM
  // =========================================================================
  const { section: sec1, badge: badge1 } = makeSection('1. Load DEM');

  const fileInput = el('input', {
    type: 'file',
    id: 'wd-file-input',
    accept: '.tif,.tiff',
    className: 'wd-input',
  });

  const fileNameEl = el('div', { className: 'wd-filename' }, ['No file selected']);
  const noteEl = el('div', { className: 'wd-note' }, [
    `Max ${MAX_FILE_SIZE_MB} MB · Max ${Math.sqrt(MAX_DEM_PIXELS).toFixed(0)} × ${Math.sqrt(MAX_DEM_PIXELS).toFixed(0)} px`,
  ]);

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;

    badge1.className = 'wd-badge';
    badge1.textContent = '';
    fileNameEl.textContent = file.name;

    if (file.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
      fileNameEl.textContent = `⚠ File exceeds ${MAX_FILE_SIZE_MB} MB limit`;
      badge1.className = 'wd-badge wd-badge--error';
      badge1.textContent = 'Error';
      return;
    }

    try {
      const tiff = await fromBlob(file);
      const image = await tiff.getImage();
      const width = image.getWidth();
      const height = image.getHeight();

      if (width * height > MAX_DEM_PIXELS) {
        fileNameEl.textContent = `⚠ Grid exceeds ${Math.sqrt(MAX_DEM_PIXELS).toFixed(0)}×${Math.sqrt(MAX_DEM_PIXELS).toFixed(0)} limit`;
        badge1.className = 'wd-badge wd-badge--error';
        badge1.textContent = 'Error';
        return;
      }

      const rasters = await image.readRasters({ interleave: true });
      // geotiff.js returns a typed array — coerce to Float32Array
      const rawRaster = rasters as unknown as { [index: number]: number } & { length: number };
      const elevation = new Float32Array(rawRaster.length);
      for (let i = 0; i < rawRaster.length; i++) elevation[i] = rawRaster[i];

      const fd = image.getFileDirectory() as unknown as {
        getValue?: (tag: string) => unknown;
      } & Record<string, unknown>;

      const noDataValueRaw = fd.getValue?.('GDAL_NODATA') ?? fd['GDAL_NODATA'];
      const noDataValue = noDataValueRaw != null ? parseFloat(String(noDataValueRaw)) : -9999;

      const pixelScale = fd.getValue?.('ModelPixelScale') as number[] | undefined ?? (fd['ModelPixelScale'] as number[] | undefined);
      const tiepoint = fd.getValue?.('ModelTiepoint') as number[] | undefined ?? (fd['ModelTiepoint'] as number[] | undefined);
      const scaleX = pixelScale ? pixelScale[0] : 1.0;
      const scaleY = pixelScale ? -pixelScale[1] : -1.0; // south-positive → negative
      const originX = tiepoint ? tiepoint[3] : 0.0;
      const originY = tiepoint ? tiepoint[4] : 0.0;

      const geoKeys = (image as any).getGeoKeys?.();
      let crsCode = 3857;
      if (geoKeys?.ProjectedCSTypeGeoKey) {
        crsCode = geoKeys.ProjectedCSTypeGeoKey;
      } else if (geoKeys?.GeographicTypeGeoKey) {
        crsCode = geoKeys.GeographicTypeGeoKey;
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

      const sourceDemUrl = URL.createObjectURL(file);
      createdObjectUrls.push(sourceDemUrl);
      await app.addCogLayer?.('Source DEM', sourceDemUrl, {
        colormap: 'terrain',
        nodata: noDataValue,
      });
    } catch (err) {
      fileNameEl.textContent = '⚠ Failed to read GeoTIFF';
      badge1.className = 'wd-badge wd-badge--error';
      badge1.textContent = 'Error';
      console.error('[WatershedDelineation] Load error:', err);
    }
  });

  sec1.append(makeRow('Input DEM', fileInput), fileNameEl, noteEl);
  panel.appendChild(sec1);

  // =========================================================================
  // Section 2-6: Analysis Pipeline Parameters + Run Button
  // =========================================================================
  const { section: secPipeline, badge: badgePipeline } = makeSection(
    '2–6. Preprocessing & Delineation',
  );

  // Z-limit
  const zLimitInput = el('input', {
    type: 'number',
    id: 'wd-z-limit',
    className: 'wd-input',
    value: '0',
    min: '0',
    step: '0.1',
    placeholder: '0 = unlimited',
  });
  const zNote = el('div', { className: 'wd-note' }, [
    'Max depression depth to fill (0 = unlimited)',
  ]);

  // Threshold slider + number input
  const thresholdInput = el('input', {
    type: 'range',
    id: 'wd-threshold',
    className: 'wd-input',
    min: '0',
    max: '5000',
    value: '500',
    step: '1',
  });
  const thresholdNumberInput = el('input', {
    type: 'number',
    id: 'wd-threshold-number',
    className: 'wd-input',
    min: '0',
    max: '5000',
    value: '500',
    step: '1',
  });
  const thresholdLabel = el('span', { className: 'wd-value-label' }, ['500 cells']);

  const thresholdControl = el('div', { className: 'wd-threshold-control' }, [thresholdInput, thresholdNumberInput]);

  function updateThresholdDisplay(value: number): void {
    const clamped = Math.max(0, Math.min(5000, Math.round(value)));
    thresholdInput.value = String(clamped);
    thresholdNumberInput.value = String(clamped);
    thresholdLabel.textContent = `${clamped} cells`;
  }

  thresholdInput.addEventListener('input', () => {
    updateThresholdDisplay(parseInt(thresholdInput.value, 10));
  });

  thresholdNumberInput.addEventListener('change', () => {
    const parsed = parseInt(thresholdNumberInput.value, 10);
    updateThresholdDisplay(Number.isNaN(parsed) ? 0 : parsed);
  });

  const progressEl = el('div', { className: 'wd-progress' });

  const runBtn = el('button', {
    className: 'wd-btn wd-btn--primary',
    disabled: true,
    textContent: '▶ Run Analysis',
  });

  // Download links (hidden until pipeline completes)
  const dlSinkFill = el('button', {
    className: 'wd-btn wd-btn--link',
    textContent: '⬇ Download filled-dem.tif',
    disabled: true,
  });
  const dlFlowAcc = el('button', {
    className: 'wd-btn wd-btn--link',
    textContent: '⬇ Download flow-accumulation.tif',
    disabled: true,
  });
  const dlChannels = el('button', {
    className: 'wd-btn wd-btn--link',
    textContent: '⬇ Download network.geojson',
    disabled: true,
  });
  const dlBasins = el('button', {
    className: 'wd-btn wd-btn--link',
    textContent: '⬇ Download basins.geojson',
    disabled: true,
  });

  const downloadRow = el('div', { className: 'wd-btn-row' }, [
    dlSinkFill,
    dlFlowAcc,
    dlChannels,
    dlBasins,
  ]);

  function refreshRunButton(): void {
    runBtn.disabled = currentDem === null;
  }

  runBtn.addEventListener('click', async () => {
    if (!currentDem) return;

    const zLimitRaw = parseFloat(zLimitInput.value);
    const zLimit = isNaN(zLimitRaw) || zLimitRaw <= 0 ? Infinity : zLimitRaw;
    const threshold = parseInt(thresholdInput.value, 10);

    runBtn.disabled = true;
    badgePipeline.className = 'wd-badge wd-badge--running';
    badgePipeline.textContent = 'Running…';
    progressEl.className = 'wd-progress wd-progress--running';
    progressEl.textContent = 'Starting…';

    // Disable download links during run
    [dlSinkFill, dlFlowAcc, dlChannels, dlBasins].forEach((b) => (b.disabled = true));

    try {
      const result = await runDelineation(
        currentDem,
        { zLimit, threshold },
        (step, msg) => {
          progressEl.textContent = `Step ${step}: ${msg}`;
        },
      );

      delineationResult = result;
      progressEl.className = 'wd-progress';
      progressEl.textContent = `Done — ${result.junctionPoints.features.length} subbasin(s) found`;
      badgePipeline.className = 'wd-badge wd-badge--ok';
      badgePipeline.textContent = 'Done';

      // Add result layers to the map
      await addResultLayers(app, currentDem, result);

      // Wire download buttons
      dlSinkFill.disabled = false;
      dlSinkFill.onclick = () => {
        const buf = writeFloat32GeoTIFF(
          currentDem!.width,
          currentDem!.height,
          result.filledElevation,
          currentDem!.geotransform,
          currentDem!.crsCode,
        );
        downloadBlob(new Blob([buf], { type: 'image/tiff' }), 'filled-dem.tif');
      };

      dlFlowAcc.disabled = false;
      dlFlowAcc.onclick = () => {
        const buf = writeFloat32GeoTIFF(
          currentDem!.width,
          currentDem!.height,
          result.flowAccumulation,
          currentDem!.geotransform,
          currentDem!.crsCode,
        );
        downloadBlob(new Blob([buf], { type: 'image/tiff' }), 'flow-accumulation.tif');
      };

      dlChannels.disabled = false;
      dlChannels.onclick = () => downloadGeojson(result.channelNetwork, 'network.geojson');

      dlBasins.disabled = false;
      dlBasins.onclick = () => downloadGeojson(result.basinPolygons, 'basins.geojson');
    } catch (err) {
      progressEl.className = 'wd-progress wd-progress--error';
      progressEl.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
      badgePipeline.className = 'wd-badge wd-badge--error';
      badgePipeline.textContent = 'Failed';
      console.error('[WatershedDelineation] Pipeline error:', err);
    } finally {
      runBtn.disabled = currentDem === null;
    }
  });

  secPipeline.append(
    makeRow('Z-Limit', zLimitInput),
    zNote,
    makeRow('Stream Threshold', thresholdControl, thresholdLabel),
    el('div', { className: 'wd-btn-row' }, [runBtn]),
    progressEl,
    downloadRow,
  );
  panel.appendChild(secPipeline);

  // =========================================================================
  // Section 7-8: Clip & Statistics
  // =========================================================================
  const { section: sec78, badge: badge78 } = makeSection('7–8. Clip & Statistics');

  const basinIdInput = el('input', {
    type: 'number',
    id: 'wd-basin-id',
    className: 'wd-input',
    placeholder: 'Click a basin on the map…',
    min: '1',
    step: '1',
  });

  const clipBtn = el('button', {
    className: 'wd-btn wd-btn--secondary',
    textContent: 'Clip & Compute',
    disabled: true,
  });

  // Stats grid
  const makeStatItem = (label: string, id: string) => {
    const item = el('div', { className: 'wd-stat-item' });
    item.appendChild(el('span', { className: 'wd-stat-label' }, [label]));
    item.appendChild(el('span', { id, className: 'wd-stat-value' }, ['—']));
    return item;
  };

  const statsGrid = el('div', { className: 'wd-stats-grid' }, [
    makeStatItem('Min', 'wd-stat-min'),
    makeStatItem('Max', 'wd-stat-max'),
    makeStatItem('Mean', 'wd-stat-mean'),
    makeStatItem('StdDev', 'wd-stat-stddev'),
  ]);
  statsGrid.style.display = 'none';

  const dlClippedDem = el('button', {
    className: 'wd-btn wd-btn--link',
    textContent: '⬇ Download clipped-dem.tif',
    disabled: true,
  });
  const dlStats = el('button', {
    className: 'wd-btn wd-btn--link',
    textContent: '⬇ Download statistics.csv',
    disabled: true,
  });

  const dlStatsRow = el('div', { className: 'wd-btn-row' }, [dlClippedDem, dlStats]);

  const runClipAndStats = async () => {
    if (!currentDem || !delineationResult) return;
    const basinId = parseInt(basinIdInput.value, 10);
    if (isNaN(basinId) || basinId < 1) return;

    badge78.className = 'wd-badge wd-badge--running';
    badge78.textContent = 'Computing…';

    const { clippedElevation, statistics } = clipAndComputeStats(
      currentDem.width,
      currentDem.height,
      delineationResult.filledElevation,
      delineationResult.basinIdArray,
      basinId,
      currentDem.noDataValue,
    );

    // Display statistics
    statsGrid.style.display = '';
    const fmt = (v: number) => `${v.toFixed(1)} m`;
    (container.querySelector('#wd-stat-min') as HTMLElement).textContent =
      statistics.count > 0 ? fmt(statistics.min) : '—';
    (container.querySelector('#wd-stat-max') as HTMLElement).textContent =
      statistics.count > 0 ? fmt(statistics.max) : '—';
    (container.querySelector('#wd-stat-mean') as HTMLElement).textContent =
      statistics.count > 0 ? fmt(statistics.mean) : '—';
    (container.querySelector('#wd-stat-stddev') as HTMLElement).textContent =
      statistics.count > 0 ? fmt(statistics.stdDev) : '—';

    badge78.className = 'wd-badge wd-badge--ok';
    badge78.textContent = `Basin ${basinId}`;

    // Add clipped DEM to map
    await addClippedLayer(app, currentDem, clippedElevation);

    // Wire downloads
    dlClippedDem.disabled = false;
    dlClippedDem.onclick = () => {
      const buf = writeFloat32GeoTIFF(
        currentDem!.width,
        currentDem!.height,
        clippedElevation,
        currentDem!.geotransform,
        currentDem!.crsCode,
      );
      downloadBlob(new Blob([buf], { type: 'image/tiff' }), `clipped-basin-${basinId}.tif`);
    };

    dlStats.disabled = false;
    dlStats.onclick = () => downloadCsv(statistics, `statistics-basin-${basinId}.csv`);
  };

  clipBtn.addEventListener('click', runClipAndStats);

  basinIdInput.addEventListener('change', () => {
    clipBtn.disabled =
      !delineationResult || isNaN(parseInt(basinIdInput.value, 10));
  });

  // Enable clip button when results are available (watched from runBtn handler above)
  const origRunClick = runBtn.onclick;
  void origRunClick; // accessed via event listener, not overwritten

  sec78.append(
    makeRow('Target Basin ID', basinIdInput),
    el('div', { className: 'wd-btn-row' }, [clipBtn]),
    statsGrid,
    dlStatsRow,
  );
  panel.appendChild(sec78);

  // =========================================================================
  // Map click → basin selection
  // =========================================================================
  // GeoLibreAppAPI.getMap is not in our minimal typed interface; access it
  // safely at runtime without relying on TypeScript knowing the method.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mapAny = (app as any).getMap?.() as
    | { on(event: string, layer: string, handler: (e: unknown) => void): void }
    | null
    | undefined;

  if (mapAny) {
    mapAny.on(
      'click',
      'Watershed Basins',
      (e: unknown) => {
        const ev = e as { features?: { properties: Record<string, unknown> }[] };
        if (!ev.features?.length) return;
        const bid = ev.features[0].properties['basinId'];
        if (bid == null) return;
        basinIdInput.value = String(bid);
        clipBtn.disabled = !delineationResult;
        if (delineationResult) {
          void runClipAndStats();
        }
      },
    );
  }
}

// ---------------------------------------------------------------------------
// Map layer helpers
// ---------------------------------------------------------------------------

async function addResultLayers<TControl extends GeoLibreControl>(
  app: GeoLibreAppAPI<TControl>,
  dem: DemData,
  result: DelineationResult,
): Promise<void> {
  // --- Sink-filled DEM ---
  const sinkFilledUrl = URL.createObjectURL(
    writeFloat32GeoTIFFBlob(
      dem.width,
      dem.height,
      result.filledElevation,
      dem.geotransform,
      dem.crsCode,
    ),
  );
  createdObjectUrls.push(sinkFilledUrl);
  await app.addCogLayer?.('Sink-filled DEM', sinkFilledUrl, {
    colormap: 'terrain',
    nodata: dem.noDataValue,
  });

  // --- Flow Accumulation ---
  // Log-scale the accumulation values for better visual contrast
  const logAcc = new Float32Array(result.flowAccumulation.length);
  let maxAcc = 0;
  for (let i = 0; i < result.flowAccumulation.length; i++) {
    logAcc[i] = Math.log1p(result.flowAccumulation[i]);
    if (logAcc[i] > maxAcc) maxAcc = logAcc[i];
  }

  const accumUrl = URL.createObjectURL(
    writeFloat32GeoTIFFBlob(dem.width, dem.height, logAcc, dem.geotransform, dem.crsCode),
  );
  createdObjectUrls.push(accumUrl);
  await app.addCogLayer?.('Flow Accumulation', accumUrl, {
    colormap: 'blues',
    rescaleMin: 0,
    rescaleMax: maxAcc,
    nodata: dem.noDataValue,
  });

  // --- Basin raster (Int32 → reuse Float32 slot via reinterpretation) ---
  // Convert basin IDs to Float32 for the COG layer
  const basinFloat = new Float32Array(result.basinIdArray.length);
  let maxBasinId = 0;
  for (let i = 0; i < result.basinIdArray.length; i++) {
    basinFloat[i] = result.basinIdArray[i];
    if (result.basinIdArray[i] > maxBasinId) maxBasinId = result.basinIdArray[i];
  }
  const basinRasterUrl = URL.createObjectURL(
    writeFloat32GeoTIFFBlob(
      dem.width,
      dem.height,
      basinFloat,
      dem.geotransform,
      dem.crsCode,
    ),
  );
  createdObjectUrls.push(basinRasterUrl);
  await app.addCogLayer?.('Subbasins (Raster)', basinRasterUrl, {
    colormap: 'rainbow',
    rescaleMin: 0,
    rescaleMax: maxBasinId,
    nodata: 0,
  });

  // --- Channel network (GeoJSON) ---
  app.addGeoJsonLayer('Channel Network', result.channelNetwork as GeoJSON.FeatureCollection);

  // --- Watershed basin polygons (GeoJSON) ---
  app.addGeoJsonLayer('Watershed Basins', result.basinPolygons as GeoJSON.FeatureCollection);
}

async function addClippedLayer<TControl extends GeoLibreControl>(
  app: GeoLibreAppAPI<TControl>,
  dem: DemData,
  clippedElevation: Float32Array,
): Promise<void> {
  const clippedUrl = URL.createObjectURL(
    writeFloat32GeoTIFFBlob(
      dem.width,
      dem.height,
      clippedElevation,
      dem.geotransform,
      dem.crsCode,
    ),
  );
  createdObjectUrls.push(clippedUrl);
  await app.addCogLayer?.('Clipped Basin DEM', clippedUrl, {
    colormap: 'terrain',
    nodata: dem.noDataValue,
  });
}

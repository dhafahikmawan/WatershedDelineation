/**
 * Web Worker for the watershed delineation pipeline (Steps 2–6).
 *
 * This module runs inside a dedicated Worker thread so that the heavy spatial
 * computations do not block the main UI thread.  Communication protocol:
 *
 * INCOMING (from main thread):
 *   { type: 'RUN_DELINEATION', payload: DelineationPayload }
 *
 * OUTGOING (to main thread):
 *   { type: 'PROGRESS', step: number, msg: string }        — progress updates
 *   { type: 'COMPLETE', payload: DelineationResult }       — transferable result
 *   { type: 'ERROR',    error: string }                    — on any exception
 *
 * Result arrays are sent using the Transferable mechanism so that the worker
 * hands ownership of the underlying ArrayBuffers to the main thread without
 * copying them.
 */

import {
  sinkFill,
  computeD8AndAccumulation,
  extractChannels,
  delineateBasins,
  vectorizeBasins,
} from './algorithms';

/** Data the main thread sends to start the pipeline. */
interface DelineationPayload {
  width: number;
  height: number;
  elevation: Float32Array;
  noDataValue: number;
  geotransform: [number, number, number, number, number, number];
  crsCode: number;
  zLimit: number;
  threshold: number;
}

self.onmessage = async (e: MessageEvent) => {
  const { type, payload } = e.data as { type: string; payload: DelineationPayload };
  if (type !== 'RUN_DELINEATION') return;

  const {
    width,
    height,
    elevation,
    noDataValue,
    geotransform,
    zLimit,
    threshold,
  } = payload;

  try {
    // -----------------------------------------------------------------------
    // Step 2: Sink-fill
    // -----------------------------------------------------------------------
    self.postMessage({ type: 'PROGRESS', step: 2, msg: 'Sink-filling DEM…' });
    const filledElevation = sinkFill(
      width,
      height,
      elevation,
      noDataValue,
      isFinite(zLimit) ? zLimit : Infinity,
    );

    // -----------------------------------------------------------------------
    // Step 3: D8 flow direction and flow accumulation
    // -----------------------------------------------------------------------
    self.postMessage({
      type: 'PROGRESS',
      step: 3,
      msg: 'Calculating flow direction and accumulation…',
    });
    const { flowDirection, flowAccumulation } = computeD8AndAccumulation(
      width,
      height,
      filledElevation,
      noDataValue,
    );

    // -----------------------------------------------------------------------
    // Step 4: Channel network extraction
    // -----------------------------------------------------------------------
    self.postMessage({
      type: 'PROGRESS',
      step: 4,
      msg: 'Extracting channel network…',
    });
    const { channelNetwork, junctionPoints } = extractChannels(
      width,
      height,
      flowDirection,
      flowAccumulation,
      threshold,
      geotransform,
    );

    // -----------------------------------------------------------------------
    // Step 5: Basin delineation
    // -----------------------------------------------------------------------
    self.postMessage({
      type: 'PROGRESS',
      step: 5,
      msg: `Delineating ${junctionPoints.features.length} subbasin(s)…`,
    });
    const basinIdArray = delineateBasins(
      width,
      height,
      flowDirection,
      junctionPoints.features,
    );

    // -----------------------------------------------------------------------
    // Step 6: Vectorise basins
    // -----------------------------------------------------------------------
    self.postMessage({
      type: 'PROGRESS',
      step: 6,
      msg: 'Vectorising basin outlines…',
    });
    const basinPolygons = vectorizeBasins(width, height, basinIdArray, geotransform);

    // -----------------------------------------------------------------------
    // Send results back — use Transferable to avoid copying large buffers
    // -----------------------------------------------------------------------
    (self as unknown as Worker).postMessage(
      {
        type: 'COMPLETE',
        payload: {
          filledElevation,
          flowDirection,
          flowAccumulation,
          channelNetwork,
          junctionPoints,
          basinIdArray,
          basinPolygons,
        },
      },
      [
        filledElevation.buffer,
        flowDirection.buffer,
        flowAccumulation.buffer,
        basinIdArray.buffer,
      ],
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    self.postMessage({ type: 'ERROR', error: message });
  }
};

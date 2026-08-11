/**
 * Main-thread coordinator for the watershed delineation pipeline.
 *
 * This module is the single point of contact between the UI and the Web Worker.
 * It:
 *   - Spins up (and caches) the worker on first use.
 *   - Sends the `RUN_DELINEATION` message with properly typed arrays.
 *   - Forwards progress callbacks to the caller.
 *   - Returns a typed result object when the pipeline completes.
 *   - Terminates the worker and throws on errors.
 */

import DelineationWorker from './delineation.worker?worker&inline';

export interface DemData {
  width: number;
  height: number;
  elevation: Float32Array;
  noDataValue: number;
  geotransform: [number, number, number, number, number, number];
  crsCode: number;
}

export interface DelineationParams {
  zLimit: number;
  threshold: number;
}

export interface DelineationResult {
  filledElevation: Float32Array;
  flowDirection: Uint8Array;
  flowAccumulation: Float32Array;
  channelNetwork: GeoJSON.FeatureCollection;
  junctionPoints: GeoJSON.FeatureCollection;
  basinIdArray: Int32Array;
  basinPolygons: GeoJSON.FeatureCollection;
}

export type ProgressCallback = (step: number, msg: string) => void;

let _worker: Worker | null = null;

/** Lazily create the delineation web worker. */
function getWorker(): Worker {
  if (!_worker) {
    _worker = new DelineationWorker();
  }
  return _worker;
}

/** Terminate and discard the cached worker (called on plugin deactivation). */
export function terminateWorker(): void {
  _worker?.terminate();
  _worker = null;
}

/**
 * Run the full watershed delineation pipeline in a Web Worker.
 *
 * @param dem      Input DEM metadata and elevation array.
 * @param params   Analysis parameters (zLimit, accumulation threshold).
 * @param onProgress  Optional callback invoked on each pipeline step.
 * @returns        A promise that resolves with the complete delineation result.
 */
export function runDelineation(
  dem: DemData,
  params: DelineationParams,
  onProgress?: ProgressCallback,
): Promise<DelineationResult> {
  return new Promise<DelineationResult>((resolve, reject) => {
    const worker = getWorker();

    worker.onmessage = (e: MessageEvent) => {
      const { type, step, msg, payload, error } = e.data;
      if (type === 'PROGRESS') {
        onProgress?.(step as number, msg as string);
      } else if (type === 'COMPLETE') {
        // Detach the message handler so next run gets a fresh one
        worker.onmessage = null;
        worker.onerror = null;
        resolve(payload as DelineationResult);
      } else if (type === 'ERROR') {
        worker.onmessage = null;
        worker.onerror = null;
        // Terminate so next call gets a fresh worker
        terminateWorker();
        reject(new Error(error as string));
      }
    };

    worker.onerror = (e: ErrorEvent) => {
      worker.onmessage = null;
      worker.onerror = null;
      terminateWorker();
      reject(new Error(`Worker error: ${e.message}`));
    };

    worker.postMessage({
      type: 'RUN_DELINEATION',
      payload: {
        width: dem.width,
        height: dem.height,
        elevation: dem.elevation,
        noDataValue: dem.noDataValue,
        geotransform: dem.geotransform,
        crsCode: dem.crsCode,
        zLimit: params.zLimit,
        threshold: params.threshold,
      },
    });
  });
}

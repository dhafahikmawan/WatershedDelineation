/**
 * GeoLibre plugin entry point for the Watershed Delineation plugin.
 *
 * This file is the bridge between the GeoLibre host application and the plugin's
 * internal modules.  It:
 *   - Exports the `plugin` object that GeoLibre loads from the bundle.
 *   - Wires the GeoLibre host-API capabilities (addCogLayer, addGeoJsonLayer,
 *     registerRightPanel, getMap, …) to the right-sidebar panel UI.
 *   - Handles lifecycle: activate → register panel, deactivate → close panel.
 *   - Persists the panel's collapsed/expanded state across project saves via
 *     getProjectState / applyProjectState.
 */

import type {
  GeoLibreAppAPI,
  GeoLibreMapControlPosition,
  GeoLibrePlugin,
} from './lib/geolibre/host-api';
import {
  RIGHT_PANEL_ID,
  registerWatershedRightPanel,
} from './lib/geolibre/right-panel';
import { terminateWorker } from './lib/delineation/index';
import './lib/styles/plugin-control.css';

// Minimal state to persist between activate / deactivate cycles
interface PluginState {
  panelOpen: boolean;
}

let position: GeoLibreMapControlPosition = 'top-right';
let savedState: PluginState = { panelOpen: true };
let disposeRightPanel: (() => void) | null = null;

export const plugin: GeoLibrePlugin = {
  id: 'watershed-delineation',
  name: 'Watershed Delineation',
  version: '0.1.0',

  activate(app: GeoLibreAppAPI) {
    // Register the right-panel workbench UI
    disposeRightPanel = registerWatershedRightPanel(app);

    // Restore open/collapsed state
    if (disposeRightPanel && savedState.panelOpen) {
      app.openRightPanel?.(RIGHT_PANEL_ID);
    }
  },

  deactivate(app: GeoLibreAppAPI) {
    // Capture panel state before tearing down
    const activePanel = app.getActiveRightPanel?.();
    savedState.panelOpen = activePanel === RIGHT_PANEL_ID;

    disposeRightPanel?.();
    disposeRightPanel = null;

    // Terminate the delineation web worker if it is still running
    terminateWorker();
  },

  getMapControlPosition() {
    return position;
  },

  setMapControlPosition(_app, nextPosition) {
    position = nextPosition;
  },

  getProjectState() {
    return savedState;
  },

  applyProjectState(_app, state) {
    if (
      state &&
      typeof state === 'object' &&
      !Array.isArray(state) &&
      'panelOpen' in (state as object)
    ) {
      savedState = state as PluginState;
    }
  },
};

export default plugin;

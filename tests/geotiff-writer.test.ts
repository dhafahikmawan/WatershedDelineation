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

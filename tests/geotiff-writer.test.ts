import { describe, it, expect } from 'vitest';
import { fromArrayBuffer } from 'geotiff';
import { writeFloat32GeoTIFF } from '../src/lib/utils/geotiff-writer';

describe('writeFloat32GeoTIFF (tiled)', () => {
  it('should generate a valid tiled GeoTIFF for a small image (fits in one tile)', async () => {
    const width = 4;
    const height = 4;
    const data = new Float32Array(width * height).fill(10.5);
    const geotransform: [number, number, number, number, number, number] = [0, 1, 0, 0, 0, -1];
    const buffer = writeFloat32GeoTIFF(width, height, data, geotransform, 3857);

    const tiff = await fromArrayBuffer(buffer);
    const image = await tiff.getImage();

    expect(image.getWidth()).toBe(width);
    expect(image.getHeight()).toBe(height);
    expect(image.getSamplesPerPixel()).toBe(1);
    expect(image.isTiled).toBe(true);
    expect(image.getTileWidth()).toBe(256);
    expect(image.getTileHeight()).toBe(256);

    const rasters = await image.readRasters();
    const rasterData = rasters[0] as Float32Array;
    expect(rasterData).toHaveLength(width * height);
    expect(rasterData[0]).toBeCloseTo(10.5);
  });

  it('should generate a valid tiled GeoTIFF for an image larger than one tile', async () => {
    const width = 300; // wider than 256 → 2 tiles across
    const height = 300; // taller than 256 → 2 tiles down  (4 tiles total)
    const data = new Float32Array(width * height);
    for (let i = 0; i < data.length; i++) {
      data[i] = i % 100;
    }
    const geotransform: [number, number, number, number, number, number] = [100, 0.5, 0, 50, 0, -0.5];
    const buffer = writeFloat32GeoTIFF(width, height, data, geotransform, 3857);

    const tiff = await fromArrayBuffer(buffer);
    const image = await tiff.getImage();

    expect(image.getWidth()).toBe(width);
    expect(image.getHeight()).toBe(height);
    expect(image.getSamplesPerPixel()).toBe(1);
    expect(image.isTiled).toBe(true);
    expect(image.getTileWidth()).toBe(256);
    expect(image.getTileHeight()).toBe(256);

    const rasters = await image.readRasters();
    const rasterData = rasters[0] as Float32Array;
    expect(rasterData).toHaveLength(width * height);

    // Spot-check: pixel at (0,0)
    expect(rasterData[0]).toBeCloseTo(0);
    // Spot-check: pixel at (1,0)
    expect(rasterData[1]).toBeCloseTo(1);
    // Spot-check: pixel at (0,1) — second row
    expect(rasterData[width]).toBeCloseTo(width % 100);
    // Spot-check: pixel in upper-right region (crosses tile boundary at x=256)
    const x = 257, y = 0;
    expect(rasterData[y * width + x]).toBeCloseTo((y * width + x) % 100);
    // Spot-check: pixel in lower-left region (crosses tile boundary at y=256)
    const x2 = 0, y2 = 257;
    expect(rasterData[y2 * width + x2]).toBeCloseTo((y2 * width + x2) % 100);
  });

  it('should produce a valid GeoTIFF for a geographic CRS (EPSG:4326)', async () => {
    const width = 10;
    const height = 10;
    const data = new Float32Array(width * height).fill(5.0);
    const geotransform: [number, number, number, number, number, number] = [10, 0.01, 0, 20, 0, -0.01];
    const buffer = writeFloat32GeoTIFF(width, height, data, geotransform, 4326);

    const tiff = await fromArrayBuffer(buffer);
    const image = await tiff.getImage();

    expect(image.getWidth()).toBe(width);
    expect(image.getHeight()).toBe(height);
    expect(image.isTiled).toBe(true);

    const rasters = await image.readRasters();
    const rasterData = rasters[0] as Float32Array;
    expect(rasterData[0]).toBeCloseTo(5.0);
  });
});

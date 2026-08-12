/**
 * Encodes a Float32Array into a tiled, uncompressed Float32 GeoTIFF blob.
 *
 * Since geotiff.js does not natively support writing Float32 data, this module
 * constructs the full TIFF binary structure manually from spec:
 *   - Little-endian byte order ('II')
 *   - TIFF magic number 42
 *   - IFD tags for width, height, bits-per-sample, compression, tile layout,
 *     sample format, ModelPixelScale, ModelTiepoint, and GeoKeyDirectory
 *
 * The resulting ArrayBuffer is a valid tiled GeoTIFF that can be opened in QGIS/GDAL
 * and consumed by geotiff.js / GeoLibre's addCogLayer.
 */
export function writeFloat32GeoTIFF(
  width: number,
  height: number,
  data: Float32Array,
  geotransform: [number, number, number, number, number, number],
  crsCode: number = 3857,
): ArrayBuffer {
  const isGeographic = crsCode === 4326;
  // GeographicTypeGeoKey (2048) for geographic CRS, ProjectedCSTypeGeoKey (3072) for projected
  const crsKey = isGeographic ? 2048 : 3072;

  // -----------------------------------------------------------------------
  // Tile dimensions — must be multiples of 16 per the TIFF spec.
  // 256×256 is the standard choice for Cloud Optimized GeoTIFFs.
  // -----------------------------------------------------------------------
  const TILE_W = 256;
  const TILE_H = 256;
  const tilesAcross = Math.ceil(width / TILE_W);
  const tilesDown = Math.ceil(height / TILE_H);
  const numTiles = tilesAcross * tilesDown;

  // -----------------------------------------------------------------------
  // Memory layout (all offsets aligned to 8-byte boundaries):
  //   0       - TIFF header (8 bytes)
  //   8       - IFD: 2-byte count + 14 entries × 12 bytes + 4-byte next-IFD = 174 bytes  → ends at 181
  //   184     - ModelPixelScale data  (3 × float64 = 24 bytes)
  //   208     - ModelTiepoint data    (6 × float64 = 48 bytes)
  //   256     - GeoKeyDirectory       (16 × uint16 = 32 bytes)
  //   288     - TileOffsets array     (numTiles × uint32)
  //   288 + numTiles*4 - TileByteCounts array (numTiles × uint32)
  //   <next 8-byte boundary> - Pixel data (numTiles full 256×256 tiles, zero-padded)
  // -----------------------------------------------------------------------
  const ifdEntriesCount = 14;
  const pixelScaleOffset = 184; // manually aligned: IFD ends at 181, next 8-byte boundary = 184
  const tiepointOffset = pixelScaleOffset + 3 * 8; // 208
  const geokeysCount = 16; // 4-word header + 3 keys × 4 words each
  const geokeysOffset = tiepointOffset + 6 * 8; // 256
  const tileOffsetsOffset = geokeysOffset + geokeysCount * 2; // 288
  const tileByteCountsOffset = tileOffsetsOffset + numTiles * 4;
  // Align pixel data start to next 8-byte boundary
  const pixelDataOffset = Math.ceil((tileByteCountsOffset + numTiles * 4) / 8) * 8;

  // Each tile is always a full TILE_W × TILE_H block (zero-padded at edges).
  const singleTileBytes = TILE_W * TILE_H * 4; // Float32 = 4 bytes per sample
  const totalSize = pixelDataOffset + numTiles * singleTileBytes;
  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);

  // -----------------------------------------------------------------------
  // 1. TIFF header
  // -----------------------------------------------------------------------
  view.setUint8(0, 0x49); // 'I'  (little-endian byte order mark)
  view.setUint8(1, 0x49); // 'I'
  view.setUint16(2, 42, true); // TIFF magic
  view.setUint32(4, 8, true); // Offset to first IFD

  // -----------------------------------------------------------------------
  // 2. Image File Directory (IFD)
  // -----------------------------------------------------------------------
  let offset = 8;
  view.setUint16(offset, ifdEntriesCount, true);
  offset += 2;

  /**
   * Write one 12-byte IFD entry.
   * @param tag        TIFF tag code
   * @param type       TIFF data type (3 = SHORT, 4 = LONG, 12 = DOUBLE)
   * @param count      Number of values
   * @param valOrOffset  The value itself (when it fits in 4 bytes) or an offset
   */
  const writeTag = (
    tag: number,
    type: number,
    count: number,
    valOrOffset: number,
  ): void => {
    view.setUint16(offset, tag, true);
    view.setUint16(offset + 2, type, true);
    view.setUint32(offset + 4, count, true);
    view.setUint32(offset + 8, valOrOffset, true);
    offset += 12;
  };

  // Tags must be written in ascending tag-ID order per the TIFF specification.
  writeTag(256, 4, 1, width);                       // ImageWidth            (LONG)
  writeTag(257, 4, 1, height);                      // ImageLength           (LONG)
  writeTag(258, 3, 1, 32);                          // BitsPerSample = 32    (SHORT)
  writeTag(259, 3, 1, 1);                           // Compression = None    (SHORT)
  writeTag(262, 3, 1, 1);                           // PhotometricInterpretation = BlackIsZero  (SHORT)
  writeTag(277, 3, 1, 1);                           // SamplesPerPixel = 1   (SHORT)
  writeTag(322, 4, 1, TILE_W);                      // TileWidth             (LONG)
  writeTag(323, 4, 1, TILE_H);                      // TileLength            (LONG)
  writeTag(324, 4, numTiles, numTiles === 1 ? pixelDataOffset : tileOffsetsOffset);    // TileOffsets           (LONG[numTiles])
  writeTag(325, 4, numTiles, numTiles === 1 ? singleTileBytes : tileByteCountsOffset); // TileByteCounts        (LONG[numTiles])
  writeTag(339, 3, 1, 3);                           // SampleFormat = 3 (IEEE floating point)  (SHORT)
  writeTag(33550, 12, 3, pixelScaleOffset);         // ModelPixelScaleTag    (DOUBLE[3])
  writeTag(33922, 12, 6, tiepointOffset);           // ModelTiepointTag      (DOUBLE[6])
  writeTag(34735, 3, geokeysCount, geokeysOffset);  // GeoKeyDirectoryTag    (SHORT[16])

  view.setUint32(offset, 0, true); // Next IFD offset = 0 (no more IFDs)

  // -----------------------------------------------------------------------
  // 3. ModelPixelScale — pixel size in map units (3 doubles: scaleX, scaleY, scaleZ)
  // -----------------------------------------------------------------------
  view.setFloat64(pixelScaleOffset, geotransform[1], true);
  view.setFloat64(pixelScaleOffset + 8, Math.abs(geotransform[5]), true); // always positive
  view.setFloat64(pixelScaleOffset + 16, 0.0, true);

  // -----------------------------------------------------------------------
  // 4. ModelTiepoint — maps one pixel to map coordinates (6 doubles per point)
  //    format: [pixelI, pixelJ, pixelK,  mapX, mapY, mapZ]
  // -----------------------------------------------------------------------
  view.setFloat64(tiepointOffset, 0.0, true);           // pixelI = 0
  view.setFloat64(tiepointOffset + 8, 0.0, true);       // pixelJ = 0
  view.setFloat64(tiepointOffset + 16, 0.0, true);      // pixelK = 0
  view.setFloat64(tiepointOffset + 24, geotransform[0], true); // mapX = top-left X
  view.setFloat64(tiepointOffset + 32, geotransform[3], true); // mapY = top-left Y
  view.setFloat64(tiepointOffset + 40, 0.0, true);      // mapZ = 0

  // -----------------------------------------------------------------------
  // 5. GeoKeyDirectory — 16 × uint16 words
  //    Header (4 words): DirectoryVersion=1, Revision=1, MinorRevision=0, NumberOfKeys=3
  //    Each key entry is 4 words: KeyID, TIFFTagLocation, Count, Value_Offset
  // -----------------------------------------------------------------------
  let kOffset = geokeysOffset;
  view.setUint16(kOffset, 1, true);     // DirectoryVersion
  view.setUint16(kOffset + 2, 1, true); // Revision
  view.setUint16(kOffset + 4, 0, true); // MinorRevision
  view.setUint16(kOffset + 6, 3, true); // NumberOfKeys = 3
  kOffset += 8;

  // GTModelTypeGeoKey (1024): 1 = Projected, 2 = Geographic
  view.setUint16(kOffset, 1024, true);
  view.setUint16(kOffset + 2, 0, true);
  view.setUint16(kOffset + 4, 1, true);
  view.setUint16(kOffset + 6, isGeographic ? 2 : 1, true);
  kOffset += 8;

  // GTRasterTypeGeoKey (1025): 1 = RasterPixelIsArea
  view.setUint16(kOffset, 1025, true);
  view.setUint16(kOffset + 2, 0, true);
  view.setUint16(kOffset + 4, 1, true);
  view.setUint16(kOffset + 6, 1, true);
  kOffset += 8;

  // CRS code key: GeographicTypeGeoKey (2048) or ProjectedCSTypeGeoKey (3072)
  view.setUint16(kOffset, crsKey, true);
  view.setUint16(kOffset + 2, 0, true);
  view.setUint16(kOffset + 4, 1, true);
  view.setUint16(kOffset + 6, crsCode, true);

  // -----------------------------------------------------------------------
  // 6. TileOffsets & TileByteCounts arrays
  //    Each tile occupies exactly TILE_W × TILE_H × 4 bytes (uncompressed, zero-padded).
  //    Per the TIFF spec, TileByteCounts must equal the full padded tile size even for
  //    edge tiles when compression is None (1).
  // -----------------------------------------------------------------------
  for (let i = 0; i < numTiles; i++) {
    view.setUint32(tileOffsetsOffset + i * 4, pixelDataOffset + i * singleTileBytes, true);
    view.setUint32(tileByteCountsOffset + i * 4, singleTileBytes, true);
  }

  // -----------------------------------------------------------------------
  // 7. Pixel data — re-order from row-major (scanline) to tile-major layout.
  //    Partial edge tiles are zero-padded to a full TILE_W × TILE_H block.
  // -----------------------------------------------------------------------
  const pixelFloatView = new Float32Array(buffer, pixelDataOffset, numTiles * TILE_W * TILE_H);
  let destIdx = 0;
  for (let ty = 0; ty < tilesDown; ty++) {
    for (let tx = 0; tx < tilesAcross; tx++) {
      for (let y = 0; y < TILE_H; y++) {
        const imgY = ty * TILE_H + y;
        for (let x = 0; x < TILE_W; x++) {
          const imgX = tx * TILE_W + x;
          if (imgX < width && imgY < height) {
            pixelFloatView[destIdx] = data[imgY * width + imgX];
          } else {
            pixelFloatView[destIdx] = 0.0; // zero-pad partial edge tiles
          }
          destIdx++;
        }
      }
    }
  }

  return buffer;
}

/**
 * Convenience: creates a Blob from the encoded GeoTIFF ArrayBuffer.
 */
export function writeFloat32GeoTIFFBlob(
  width: number,
  height: number,
  data: Float32Array,
  geotransform: [number, number, number, number, number, number],
  crsCode: number = 3857,
): Blob {
  const buffer = writeFloat32GeoTIFF(width, height, data, geotransform, crsCode);
  return new Blob([buffer], { type: 'image/tiff' });
}

/**
 * Convenience: creates an object URL from the encoded GeoTIFF that can be
 * passed to addCogLayer or used as an <a href> for file download.
 * Remember to call URL.revokeObjectURL() when the URL is no longer needed.
 */
export function writeFloat32GeoTIFFUrl(
  width: number,
  height: number,
  data: Float32Array,
  geotransform: [number, number, number, number, number, number],
  crsCode: number = 3857,
): string {
  return URL.createObjectURL(
    writeFloat32GeoTIFFBlob(width, height, data, geotransform, crsCode),
  );
}

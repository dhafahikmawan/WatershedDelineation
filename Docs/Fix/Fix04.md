### Fix and Update List 04

### Problems
1. It seems that all the result coordinates is all over the place (e.g., Sink-filled DEM doesn't appear where it should). It appears that they might render in `0,0` instead, but I might be wrong. Make sure that the results keep the source coordinate/crs.

### Update
1. Make it so that the plugin also loads the source/user uploaded raster before everything else

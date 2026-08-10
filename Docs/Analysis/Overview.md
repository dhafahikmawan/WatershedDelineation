### Description

This GeoLibre plugin is going to process watershed delineation from a DEM.


### General Steps
1. Load the DEM
2. Preprocessing: Sink-fill the DEM
3. Calculate Catchment Area
4. Extract Channel Network from the catchment area layer
5. Delineate watersheds, use the channel network junctions as the outlet points
6. Vectorize the basins into polygons
7. Clip DEM by the subbasin polygon
8. Compute statistics to get elevation metrcis such as (min, max, mean, standard deviation)


### Note
- Make sure that the result of each step 2-7 is downloadable by the user
- Make sure that the result of each step 2-7 is shown in GeoLibre using the appropriate plugin api (addGeoJsonLayer for vector, addCogLayer for raster. Refer to /plugin-api.md for reference).
- Make sure the analysis documents also specify the user input ot result output of each step (example: input: DEM raster, Z-limit, output: Sink-filled DEM raster)
- Make sure that there is a size limit of the input DEM that the plugin will handle as a developer controlled variable.
import { getCapRaster, type RasterOptions } from "./keycap3d.raster";

const scope = globalThis as unknown as {
  onmessage:
    | ((event: MessageEvent<{ id: number; options: RasterOptions }>) => void)
    | null;
  postMessage: (message: {
    id: number;
    image?: ImageData;
    error?: string;
  }) => void;
};

scope.onmessage = ({ data }) => {
  try {
    // Structured cloning keeps the cached ImageData usable for later requests.
    scope.postMessage({ id: data.id, image: getCapRaster(data.options) });
  } catch (error) {
    scope.postMessage({ id: data.id, error: String(error) });
  }
};

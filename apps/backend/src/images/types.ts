import { imageUploadLimits } from "@kuinest/contracts";
export const imageLimits = Object.freeze({ bytes: imageUploadLimits.maxBytesPerImage, perMessage: imageUploadLimits.maxImagesPerMessage, messageBytes: imageUploadLimits.maxBytesPerMessage, pixels: imageUploadLimits.maxPixels, edge: imageUploadLimits.maxEdge });
export type ImageMime = "image/png" | "image/jpeg";
export type ImageInspection = Readonly<{ mimeType: ImageMime; width: number; height: number; bytes: number; sha256: string; decoder: "sharp-0.35.4" }>;
export type ImageCode = "IMAGE_INVALID" | "IMAGE_TOO_LARGE" | "IMAGE_UNSUPPORTED" | "IMAGE_TIMEOUT" | "IMAGE_BUSY" | "IMAGE_UNAVAILABLE" | "IMAGE_STORAGE_FULL";
export class ImageFailure extends Error { constructor(readonly code: ImageCode) { super(code); this.name = "ImageFailure"; } }
export const imageHashPattern = /^[0-9a-f]{64}$/;

"""
Pixlixir panorama engine (runs inside Pyodide, in a Web Worker or in Node for tests).

A thin driver over OpenStitching (Apache-2.0, https://github.com/OpenStitching/stitching),
which itself drives OpenCV's stitching pipeline (Brown & Lowe: features -> matching ->
camera estimation -> bundle adjustment -> wave correction -> warping -> exposure
compensation -> seam finding -> multi-band blending). We only add:

- FastCropper: the largest-interior-rectangle search on a downscaled mask (the library's
  numba-accelerated search runs as plain Python here and is ~20x slower otherwise);
- stage progress reporting;
- an optional edge fill (OpenCV inpainting) instead of cropping, with the filled area
  reported so the UI can mark it as made-up content;
- output sizing (preview / bounded full resolution) and JPEG encoding;
- OverlapGrouper: finds which photos of a burst-free sequence overlap into panoramas
  (OpenStitching's feature detector + matcher, OpenCV homographies), for library scans;
- ExifWriter: the saved panorama inherits the earliest photo's EXIF (Pillow), with the
  capture time and location Google Photos shows for it.

Errors are never swallowed: library StitchingErrors become a structured "error" result
with a stable code; anything else propagates to the caller.
"""

import io
import math
import time
import warnings
from datetime import datetime, timedelta, timezone

import cv2 as cv
import numpy as np
from PIL import ExifTags, Image, TiffImagePlugin
from stitching import AffineStitcher, Stitcher
from stitching.cropper import Cropper, Rectangle
from stitching.feature_detector import FeatureDetector
from stitching.feature_matcher import FeatureMatcher
from stitching.stitching_error import StitchingError, StitchingWarning


def _as_bytes(value):
    """Bytes from a Python buffer or a Pyodide JS typed-array proxy."""
    to_bytes = getattr(value, "to_bytes", None)
    return to_bytes() if to_bytes else bytes(value)


class FastCropper(Cropper):
    """Cropper whose largest-interior-rectangle search runs on a downscaled mask."""

    MAX_SIDE = 400

    def estimate_largest_interior_rectangle(self, mask):
        # Paragraph: small masks go straight to the library.
        h, w = mask.shape[:2]
        factor = max(w, h) / self.MAX_SIDE
        if factor <= 1:
            return super().estimate_largest_interior_rectangle(mask)

        # Paragraph: keep only fully covered cells, and only the biggest region (the library needs one contour).
        sw, sh = max(2, int(w / factor)), max(2, int(h / factor))
        small = cv.resize(mask, (sw, sh), interpolation=cv.INTER_AREA)
        small = np.where(small >= 255, 255, 0).astype(np.uint8)
        count, labels, stats, _ = cv.connectedComponentsWithStats(small)
        if count > 2:
            keep = 1 + int(np.argmax(stats[1:, cv.CC_STAT_AREA]))
            small = np.where(labels == keep, 255, 0).astype(np.uint8)

        # Paragraph: scale back, rounding inwards so the rectangle never includes empty pixels.
        r = super().estimate_largest_interior_rectangle(small)
        fx, fy = w / sw, h / sh
        x1, y1 = math.ceil(r.x * fx), math.ceil(r.y * fy)
        x2, y2 = math.floor(r.x2 * fx), math.floor(r.y2 * fy)
        if x2 - x1 < 2 or y2 - y1 < 2:
            raise StitchingError("The stitched photos leave no rectangular area to crop to.")
        return Rectangle(x1, y1, x2 - x1, y2 - y1)


class _Reporting:
    """Mixin: reports pipeline stages, swaps in FastCropper and keeps the coverage mask."""

    STAGES = {
        "find_features": "Finding features",
        "match_features": "Matching photos",
        "estimate_camera_parameters": "Estimating camera positions",
        "refine_camera_parameters": "Refining alignment",
        "warp_low_resolution": "Projecting",
        "find_seam_masks": "Finding seams",
        "warp_final_resolution": "Warping full image",
        "blend_images": "Blending",
    }

    def __init__(self, progress, **kwargs):
        self.progress = progress
        super().__init__(**kwargs)

    def initialize_stitcher(self, **kwargs):
        super().initialize_stitcher(**kwargs)
        self.cropper = FastCropper(self.settings["crop"])
        self.result_mask = None

    def create_final_panorama(self):
        panorama, mask = self.blender.blend()
        self.result_mask = mask
        return panorama


def _staged(name, label):
    """Wraps one library pipeline stage so it reports progress before running."""

    def method(self, *args, **kwargs):
        self.progress(label)
        return getattr(super(_Reporting, self), name)(*args, **kwargs)

    method.__name__ = name
    return method


for _name, _label in _Reporting.STAGES.items():
    setattr(_Reporting, _name, _staged(_name, _label))


class RotatingStitcher(_Reporting, Stitcher):
    """Camera turning in place (landscapes, rooms, multi-row, 360)."""


class FlatStitcher(_Reporting, AffineStitcher):
    """Camera moving over a flat subject (posters, maps, documents, album pages)."""


class OverlapGrouper:
    """
    Which photos of a candidate sequence overlap into panoramas.

    Pairwise SIFT matching (OpenStitching / OpenCV BestOf2Nearest) gives a confidence
    and a homography per pair. A pair is *linked* when the match is confident and the
    photos overlap partially; it is a *duplicate* (burst, retake) when each photo
    covers most of the other. Duplicates collapse onto the earliest photo, and the
    connected components of linked photos are the panorama groups.
    """

    WORK_MEGAPIX = 0.25
    CONFIDENCE = 1.0
    MATCH_CONF = 0.65
    MIN_OVERLAP = 0.05
    DUPLICATE_OVERLAP = 0.8
    DUPLICATE_INLIERS = 40
    FULL_MATCH_LIMIT = 16
    RANGE_WIDTH = 8

    def groups(self, keys, imgs):
        """keys/imgs in capture order. Returns {"groups": [{"keys", "duplicates"}], "pairs": n}."""
        # Paragraph: features on small copies (detection only needs coarse geometry).
        small = [self._shrink(img) for img in imgs]
        detector = FeatureDetector("sift")
        features = [detector.detect_features(img) for img in small]

        # Paragraph: all pairs for short sequences, capture-order neighbours for long ones.
        n = len(keys)
        range_width = -1 if n <= self.FULL_MATCH_LIMIT else self.RANGE_WIDTH
        matcher = FeatureMatcher("homography", range_width=range_width, match_conf=self.MATCH_CONF)
        matrix = FeatureMatcher.get_matches_matrix(matcher.match_features(features))

        # Paragraph: classify every confident pair by how much the photos overlap.
        parent = list(range(n))
        links = []
        pairs = 0
        for i in range(n):
            for j in range(i + 1, n):
                match = matrix[i][j]
                # OpenCV zeroes the confidence of near-identical pairs (confidence > 3), so such
                # pairs are recognised by their inlier count and must turn out as duplicates below.
                near_identical = match.confidence == 0 and match.num_inliers >= self.DUPLICATE_INLIERS
                if (match.confidence < self.CONFIDENCE and not near_identical) or match.H is None or np.size(match.H) != 9:
                    continue
                pairs += 1
                overlap = self._overlap(match.H, small[i].shape, small[j].shape)
                if overlap is None or max(overlap) < self.MIN_OVERLAP:
                    continue
                if min(overlap) >= self.DUPLICATE_OVERLAP:
                    self._union(parent, j, i)
                elif not near_identical:
                    links.append((i, j))

        # Paragraph: components over duplicate-collapsed photos; keep those with 2+ distinct views.
        rep = [self._find(parent, i) for i in range(n)]
        component = list(range(n))
        for i, j in links:
            self._union(component, rep[i], rep[j])
        groups = {}
        for i in range(n):
            root = self._find(component, rep[i])
            entry = groups.setdefault(root, {"views": [], "duplicates": []})
            (entry["views"] if rep[i] == i else entry["duplicates"]).append(keys[i])
        result = [{"keys": g["views"], "duplicates": g["duplicates"]} for g in groups.values() if len(g["views"]) >= 2]
        result.sort(key=lambda g: keys.index(g["keys"][0]))
        return {"groups": result, "pairs": pairs}

    def _shrink(self, img):
        h, w = img.shape[:2]
        scale = min(1.0, math.sqrt(self.WORK_MEGAPIX * 1e6 / (w * h)))
        return img if scale >= 1.0 else cv.resize(img, (max(8, int(w * scale)), max(8, int(h * scale))), interpolation=cv.INTER_AREA)

    @staticmethod
    def _overlap(H, shape_i, shape_j):
        """(share of photo i covered by j, share of j covered by i), or None for a degenerate homography."""
        H = np.asarray(H, dtype=np.float64)
        if abs(np.linalg.det(H)) < 1e-9:
            return None
        hi, wi = shape_i[:2]
        hj, wj = shape_j[:2]
        corners_i = np.float32([[0, 0], [wi, 0], [wi, hi], [0, hi]]).reshape(-1, 1, 2)
        projected = cv.perspectiveTransform(corners_i, H)
        if not cv.isContourConvex(projected.astype(np.float32)):
            return None
        rect_j = np.float32([[0, 0], [wj, 0], [wj, hj], [0, hj]]).reshape(-1, 1, 2)
        area, _ = cv.intersectConvexConvex(projected.astype(np.float32), rect_j)
        projected_area = abs(cv.contourArea(projected.astype(np.float32)))
        if projected_area <= 0:
            return None
        # area is in j's pixels: as a share of j directly, and of i via the projection's area ratio.
        return (min(1.0, area / projected_area), min(1.0, area / float(wj * hj)))

    @staticmethod
    def _find(parent, i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    @classmethod
    def _union(cls, parent, keep, other):
        a, b = cls._find(parent, keep), cls._find(parent, other)
        if a != b:
            parent[max(a, b)] = min(a, b)  # the earliest photo stays the representative


class ExifWriter:
    """
    EXIF for a saved panorama: the earliest source photo's camera EXIF (read with Pillow),
    with orientation reset, the panorama's size, and the capture time / location that
    Google Photos shows for that photo (which may have been edited there).
    """

    MAX_APP1 = 65000
    UNIQUE_TAGS = (0x927C, 0xA420)  # MakerNote (large, camera-private), ImageUniqueID (belongs to the source)
    BULKY_TAGS = (0x9286, 0x9C9B, 0x9C9C, 0x9C9D, 0x9C9E, 0x9C9F)  # UserComment, XP* comments

    def __init__(self, metadata):
        self.metadata = metadata
        self.warnings = []

    def build(self, width, height):
        # Paragraph: start from the source's EXIF when it can be read.
        exif = Image.Exif()
        head = self.metadata.get("source_head")
        if head is not None:
            try:
                exif = Image.open(io.BytesIO(_as_bytes(head))).getexif()
            except Exception as err:  # reported, not hidden: the panorama is saved with basic EXIF only
                self.warnings.append(f"Could not read the source photo's EXIF ({type(err).__name__}); camera details were not copied.")
        sub = exif.get_ifd(ExifTags.IFD.Exif)
        for tag in self.UNIQUE_TAGS:
            sub.pop(tag, None)

        # Paragraph: this file's own facts.
        exif[ExifTags.Base.Orientation] = 1
        exif[ExifTags.Base.Software] = "Pixlixir panorama"
        sub[ExifTags.Base.ExifImageWidth] = int(width)
        sub[ExifTags.Base.ExifImageHeight] = int(height)

        # Paragraph: capture time as Google Photos shows it (local time + offset).
        taken_ms = self.metadata.get("taken_ms")
        if taken_ms is not None:
            offset_ms = int(self.metadata.get("offset_ms") or 0)
            local = datetime.fromtimestamp(taken_ms / 1000, timezone.utc) + timedelta(milliseconds=offset_ms)
            stamp = local.strftime("%Y:%m:%d %H:%M:%S")
            sign = "+" if offset_ms >= 0 else "-"
            minutes = abs(offset_ms) // 60000
            exif[ExifTags.Base.DateTime] = stamp
            sub[ExifTags.Base.DateTimeOriginal] = stamp
            sub[ExifTags.Base.DateTimeDigitized] = stamp
            sub[ExifTags.Base.OffsetTimeOriginal] = f"{sign}{minutes // 60:02d}:{minutes % 60:02d}"

        # Paragraph: location as Google Photos shows it.
        gps = self.metadata.get("gps")
        if gps is not None:
            exif[ExifTags.IFD.GPSInfo] = self._gps_ifd(float(gps[0]), float(gps[1]))

        # Paragraph: must fit in one JPEG APP1 segment.
        data = exif.tobytes()
        if len(data) > self.MAX_APP1:
            for tag in self.BULKY_TAGS:
                sub.pop(tag, None)
            exif.pop(ExifTags.Base.ImageDescription, None)
            data = exif.tobytes()
        if len(data) > self.MAX_APP1:
            raise ValueError(f"EXIF too large for a JPEG ({len(data)} bytes)")
        return data

    @staticmethod
    def _gps_ifd(lat, lng):
        def dms(value):
            value = abs(value)
            d = int(value)
            m = int((value - d) * 60)
            s = (value - d - m / 60) * 3600
            return (TiffImagePlugin.IFDRational(d, 1), TiffImagePlugin.IFDRational(m, 1), TiffImagePlugin.IFDRational(round(s * 10000), 10000))

        return {
            ExifTags.GPS.GPSVersionID: b"\x02\x02\x00\x00",
            ExifTags.GPS.GPSLatitudeRef: "N" if lat >= 0 else "S",
            ExifTags.GPS.GPSLatitude: dms(lat),
            ExifTags.GPS.GPSLongitudeRef: "E" if lng >= 0 else "W",
            ExifTags.GPS.GPSLongitude: dms(lng),
        }


class PanoramaEngine:
    PROJECTIONS = {
        "spherical": "spherical",
        "cylindrical": "cylindrical",
        "perspective": "plane",
        "panini": "paniniA1.5B1",
        "mercator": "mercator",
        "fisheye": "fisheye",
        "stereographic": "stereographic",
    }
    STRAIGHTEN = {"horizontal": "horiz", "vertical": "vert", "auto": "auto", "off": "no"}
    PREVIEW_PANO_MEGAPIX = 2.5
    REGISTRATION_MEGAPIX = 0.6

    def __init__(self, progress):
        self.progress = progress
        self.images = {}
        self._estimates = {}

    # ---- inputs ------------------------------------------------------------

    def set_image(self, key, rgba, width, height):
        """rgba: width*height*4 bytes (an ImageData buffer from JS, or any Python buffer)."""
        to_memoryview = getattr(rgba, "to_memoryview", None)  # Pyodide JsBuffer -> copy into Python memory
        data = np.frombuffer(to_memoryview() if to_memoryview else rgba, dtype=np.uint8)
        if data.size != width * height * 4:
            raise ValueError(f"image {key}: expected {width * height * 4} bytes, got {data.size}")
        self.images[key] = cv.cvtColor(data.reshape(height, width, 4), cv.COLOR_RGBA2BGR)

    def remove_image(self, key):
        self.images.pop(key, None)

    # ---- detection -----------------------------------------------------------

    def find_groups(self, keys):
        """Panorama groups among loaded photos (keys in capture order). See OverlapGrouper."""
        started = time.time()
        missing = [k for k in keys if k not in self.images]
        if missing:
            raise KeyError(f"images not loaded: {missing}")
        if len(keys) < 2:
            return {"groups": [], "pairs": 0, "seconds": 0.0}
        self.progress("Checking which photos overlap")
        result = OverlapGrouper().groups(list(keys), [self.images[k] for k in keys])
        result["seconds"] = round(time.time() - started, 2)
        return result

    # ---- stitching -----------------------------------------------------------

    def stitch(self, keys, settings):
        """
        settings: motion ("rotate"|"flat"), projection, straighten, edges ("crop"|"fill"),
        try_harder (bool), output ("preview"|"full"), max_megapix (pano cap for "full"),
        metadata (full only, optional): {source_head, taken_ms, offset_ms, gps} -> EXIF (ExifWriter).
        Returns a dict; on a stitching failure: {"error": {"code", "message"}}.
        """
        started = time.time()
        missing = [k for k in keys if k not in self.images]
        if missing:
            raise KeyError(f"images not loaded: {missing}")
        if len(keys) < 2:
            return self._error("NEED_MORE", "Select at least two overlapping photos.")
        imgs = [self.images[k] for k in keys]

        # Paragraph: choose the per-photo resolution for this render.
        estimate_key = self._estimate_key(keys, settings)
        capped = False
        if settings["output"] == "preview":
            per_image = self._preview_megapix(len(keys))
        else:
            try:
                per_image, capped = self._full_megapix(keys, imgs, settings, estimate_key)
            except StitchingError as err:
                return self._error(self._classify(str(err)), str(err))

        # Paragraph: run the library pipeline.
        stitcher = self._make_stitcher(settings, per_image)
        try:
            with warnings.catch_warnings(record=True) as caught:
                warnings.simplefilter("always", StitchingWarning)
                panorama = stitcher.stitch(imgs)
        except StitchingError as err:
            return self._error(self._classify(str(err)), str(err))
        except cv.error as err:
            return self._error("OPENCV", f"OpenCV could not stitch these photos: {str(err).strip().splitlines()[-1]}")
        used = [keys[int(name) - 1] for name in stitcher.images.names]
        dropped = [k for k in keys if k not in used]
        mask = stitcher.result_mask
        if panorama is None or panorama.size == 0:
            return self._error("EMPTY", "Stitching produced an empty image.")

        # Paragraph: remember the size at this resolution, so full renders can be sized before running.
        # Photos are only ever downscaled, so the effective size is capped by photo 1 (the library's reference).
        pano_mp = panorama.shape[0] * panorama.shape[1] / 1e6
        first_mp = imgs[0].shape[0] * imgs[0].shape[1] / 1e6
        effective = min(per_image, first_mp) if per_image > 0 else first_mp
        self._estimates[estimate_key] = (effective, pano_mp)

        # Paragraph: fill the empty edges if asked (made-up content, reported), else they were cropped.
        filled = None
        if settings["edges"] == "fill":
            panorama, filled = self._fill_edges(panorama, mask)
        filled_fraction = float(np.count_nonzero(filled)) / filled.size if filled is not None else 0.0

        # Paragraph: encode (with inherited EXIF when the caller supplies source metadata).
        quality = 85 if settings["output"] == "preview" else 92
        metadata = settings.get("metadata")
        metadata_warnings = []
        if metadata is not None and settings["output"] == "full":
            writer = ExifWriter(metadata)
            exif = writer.build(panorama.shape[1], panorama.shape[0])
            metadata_warnings = writer.warnings
            buffer = io.BytesIO()
            Image.fromarray(cv.cvtColor(panorama, cv.COLOR_BGR2RGB)).save(buffer, "JPEG", quality=quality, exif=exif)
            jpeg = np.frombuffer(buffer.getvalue(), dtype=np.uint8)
        else:
            ok, jpeg = cv.imencode(".jpg", panorama, [cv.IMWRITE_JPEG_QUALITY, quality])
            if not ok:
                raise RuntimeError("JPEG encoding of the panorama failed")
        fill_png = None
        if filled is not None and settings["output"] == "preview" and filled_fraction > 0:
            overlay = np.zeros((filled.shape[0], filled.shape[1], 4), np.uint8)
            overlay[filled > 0] = (200, 0, 255, 150)  # BGRA magenta
            ok, png = cv.imencode(".png", overlay)
            if not ok:
                raise RuntimeError("PNG encoding of the fill overlay failed")
            fill_png = png.tobytes()

        return {
            "jpeg": jpeg.tobytes(),
            "width": int(panorama.shape[1]),
            "height": int(panorama.shape[0]),
            "used": used,
            "dropped": dropped,
            "filled_fraction": filled_fraction,
            "fill_png": fill_png,
            "capped": capped,
            "scale_to_full": math.sqrt(first_mp / effective),
            "seconds": round(time.time() - started, 2),
            "warnings": [str(w.message) for w in caught if not issubclass(w.category, StitchingWarning)] + metadata_warnings,
        }

    # ---- internals -------------------------------------------------------------

    def _make_stitcher(self, settings, per_image):
        # Paragraph: "try harder" registers at higher resolution and accepts weaker matches.
        harder = bool(settings["try_harder"])
        common = {
            "detector": "sift",
            "match_conf": 0.5 if harder else 0.65,
            "confidence_threshold": 0.5 if harder else 1.0,
            "medium_megapix": 1.0 if harder else self.REGISTRATION_MEGAPIX,
            "crop": settings["edges"] == "crop",
            "final_megapix": per_image,
        }

        # Paragraph: camera model.
        if settings["motion"] == "flat":
            return FlatStitcher(self.progress, **common)
        if settings["motion"] != "rotate":
            raise ValueError(f"unknown motion: {settings['motion']}")
        projection = self.PROJECTIONS.get(settings["projection"])
        straighten = self.STRAIGHTEN.get(settings["straighten"])
        if projection is None or straighten is None:
            raise ValueError(f"unknown projection/straighten: {settings['projection']}/{settings['straighten']}")
        return RotatingStitcher(self.progress, warper_type=projection, wave_correct_kind=straighten, **common)

    def _preview_megapix(self, count):
        return max(0.12, min(self.REGISTRATION_MEGAPIX, self.PREVIEW_PANO_MEGAPIX / count))

    def _full_megapix(self, keys, imgs, settings, estimate_key):
        """Per-photo megapixels for a full render: original size unless the panorama would exceed the cap."""
        if estimate_key not in self._estimates:
            result = self.stitch(keys, dict(settings, output="preview"))
            if "error" in result:
                raise StitchingError(result["error"]["message"])
        per_preview, pano_preview = self._estimates[estimate_key]
        original = imgs[0].shape[0] * imgs[0].shape[1] / 1e6  # the library scales every photo by photo 1's factor
        expected = pano_preview * original / per_preview
        cap = float(settings["max_megapix"])
        if expected <= cap:
            return -1, False
        return per_preview * cap / pano_preview, True

    @staticmethod
    def _estimate_key(keys, settings):
        return (tuple(keys), settings["motion"], settings["projection"], settings["straighten"], settings["edges"], bool(settings["try_harder"]))

    @staticmethod
    def _fill_edges(panorama, mask):
        """Fills uncovered pixels with OpenCV inpainting (Telea), computed at reduced size for speed."""
        holes = (mask == 0).astype(np.uint8) * 255 if mask is not None else np.zeros(panorama.shape[:2], np.uint8)
        if not np.any(holes):
            return panorama, holes
        h, w = holes.shape
        scale = min(1.0, math.sqrt(2.0e6 / (w * h)))
        sw, sh = max(8, int(w * scale)), max(8, int(h * scale))
        small = cv.resize(panorama, (sw, sh), interpolation=cv.INTER_AREA)
        small_holes = cv.dilate(cv.resize(holes, (sw, sh), interpolation=cv.INTER_NEAREST), np.ones((3, 3), np.uint8))
        filled_small = cv.inpaint(small, small_holes, 6, cv.INPAINT_TELEA)
        filled = cv.resize(filled_small, (w, h), interpolation=cv.INTER_CUBIC)
        # Feather the boundary so the fill does not meet real pixels with a hard edge.
        alpha = cv.GaussianBlur(holes.astype(np.float32) / 255.0, (0, 0), max(1.0, 2.0 / scale))
        alpha = np.maximum(alpha, holes.astype(np.float32) / 255.0)[..., None]
        out = (panorama.astype(np.float32) * (1 - alpha) + filled.astype(np.float32) * alpha).astype(np.uint8)
        return out, holes

    @staticmethod
    def _classify(message):
        lowered = message.lower()
        if "no match exceeds" in lowered or "do not overlap" in lowered:
            return "NOT_CONNECTED"
        if "camera" in lowered or "homography" in lowered:
            return "ALIGNMENT"
        if "rectangular area" in lowered or "contour" in lowered:
            return "CROP"
        return "STITCHING"

    @staticmethod
    def _error(code, message):
        return {"error": {"code": code, "message": message}}

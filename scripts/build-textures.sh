#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Repacks the CC0 ambientCG source imagery into the two GPU-ready atlases the
# terrain shader samples, and compresses them to KTX2 (Basis Universal).
#
# Why this exists:
#   * The old atlases shipped as baseline JPEG. Normal maps are pure
#     high-frequency vector data, so JPEG's chroma subsampling + 8x8 DCT blocks
#     put ringing and faceted shading into every cliff / bunker / fairway.
#     KTX2 is block-compressed on the GPU and is *lossless* w.r.t. chroma.
#   * It also lets us pack auxiliary channels into the otherwise unused alpha
#     slots, so per-material roughness + parallax height cost ZERO extra texture
#     units (the terrain shader previously blew the 16-sampler WebGL limit).
#   * Download + VRAM both drop versus the raw JPEGs.
#
# Channel layout produced here:
#   ground-color-atlas.ktx2   RGB = albedo (sRGB), A = dampness -> gloss for roughness
#   ground-normal-atlas.ktx2  RG  = tangent-space normal XY (linear)
#                             B   = relief height (drives the cliff parallax march)
#                             A   = spare (opaque)
#
# Usage:   ./scripts/build-textures.sh [source-jpg-dir]
#          SRC_DIR defaults to assets/source-textures (the original JPEGs).
#
# Requires: ImageMagick (convert), basisu (the `basis_universal` npm package
#           ships prebuilt binaries in node_modules/basis_universal/bin/).
#
# To upgrade to a higher-resolution atlas later, drop higher-res per-material
# source images (e.g. straight from ambientCG at 2K/4K) into SRC_DIR as
# lawn / rough / sand / rock .jpg and re-run. QUAD_SIZE controls the per
# material resolution and the atlas is always QUAD_SIZE * 2 square.
# ---------------------------------------------------------------------------
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="${1:-$REPO_ROOT/assets/source-textures}"
OUT_DIR="$REPO_ROOT/public/textures"
QUAD_SIZE=1024           # per-material resolution; atlas = 2 * QUAD_SIZE
COLOR_Q=170              # ETC1S quality for albedo (visually transparent above ~160)
NORMAL_Q=255             # ETC1S quality for the normal atlas (max — vectors are fragile)
ZSTD_LEVEL=8             # outer zstd pass; KTX2Loader needs zstd to be supported

BASISU="$REPO_ROOT/node_modules/basis_universal/bin/basisu"
if [ ! -x "$BASISU" ]; then
  echo "error: basisu not found at $BASISU — run 'npm install' first" >&2
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Quadrant order must match tPhotoQuadUv() in TerrainMesh.ts: 0 lawn, 1 rough,
# 2 sand, 3 rock (column-major within a 2x2 atlas).
MATERIALS=(lawn rough sand rock)
COLOR_SRC=("$SRC_DIR/lawn-color.jpg" "$SRC_DIR/rough-color.jpg" "$SRC_DIR/sand-color.jpg" "$SRC_DIR/rock-color.jpg")
NORMAL_SRC=("$SRC_DIR/lawn-normal.jpg" "$SRC_DIR/rough-normal.jpg" "$SRC_DIR/sand-normal.jpg" "$SRC_DIR/rock-normal.jpg")

# Fall back to cropping quadrants out of the legacy combined atlases if the
# per-material sources are not present.
FALLBACK_COLOR="$SRC_DIR/ground-color-atlas.jpg"
FALLBACK_NORMAL="$SRC_DIR/ground-normal-atlas.jpg"

color_input() {
  local q=$1
  if [ -f "${COLOR_SRC[$q]}" ]; then echo "${COLOR_SRC[$q]}"; else echo "$FALLBACK_COLOR"; fi
}
normal_input() {
  local q=$1
  if [ -f "${NORMAL_SRC[$q]}" ]; then echo "${NORMAL_SRC[$q]}"; else echo "$FALLBACK_NORMAL"; fi
}

echo "==> unpacking $QUAD_SIZE^2 material quadrants"
for q in 0 1 2 3; do
  cx=$(( (q % 2) * QUAD_SIZE ))
  cy=$(( (q / 2) * QUAD_SIZE ))

  # --- albedo quadrant -----------------------------------------------------
  convert "$(color_input $q)" -crop "${QUAD_SIZE}x${QUAD_SIZE}+${cx}+${cy}" +repage \
          -resize "${QUAD_SIZE}x${QUAD_SIZE}!" -colorspace sRGB "$WORK/c$q.png"

  # --- tangent normal quadrant --------------------------------------------
  convert "$(normal_input $q)" -crop "${QUAD_SIZE}x${QUAD_SIZE}+${cx}+${cy}" +repage \
          -resize "${QUAD_SIZE}x${QUAD_SIZE}!" -colorspace sRGB "$WORK/n$q.png"

  # --- aux channels derived from the albedo ---------------------------------
  # height: raw luminance (bright ridges stand proud, dark crevices recede).
  convert "$WORK/c$q.png" -colorspace gray "$WORK/h$q.png"
  # dampness/gloss: heavily blurred, inverted luminance -> dark hollows read as
  # damp and slightly glossier, which matters most on sand and rock.
  convert "$WORK/h$q.png" -blur 0x6 -negate -auto-level "$WORK/damp$q.png"
done

echo "==> packing auxiliary channels into alpha"
for q in 0 1 2 3; do
  convert "$WORK/n$q.png" -channel R -separate "$WORK/nr$q.png"
  convert "$WORK/n$q.png" -channel G -separate "$WORK/ng$q.png"
  # NORMAL atlas: R,G = normal.xy (z is reconstructed in-shader), B = relief height
  # (drives the cliff parallax march), A = opaque spare.
  convert "$WORK/nr$q.png" "$WORK/ng$q.png" "$WORK/h$q.png" "$WORK/h$q.png" \
          -channel RGBA -combine "$WORK/packed_n$q.png"
  # COLOR atlas: RGB = albedo, A = dampness/gloss (read by the terrain roughness pass, so
  # per-material gloss variation costs no extra texture unit).
  convert "$WORK/c$q.png" "$WORK/damp$q.png" -alpha off -compose CopyOpacity -composite \
          "$WORK/packed_c$q.png"
done

echo "==> tiling 2x2 atlases (${QUAD_SIZE}x${QUAD_SIZE} per material)"
montage "$WORK/packed_c0.png" "$WORK/packed_c1.png" "$WORK/packed_c2.png" "$WORK/packed_c3.png" \
        -tile 2x2 -geometry +0+0 -background none "$WORK/atlas_color.png"
montage "$WORK/packed_n0.png" "$WORK/packed_n1.png" "$WORK/packed_n2.png" "$WORK/packed_n3.png" \
        -tile 2x2 -geometry +0+0 -background none "$WORK/atlas_normal.png"

echo "==> compressing to KTX2 (ETC1S + zstd, mipmaps pregenerated)"
"$BASISU" -ktx2 -q "$COLOR_Q" -ktx2_zstandard_level "$ZSTD_LEVEL" -mipmap \
          -file "$WORK/atlas_color.png" -output_file "$OUT_DIR/ground-color-atlas.ktx2" >/dev/null
# Normal atlas: -normal_map tunes the codec for vector data (linear metrics,
# linear-space mip filtering, no selector RDO, no sRGB tagging).
"$BASISU" -ktx2 -q "$NORMAL_Q" -normal_map -ktx2_zstandard_level "$ZSTD_LEVEL" -mipmap \
          -file "$WORK/atlas_normal.png" -output_file "$OUT_DIR/ground-normal-atlas.ktx2" >/dev/null

ls -lh "$OUT_DIR"/ground-*.ktx2
echo "done."

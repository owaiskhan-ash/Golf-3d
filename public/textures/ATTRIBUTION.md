# Photographic PBR Ground Textures

CC0 (public domain) textures from ambientCG, packed into two GPU-ready quadrant
atlases (lawn / rough / sand / rock):

- `ground-color-atlas.ktx2`  — RGB albedo (sRGB), A = dampness/gloss
- `ground-normal-atlas.ktx2` — RG tangent normal XY (linear), B = relief height

Both are Basis Universal KTX2 (ETC1S + Zstandard supercompression) with
pregenerated mipmaps. Basis keeps normal-map chroma intact (baseline JPEG's
chroma subsampling and 8x8 DCT blocks were visibly faceting every cliff and
bunker) and the packed extra channels carry per-material roughness and parallax
height without spending additional texture units — the terrain shader would
otherwise exceed the 16-unit fragment limit.

Quadrant sources:
- quadrant 0 (lawn):  ambientCG Grass008 (dense lawn — fairway / green / first cut)
- quadrant 1 (rough): ambientCG Grass004 (meadow fescue — rough)
- quadrant 2 (sand):  ambientCG Ground049B (coastal bunker sand)
- quadrant 3 (rock):  ambientCG Rock039 (warm Monterey-style sandstone cliffs)

Regenerate with `npm run textures:build` (see `scripts/build-textures.sh`).
The original JPEG atlases are retained in `assets/source-textures/` as the
input to that script; they are not shipped.

License: CC0 — https://ambientcg.com/license

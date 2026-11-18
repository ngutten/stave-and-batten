#!/usr/bin/env python3
"""Generate the shapes the grunge layer is built from: spills, splatters and
drips (local image model, same server as gen_stencils.py). Raw images go to
assets_raw/; tools/pack_grunge.py packs them into one small atlas.

    python3 tools/gen_grunge.py [--force]
"""
import os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gen_stencils import generate, OUT

TAIL = " Solid pure black on a pure white background, flat silhouette, no shading, no grey, no outline, no text, centered with wide white margins."
KINDS = {
    "spill": "The silhouette of one liquid spill stain seen from directly above: an irregular blob with a wavy organic edge, a couple of lobes and a few small satellite drops beside it.",
    "splat": "One paint splatter seen from directly above: a ragged central blot with thin streaks and many small droplets flung outward in all directions.",
    "drip": "Paint that has run down a wall: an irregular thick band along the top edge of the picture with several drips of different lengths running straight down from it, each ending in a rounded drop.",
}
ITEMS = [(f"grunge-{k}-{i}", KINDS[k] + TAIL, 200 + 10 * j + i) for j, k in enumerate(KINDS) for i in range(4)]

if __name__ == "__main__":
    for id_, prompt, seed in ITEMS:
        path = os.path.join(OUT, id_ + ".png")
        if os.path.exists(path) and "--force" not in sys.argv: continue
        t = time.time(); png, used = generate(prompt, seed, "512x512")
        open(path, "wb").write(png); print(f"{id_}: {len(png)//1024} KB in {time.time()-t:.0f}s", flush=True)

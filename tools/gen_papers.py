#!/usr/bin/env python3
"""Generate the paper swatches the drawn styles are painted on (local image
model, same server as gen_stencils.py). Raw images go to assets_raw/;
tools/pack_papers.py turns them into small greyscale tiles.

    python3 tools/gen_papers.py [--force]
"""
import os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gen_stencils import generate, OUT

ITEMS = [
    ("paper-parchment", "Flat top-down scan of a sheet of old parchment vellum filling the whole frame edge to edge, perfectly even lighting, "
     "subtle mottling, fine fibres and pores, a few faint stains, no writing, no drawing, no folds, no torn edges, no border, no shadow, uniform texture", 101),
    ("paper-wash", "Flat top-down scan of rough cold-press watercolour paper covered edge to edge with one even wash of neutral grey paint, "
     "strong pigment granulation settled into the paper tooth, a few soft blooms and backruns, perfectly even lighting, no objects, no brush, "
     "no border, no white margin, uniform texture filling the whole frame", 102),
    ("paper-cel", "Flat top-down scan of a sheet of matte gouache paint, one flat even mid-grey colour filling the whole frame, very faint dry brush strokes "
     "running in different directions, no objects, no border, perfectly even lighting, uniform texture", 103),
]

if __name__ == "__main__":
    for id_, prompt, seed in ITEMS:
        path = os.path.join(OUT, id_ + ".png")
        if os.path.exists(path) and "--force" not in sys.argv: continue
        t = time.time(); png, used = generate(prompt, seed, "768x768")
        open(path, "wb").write(png); print(f"{id_}: {len(png)//1024} KB in {time.time()-t:.0f}s", flush=True)

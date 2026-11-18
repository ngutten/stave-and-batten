#!/usr/bin/env python3
"""Generate the built-in stencil library with a local image model.

Talks to an OpenAI-style /v1/images/generations endpoint (here: Qwen Image
2.1). Raw images go to assets_raw/ (not committed); tools/pack_stencils.py
turns them into the small masks embedded in the page.

    python3 tools/gen_stencils.py [--only id,id] [--force]
"""
import base64, json, os, sys, time, urllib.request

HOST = os.environ.get("IMAGE_HOST", "http://localhost:30020")     # any OpenAI-style /v1/images/generations server
OUT = os.path.join(os.path.dirname(__file__), "..", "assets_raw")

ART = ("A single bold spray-paint stencil of {s}. Solid pure black shapes on a pure white background, "
       "thick simple shapes with stencil bridges, flat, no shading, no gradients, no grey, no outline box, "
       "no border, no text, no letters, centered with wide white margins, crisp vector edges.")
TEXT = ("Bold black military stencil lettering that reads exactly \"{s}\", stencil font with bridge gaps in the letters, "
        "solid pure black on a pure white background, flat, no shading, no border, no box, nothing else in the image, "
        "centered with wide white margins, crisp edges.")

# id, kind, subject, seed
ITEMS = [
    ("fragile", TEXT, "FRAGILE", 11), ("this-side-up", TEXT, "THIS SIDE UP", 12), ("handle-with-care", TEXT, "HANDLE WITH CARE", 13),
    ("explosive", TEXT, "EXPLOSIVE", 14), ("gunpowder", TEXT, "GUNPOWDER", 15), ("rum", TEXT, "RUM", 16), ("ale", TEXT, "ALE", 17),
    ("salt", TEXT, "SALT", 18), ("tea", TEXT, "TEA", 19), ("no-47", TEXT, "No. 47", 20), ("xxx", TEXT, "XXX", 21),
    ("keep-dry", TEXT, "KEEP DRY", 22), ("do-not-open", TEXT, "DO NOT OPEN", 23),
    ("arrows-up", ART, "two thick arrows side by side pointing straight up, the packing symbol for this way up", 31),
    ("glass", ART, "a wine glass with a crack, the packing symbol for fragile", 32),
    ("umbrella", ART, "an open umbrella with raindrops above it, the packing symbol for keep dry", 33),
    ("skull", ART, "a skull and crossbones", 34), ("anchor", ART, "a ship's anchor with a rope", 35),
    ("wheat", ART, "a sheaf of wheat tied in the middle", 36), ("fish", ART, "a fish, side view", 37),
    ("crown", ART, "a royal crown", 38), ("fleur", ART, "a fleur-de-lis", 39), ("key", ART, "an old ornate key", 40),
    ("flame", ART, "a flame, the hazard symbol for flammable", 41), ("grapes", ART, "a bunch of grapes with a vine leaf", 42),
    ("tankard", ART, "a foaming beer tankard", 43), ("ship", ART, "a three-masted sailing ship, side view", 44),
    ("dragon", ART, "a heraldic dragon, side view, wings raised", 45), ("potion", ART, "a round potion bottle with a cork", 46),
    ("anvil", ART, "a hammer crossed over an anvil", 47), ("bee", ART, "a honey bee seen from above", 48),
    ("compass", ART, "an eight-pointed compass rose", 49), ("sun", ART, "a sun with a face and wavy rays", 50),
    ("tree", ART, "an oak tree with roots, inside a circle", 51), ("cat", ART, "a sitting cat seen from behind, tail curled", 52),
    ("hazard", ART, "a triangle warning sign with an exclamation mark", 53), ("atom", ART, "an atom with three orbiting electrons", 54),
    ("cog", ART, "a cog wheel with a lightning bolt in its centre", 55), ("star", ART, "a five-pointed star inside a ring", 56),
    ("coopers-mark", ART, "a round maker's mark: a barrel in the centre of a ring, with a hammer and an adze crossed behind it", 57),
]

def generate(prompt, seed, size="768x768"):
    body = json.dumps({"model": "qwen-image-2.1-nvfp4", "prompt": prompt, "size": size, "n": 1, "seed": seed}).encode()
    req = urllib.request.Request(HOST + "/v1/images/generations", data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=600) as r:
        d = json.load(r)
    return base64.b64decode(d["data"][0]["b64_json"]), d["data"][0].get("seed")

def main():
    only = None; force = "--force" in sys.argv
    for a in sys.argv[1:]:
        if a.startswith("--only"): only = set(sys.argv[sys.argv.index(a) + 1].split(","))
    os.makedirs(OUT, exist_ok=True)
    for id_, tmpl, subj, seed in ITEMS:
        if only and id_ not in only: continue
        path = os.path.join(OUT, id_ + ".png")
        if os.path.exists(path) and not force: continue
        t = time.time()
        size = "1024x512" if tmpl is TEXT else "768x768"
        png, used = generate(tmpl.format(s=subj), seed, size)
        open(path, "wb").write(png)
        print(f"{id_}: {len(png)//1024} KB in {time.time()-t:.0f}s (seed {used})", flush=True)

if __name__ == "__main__":
    main()

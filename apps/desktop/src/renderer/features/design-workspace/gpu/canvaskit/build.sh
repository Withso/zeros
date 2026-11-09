#!/usr/bin/env bash
# Rebuilds the vendored CanvasKit from source and checks it against the pins
# in design-canvaskit-build.ts. Needs git, python3, curl and about 3 GB of
# disk; on Amazon Linux also `dnf install libatomic` for emsdk's wasm-opt.
#
#   ./build.sh [work-directory]
#
# With --stock it skips zeros-design.patch; that build matches the published
# npm canvaskit-wasm@0.42.0 bin/ files byte for byte.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STOCK=0
if [[ "${1:-}" == "--stock" ]]; then STOCK=1; shift; fi
WORK="${1:-${TMPDIR:-/tmp}/zeros-canvaskit-build}"
SKIA_REVISION=e2def78fa232884d4aedcf3ad92d4a0dd673b898
# Third-party sources the build compiles, pinned by Skia's DEPS at that revision.
DEPS_NEEDED="brotli emsdk freetype harfbuzz icu libjpeg-turbo libpng libwebp partition_alloc wuffs zlib"
FLAGS="release no_skottie no_sksl_trace no_alias_font no_effects_deserialization no_encode_jpeg no_encode_webp legacy_draw_vertices no_embedded_font"

mkdir -p "$WORK"
SKIA="$WORK/skia"
if [[ ! -d "$SKIA/.git" ]]; then
  git init -q "$SKIA"
  git -C "$SKIA" remote add origin https://github.com/google/skia.git
fi
git -C "$SKIA" fetch -q --depth 1 origin "$SKIA_REVISION"
git -C "$SKIA" checkout -q --force FETCH_HEAD
git -C "$SKIA" clean -qfdx -e third_party/externals -e out -e bin
for name in $DEPS_NEEDED; do
  read -r url rev < <(python3 -I - "$SKIA/DEPS" "$name" <<'PY'
import re, sys
text = open(sys.argv[1]).read()
m = re.search(r'"third_party/externals/%s"\s*:\s*"([^"@]+)@([0-9a-f]+)"' % re.escape(sys.argv[2]), text)
print(m.group(1), m.group(2))
PY
)
  dir="$SKIA/third_party/externals/$name"
  if [[ ! -d "$dir/.git" ]]; then git init -q "$dir"; git -C "$dir" remote add origin "$url"; fi
  git -C "$dir" fetch -q --depth 1 origin "$rev"
  git -C "$dir" checkout -q --force FETCH_HEAD
done
(cd "$SKIA" && python3 bin/fetch-gn && python3 bin/fetch-ninja && python3 bin/activate-emsdk)
if [[ $STOCK -eq 0 ]]; then git -C "$SKIA" apply "$HERE/zeros-design.patch"; fi
# shellcheck disable=SC2086
(cd "$SKIA/modules/canvaskit" && ./compile.sh $FLAGS)
OUT="$SKIA/out/canvaskit_wasm"
python3 -I - "$HERE/design-canvaskit-build.ts" "$OUT" "$STOCK" <<'PY'
import hashlib, re, sys
source, out, stock = open(sys.argv[1]).read(), sys.argv[2], sys.argv[3] == "1"
block = re.search(r"DESIGN_CANVASKIT_STOCK_SHA256 = Object\.freeze\(\{(.*?)\}\)" if stock else
                  r"DESIGN_CANVASKIT_SHA256 = Object\.freeze\(\{(.*?)\}\)", source, re.S).group(1)
ok = True
for name in ("canvaskit.js", "canvaskit.wasm"):
    want = re.search(r'"%s": "([0-9a-f]{64})"' % re.escape(name), block).group(1)
    got = hashlib.sha256(open(f"{out}/{name}", "rb").read()).hexdigest()
    print(("ok  " if got == want else "BAD ") + name + " " + got)
    ok = ok and got == want
sys.exit(0 if ok else 1)
PY
echo "Built $OUT. Copy canvaskit.js and canvaskit.wasm here only after the pins match."

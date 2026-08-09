# Fetches the Kokoro model weights into api/models/.
#
#     cd api
#     pip install -r requirements-tts.txt
#     python download_voices.py
#
# ~340MB total, downloaded once. The files are gitignored on purpose -
# they are far too large to commit, and every machine can fetch them.

import os
import sys
import urllib.request

BASE = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"
FILES = [
    ("kokoro-v1.0.onnx", 325_532_387),
    ("voices-v1.0.bin", 28_214_398),
]

MODELS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models")


def progress(count, block_size, total):
    if total <= 0:
        return
    done = min(count * block_size, total)
    pct = done * 100 // total
    bar = "#" * (pct // 3)
    sys.stdout.write(f"\r  [{bar:<33}] {pct:3d}%  {done / 1e6:6.1f} / {total / 1e6:.1f} MB")
    sys.stdout.flush()


def main():
    os.makedirs(MODELS_DIR, exist_ok=True)

    for name, expected_size in FILES:
        target = os.path.join(MODELS_DIR, name)

        if os.path.isfile(target) and os.path.getsize(target) == expected_size:
            print(f"{name}: already present, skipping")
            continue

        print(f"{name}: downloading...")
        # Download beside the target first so an interrupted run doesn't
        # leave a truncated file that looks valid next time.
        temporary = target + ".part"
        urllib.request.urlretrieve(f"{BASE}/{name}", temporary, reporthook=progress)
        print()

        size = os.path.getsize(temporary)
        if size != expected_size:
            os.remove(temporary)
            raise SystemExit(f"{name}: expected {expected_size} bytes, got {size}. Try again.")

        os.replace(temporary, target)
        print(f"{name}: done")

    print(f"\nModels ready in {MODELS_DIR}")
    print("Start the API, then check: curl http://localhost:8000/api/tts/health")


if __name__ == "__main__":
    main()

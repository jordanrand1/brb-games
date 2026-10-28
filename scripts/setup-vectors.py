#!/usr/bin/env python3
"""Install a compact, local subset of public-domain GloVe vectors."""

import argparse
import json
import re
import struct
import tempfile
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path


MODEL_URL = "https://huggingface.co/NeuML/glove-2024-wikigiga-quantized/resolve/main/model.safetensors?download=true"
VOCAB_URL = "https://huggingface.co/NeuML/glove-2024-wikigiga-quantized/resolve/main/vocab.json?download=true"
WORDNET_URL = "https://raw.githubusercontent.com/nltk/nltk_data/gh-pages/packages/corpora/wordnet.zip"
ROOT = Path(__file__).resolve().parents[1]
OUTPUT_VECTORS = ROOT / "src" / "glove-vectors.bin"
OUTPUT_WORDS = ROOT / "src" / "glove-vocab.json"
OUTPUT_TARGETS = ROOT / "src" / "context-targets.json"
MAX_WORDS = 12_000
STOP_WORDS = set("""
a about above after again against all am an and any are as at be because been before
being below between both but by can could did do does doing down during each few for
from further had has have having he her here hers herself him himself his how i if
in into is it its itself just me more most my myself no nor not of off on once only
or other our ours ourselves out over own same she should so some such than that the
their theirs them themselves then there these they this those through to too under
until up very was we were what when where which while who whom why will with would
you your yours yourself yourselves also get got make made one two use used using
""".split())


def download(url: str, path: Path) -> None:
    request = urllib.request.Request(url, headers={"User-Agent": "BRB-Arcade/0.1 vector-setup"})
    partial = path.with_suffix(path.suffix + ".part")
    for attempt in range(1, 4):
        try:
            print(f"Downloading {path.name} (attempt {attempt}/3)…", flush=True)
            with urllib.request.urlopen(request, timeout=60) as response, partial.open("wb") as output:
                total = int(response.headers.get("Content-Length", "0"))
                received = 0
                while chunk := response.read(1024 * 1024):
                    output.write(chunk)
                    received += len(chunk)
                    if total:
                        print(f"\r  {received / total:.0%}", end="", flush=True)
            print()
            partial.replace(path)
            return
        except (OSError, urllib.error.URLError) as error:
            partial.unlink(missing_ok=True)
            if attempt == 3:
                raise RuntimeError(f"Could not download {path.name}. Check your internet connection and retry.") from error
            print(f"\nDownload failed: {error}. Retrying in 2 seconds…", flush=True)
            time.sleep(2)


def tensors(model_path: Path) -> tuple[dict, memoryview, memoryview]:
    data = model_path.read_bytes()
    header_size = struct.unpack_from("<Q", data, 0)[0]
    header_end = 8 + header_size
    header = json.loads(data[8:header_end])
    payload = memoryview(data)[header_end:]
    codebook_info = header["codewords"]
    code_offset = codebook_info["data_offsets"][0]
    code_size = codebook_info["data_offsets"][1] - code_offset
    codewords = memoryview(payload[code_offset:code_offset + code_size])
    vector_info = header["vectors"]
    vector_offset = vector_info["data_offsets"][0]
    vector_bytes = payload[vector_offset:vector_info["data_offsets"][1]]
    if codebook_info["shape"] != [10, 256, 30] or vector_info["shape"][1] != 10:
        raise RuntimeError("The downloaded GloVe model has an unexpected vector format.")
    return header, codewords, vector_bytes


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--local-dir", type=Path, help="Use previously downloaded model.safetensors and vocab.json from this directory.")
    parser.add_argument("--wordnet-zip", type=Path, help="Use a previously downloaded WordNet 3.0 zip file.")
    args = parser.parse_args()

    OUTPUT_VECTORS.parent.mkdir(parents=True, exist_ok=True)
    if args.local_dir:
        model_path = args.local_dir / "model.safetensors"
        vocab_path = args.local_dir / "vocab.json"
        if not model_path.is_file() or not vocab_path.is_file():
            raise SystemExit("Expected model.safetensors and vocab.json in --local-dir.")
        build_subset(model_path, vocab_path)
        words = json.loads(OUTPUT_WORDS.read_text(encoding="utf-8"))
    elif OUTPUT_VECTORS.is_file() and OUTPUT_WORDS.is_file():
        words = json.loads(OUTPUT_WORDS.read_text(encoding="utf-8"))
    else:
        with tempfile.TemporaryDirectory(prefix="brb-glove-") as temporary:
            temporary_path = Path(temporary)
            model_path = temporary_path / "model.safetensors"
            vocab_path = temporary_path / "vocab.json"
            download(MODEL_URL, model_path)
            download(VOCAB_URL, vocab_path)
            build_subset(model_path, vocab_path)
            words = json.loads(OUTPUT_WORDS.read_text(encoding="utf-8"))

    if args.wordnet_zip:
        targets = build_noun_targets(words, args.wordnet_zip)
    else:
        with tempfile.TemporaryDirectory(prefix="brb-wordnet-") as temporary:
            wordnet_path = Path(temporary) / "wordnet.zip"
            download(WORDNET_URL, wordnet_path)
            targets = build_noun_targets(words, wordnet_path)
    temporary_targets = OUTPUT_TARGETS.with_suffix(".json.tmp")
    temporary_targets.write_text(json.dumps(targets, separators=(",", ":")), encoding="utf-8")
    temporary_targets.replace(OUTPUT_TARGETS)
    print(f"Installed {sum(len(targets[key]) for key in ['easy', 'normal', 'hard']):,} concrete noun targets: " + ", ".join(f"{key} {len(targets[key]):,}" for key in ['easy', 'normal', 'hard']))


def build_subset(model_path: Path, vocab_path: Path) -> None:
    print("Reading compact GloVe model and vocabulary…", flush=True)
    header, codewords_data, quantized_vectors = tensors(model_path)
    codewords = struct.unpack(f"<{len(codewords_data) // 4}f", codewords_data)
    tokens = json.loads(vocab_path.read_text(encoding="utf-8"))["tokens"]
    words: list[str] = []
    temporary_vectors = OUTPUT_VECTORS.with_suffix(".bin.tmp")
    temporary_words = OUTPUT_WORDS.with_suffix(".json.tmp")

    with temporary_vectors.open("wb") as output:
        # The source vocabulary is frequency ordered; retain common, ordinary
        # single words and omit punctuation, names with symbols, and stop words.
        for word, index in tokens.items():
            if not re.fullmatch(r"[a-z]{3,20}", word) or word in STOP_WORDS:
                continue
            if index < 0 or index * 10 + 10 > len(quantized_vectors):
                continue
            codes = quantized_vectors[index * 10:index * 10 + 10]
            vector: list[float] = []
            for part, code in enumerate(codes):
                start = (part * 256 + code) * 30
                vector.extend(codewords[start:start + 30])
            output.write(struct.pack("<300f", *vector))
            words.append(word)
            if len(words) >= MAX_WORDS:
                break

    if len(words) < 5_000:
        temporary_vectors.unlink(missing_ok=True)
        raise RuntimeError(f"Only found {len(words)} usable vectors; refusing to write an undersized model.")
    temporary_words.write_text(json.dumps(words, separators=(",", ":")), encoding="utf-8")
    temporary_vectors.replace(OUTPUT_VECTORS)
    temporary_words.replace(OUTPUT_WORDS)
    print(f"Installed {len(words):,} rankable words ({OUTPUT_VECTORS.stat().st_size / 1_000_000:.1f} MB).")


def build_noun_targets(words: list[str], archive_path: Path) -> dict:
    with zipfile.ZipFile(archive_path) as archive:
        categories = {"noun.animal", "noun.artifact", "noun.body", "noun.food", "noun.location", "noun.object", "noun.person", "noun.plant", "noun.substance", "noun.phenomenon", "noun.group", "noun.possession", "noun.shape"}
        lexnames = {int(fields[0]) for line in archive.read("wordnet/lexnames").decode().splitlines() if (fields := line.split()) and fields[1] in categories}
        concrete_synsets = {}
        for line in archive.read("wordnet/data.noun").decode().splitlines():
            if not line or not line[0].isdigit():
                continue
            fields = line.split("|", 1)[0].split()
            if int(fields[1]) not in lexnames:
                continue
            count = int(fields[3], 16)
            concrete_synsets[fields[0]] = {fields[4 + i * 2] for i in range(count) if re.fullmatch(r"[a-z]{3,20}", fields[4 + i * 2])}
        nouns = set()
        for line in archive.read("wordnet/index.noun").decode().splitlines():
            if not line or line[0].isspace():
                continue
            fields = line.split()
            first_sense = fields[6 + int(fields[3])]
            if fields[0] in concrete_synsets.get(first_sense, set()):
                nouns.add(fields[0])
    targets = [word for word in words if word in nouns and word not in STOP_WORDS]
    if len(targets) < 1_000:
        raise RuntimeError(f"Only found {len(targets)} noun targets. Refusing to replace the current list.")
    # Curated everyday anchors make Easy useful despite the source corpus's
    # news vocabulary. Frequency splits the remaining concrete nouns.
    easy_candidates = set((ROOT / "scripts" / "easy-nouns.txt").read_text().split())
    easy = [word for word in targets if word in easy_candidates]
    remaining = [word for word in targets if word not in easy_candidates]
    middle = len(remaining) // 2
    return {"version": 2, "easy": easy, "normal": remaining[:middle], "hard": remaining[middle:]}


if __name__ == "__main__":
    try:
        main()
    except RuntimeError as error:
        raise SystemExit(f"Setup failed: {error}") from error

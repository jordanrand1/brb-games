#!/usr/bin/env python3
"""Build a compact, local commonsense model and concrete-noun answer pools."""

import argparse
import gzip
import hashlib
import json
import math
import re
import shutil
import struct
import subprocess
import tempfile
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MODEL_URL = "https://conceptnet.s3.amazonaws.com/downloads/2019/numberbatch/numberbatch-en-19.08.txt.gz"
VOCAB_URL = "https://huggingface.co/NeuML/glove-2024-wikigiga-quantized/resolve/main/vocab.json?download=true"
WORDNET_URL = "https://raw.githubusercontent.com/nltk/nltk_data/gh-pages/packages/corpora/wordnet.zip"
OUTPUT_VECTORS = ROOT / "src" / "local-vectors.bin"
OUTPUT_WORDS = ROOT / "src" / "local-vocab.json"
OUTPUT_TARGETS = ROOT / "src" / "context-targets.json"
OUTPUT_MODEL = ROOT / "src" / "semantic-model.json"
MAX_WORDS = 30_000
DIMENSIONS = 300
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
# Broad, abstract, inflected, slang and misleading corpus words make poor secrets.
# They remain valid guesses when present in the model.
EXCLUDED_TARGETS = set("""
thing object entity place area part type kind stuff substance material matter piece
point sort issue case phenomenon creation innovation invention collection end top
side front back addition result response source effect position system art relation
whole situation structure form work works parts arms housing assembly setting
volume unit supply ground ways remains female male state john mike news public
national general local official following found dead government people company
bracing coping filling grinding loading packing clearing facing modernism innovation
whereabouts midst affinity impetus resonance consequence derivation duplication etcetera
fuck shit piss porn pornography penis vagina semen asshole bastard
""".split())


def download(url: str, destination: Path) -> None:
    """Use the system TLS configuration; never disable certificate verification."""
    partial = destination.with_suffix(destination.suffix + ".part")
    print(f"Downloading {destination.name}…", flush=True)
    if shutil.which("curl"):
        subprocess.run(["curl", "-fL", "--retry", "2", "--connect-timeout", "30", "--max-time", "600", url, "-o", str(partial)], check=True)
    else:
        request = urllib.request.Request(url, headers={"User-Agent": "BRB-Arcade/vector-setup"})
        with urllib.request.urlopen(request, timeout=90) as source, partial.open("wb") as output:
            shutil.copyfileobj(source, output)
    partial.replace(destination)


def noun_candidates(archive_path: Path, frequency: dict[str, int], curated: set[str]) -> list[str]:
    """Require a physical noun's primary sense and predominant noun usage.

    Having *any* noun sense is insufficient: 'dead', 'national', and 'found'
    all have noun entries in WordNet. Named-person homonyms and inflections
    are unsuitable automatic secrets even when they also name an object.
    """
    with zipfile.ZipFile(archive_path) as archive:
        physical = {}
        names = set()
        for line in archive.read("wordnet/data.noun").decode().splitlines():
            if not line or not line[0].isdigit():
                continue
            fields = line.split("|", 1)[0].split()
            category = int(fields[1])
            lemmas = {fields[4 + i * 2] for i in range(int(fields[3], 16))}
            if category in {5, 6, 8, 13, 15, 17, 19, 20, 27}:
                physical[fields[0]] = lemmas
            if category == 18:
                names.update(word.casefold() for word in lemmas if any(char.isupper() for char in word))
        counts: dict[str, dict[str, int]] = {}
        primary = {}
        for line in archive.read("wordnet/index.sense").decode().splitlines():
            key, offset, sense, tagged = line.split()
            lemma, detail = key.rsplit("%", 1)
            word, pos, count = lemma.casefold(), detail[0], int(tagged)
            scores = counts.setdefault(word, {})
            scores[pos] = scores.get(pos, 0) + count
            if pos == "1":
                candidate = (count, -int(sense), lemma == word, offset)
                if word not in primary or candidate > primary[word]:
                    primary[word] = candidate
        inflections = set()
        for path in ("wordnet/noun.exc", "wordnet/verb.exc"):
            for line in archive.read(path).decode().splitlines():
                parts = line.split()
                if len(parts) > 1 and parts[0] not in parts[1:]:
                    inflections.add(parts[0])
    answers = set()
    for word, (_, _, _, offset) in primary.items():
        noun = counts[word].get("1", 0)
        other = sum(count for pos, count in counts[word].items() if pos != "1")
        if (not re.fullmatch(r"[a-z]{3,20}", word) or word in EXCLUDED_TARGETS
                or word in STOP_WORDS or word in names or word in inflections
                or word not in physical.get(offset, set()) or noun < 1
                or noun < other or frequency.get(word, 10**9) > 200_000):
            continue
        # Singular answers make a close singular/plural guess easy to resolve.
        singulars = [word[:-1]] if word.endswith("s") else []
        if word.endswith("ies"):
            singulars.append(word[:-3] + "y")
        if word.endswith("es"):
            singulars.append(word[:-2])
        if any(singular in primary for singular in singulars):
            continue
        answers.add(word)
    # Human-selected familiar nouns can intentionally resolve ambiguous senses
    # (tiger, rose, watch) and natural plurals (pants, scissors, headphones).
    answers.update(word for word in curated if re.fullmatch(r"[a-z]{3,20}", word) and word not in EXCLUDED_TARGETS)
    return sorted(answers, key=lambda word: (frequency.get(word, 10**9), word))


def quality_check(vectors: dict[str, bytes]) -> None:
    def cosine(left: str, right: str) -> float:
        a = struct.unpack("<300f", vectors[left])
        b = struct.unpack("<300f", vectors[right])
        return sum(x * y for x, y in zip(a, b)) / math.sqrt(sum(x*x for x in a) * sum(x*x for x in b))
    comparisons = [
        ("tiger", "lion", "space"), ("tiger", "jungle", "space"),
        ("tiger", "animal", "space"), ("pail", "bucket", "space"),
        ("pail", "sand", "space"), ("ocean", "sea", "computer"),
        ("computer", "keyboard", "animal"), ("guitar", "piano", "potato"),
        ("apple", "fruit", "rocket"),
    ]
    for target, related, unrelated in comparisons:
        if cosine(target, related) <= cosine(target, unrelated) + .1:
            raise RuntimeError(f"Semantic quality check failed: {target}/{related}/{unrelated}. Refusing to install this model.")


def partition_targets(answers: list[str], available: set[str]) -> dict:
    easy_words = set((ROOT / "scripts" / "easy-nouns.txt").read_text().split())
    standard_words = set((ROOT / "scripts" / "standard-nouns.txt").read_text().split())
    eligible = list(dict.fromkeys(word for word in answers if word in available and word not in EXCLUDED_TARGETS))
    return {"version": 4,
        "easy": [word for word in eligible if word in easy_words],
        "normal": [word for word in eligible if word in standard_words and word not in easy_words],
        "hard": [word for word in eligible if word not in easy_words | standard_words]}


def write_targets(targets: dict, manifest: dict) -> None:
    if len(targets["easy"]) < 300 or len(targets["normal"]) < 300 or sum(len(targets[key]) for key in ("easy", "normal", "hard")) < 1500:
        raise RuntimeError("Too few reviewed answers. Refusing to replace the installed pools.")
    pools = json.dumps(targets, separators=(",", ":")).encode()
    manifest["targetCount"] = sum(len(targets[key]) for key in ("easy", "normal", "hard"))
    manifest["targetSha256"] = hashlib.sha256(pools).hexdigest()
    for path, content in [(OUTPUT_TARGETS, pools), (OUTPUT_MODEL, json.dumps(manifest, indent=2).encode() + b"\n")]:
        temporary = path.with_suffix(path.suffix + ".tmp")
        temporary.write_bytes(content)
        temporary.replace(path)
    print("Answer pools: " + ", ".join(f"{key} {len(targets[key])}" for key in ("easy", "normal", "hard")))


def refresh_targets() -> None:
    """Review the existing pool without downloading or changing vectors/ranks."""
    manifest = json.loads(OUTPUT_MODEL.read_text())
    for path, key in [(OUTPUT_VECTORS, "vectorSha256"), (OUTPUT_WORDS, "vocabSha256"), (OUTPUT_TARGETS, "targetSha256")]:
        if hashlib.sha256(path.read_bytes()).hexdigest() != manifest[key]:
            raise RuntimeError("Installed data failed verification. Rebuild before refreshing pools.")
    old = json.loads(OUTPUT_TARGETS.read_text())
    answers = old["easy"] + old["normal"] + old["hard"]
    write_targets(partition_targets(answers, set(json.loads(OUTPUT_WORDS.read_text()))), manifest)


def build(model_path: Path, vocab_path: Path, wordnet_path: Path) -> None:
    frequency = json.loads(vocab_path.read_text(encoding="utf-8"))["tokens"]
    curated = set((ROOT / "scripts" / "easy-nouns.txt").read_text().split())
    answers = noun_candidates(wordnet_path, frequency, curated)
    required = "tiger lion jungle animal space pail bucket sand beach pale ocean sea computer keyboard guitar piano potato apple fruit rocket".split()
    ordered = list(dict.fromkeys(required + answers + [word for word, _ in sorted(frequency.items(), key=lambda item: item[1])
        if re.fullmatch(r"[a-z]{3,20}", word) and word not in STOP_WORDS][:MAX_WORDS * 2]))
    wanted = set(ordered)
    found: dict[str, bytes] = {}
    print("Reading commonsense vectors and checking vocabulary…", flush=True)
    with gzip.open(model_path, "rt", encoding="utf-8") as source:
        header = source.readline().split()
        if len(header) != 2 or int(header[1]) != DIMENSIONS:
            raise RuntimeError("Unexpected Numberbatch dimensions.")
        for line in source:
            word, _, values = line.partition(" ")
            if word not in wanted:
                continue
            vector = [float(value) for value in values.split()]
            if len(vector) != DIMENSIONS or not all(math.isfinite(value) for value in vector) or sum(x*x for x in vector) < 1e-10:
                raise RuntimeError(f"Invalid vector for {word}.")
            found[word] = struct.pack("<300f", *vector)
    words = [word for word in ordered if word in found][:MAX_WORDS]
    if len(words) < 20_000:
        raise RuntimeError("Too few common guess words. Refusing to replace the installed data.")
    quality_check(found)
    available = set(words)
    targets = partition_targets(answers, available)
    target_count = sum(len(targets[key]) for key in ("easy", "normal", "hard"))
    if len(targets["easy"]) < 300 or len(targets["normal"]) < 300 or target_count < 1500:
        raise RuntimeError("Too few verified noun answers. Refusing to replace the installed pools.")
    data = b"".join(found[word] for word in words)
    vocab = json.dumps(words, separators=(",", ":")).encode()
    pools = json.dumps(targets, separators=(",", ":")).encode()
    digest = hashlib.sha256(data).hexdigest()
    manifest = {"id": "numberbatch-en-19.08-" + digest[:12], "label": "ConceptNet Numberbatch 19.08", "dimensions": DIMENSIONS,
        "vocabularySize": len(words), "targetCount": target_count, "source": MODEL_URL,
        "license": "CC-BY-SA-4.0", "vectorSha256": digest, "vocabSha256": hashlib.sha256(vocab).hexdigest(),
        "targetSha256": hashlib.sha256(pools).hexdigest()}
    for path, content in [(OUTPUT_VECTORS, data), (OUTPUT_WORDS, vocab), (OUTPUT_TARGETS, pools), (OUTPUT_MODEL, json.dumps(manifest, indent=2).encode() + b"\n")]:
        temporary = path.with_suffix(path.suffix + ".tmp")
        temporary.write_bytes(content)
        temporary.replace(path)
    print(f"Installed {len(words):,} local guess words and {manifest['targetCount']:,} answers.")
    print("Answer pools: " + ", ".join(f"{key} {len(targets[key])}" for key in ("easy", "normal", "hard")))
    print("Association quality checks passed. No API is used to score guesses.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, help="Previously downloaded numberbatch-en-19.08.txt.gz.")
    parser.add_argument("--vocab", type=Path, help="Previously downloaded GloVe vocab.json used only for frequency ordering.")
    parser.add_argument("--wordnet-zip", type=Path, help="Previously downloaded WordNet 3.0 zip.")
    parser.add_argument("--rebuild", action="store_true", help="Rebuild already installed data.")
    parser.add_argument("--refresh-targets", action="store_true", help="Reclassify installed answers without redownloading or changing ranks.")
    args = parser.parse_args()
    if args.refresh_targets:
        refresh_targets()
        return
    if not args.rebuild and not any([args.source, args.vocab, args.wordnet_zip]) and all(path.exists() for path in [OUTPUT_VECTORS, OUTPUT_WORDS, OUTPUT_TARGETS, OUTPUT_MODEL]):
        print("Local commonsense data is already installed. Use --rebuild to regenerate it.")
        return
    with tempfile.TemporaryDirectory(prefix="brb-vectors-") as directory:
        temporary = Path(directory)
        paths = []
        for local, filename, url in [(args.source, "numberbatch-en-19.08.txt.gz", MODEL_URL), (args.vocab, "vocab.json", VOCAB_URL), (args.wordnet_zip, "wordnet.zip", WORDNET_URL)]:
            path = local or temporary / filename
            if not local:
                download(url, path)
            paths.append(path)
        build(*paths)


if __name__ == "__main__":
    main()

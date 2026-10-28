# Semantic Hunt scoring

Semantic Hunt compares every guess against the same secret using local
ConceptNet Numberbatch 19.08 vectors. Numberbatch includes commonsense graph
relationships in addition to text-trained embeddings. It requires no paid
per-guess request and is independent of OPENAI_API_KEY, which only enables
Krillion judging. The scorer is identified in game state and on the dashboard.

The previous quantized GloVe data produced poor gameplay relationships: with
`tiger` as the target, `space` ranked ahead of `animal` and `jungle`. The original
12,000-word selection also omitted ordinary guesses such as `bucket` and `pail`.
A source-decoder comparison confirmed those scores came from that model rather
than a reconstruction bug. The replacement data passes explicit association
checks before installation and in the app's regression tests.

## Ranks and bars

Cosine similarity is calculated between the two vectors; larger scores mean a
stronger learned relationship. Every supported word is sorted against the
secret to obtain its vocabulary rank. Rank #1 is the exact answer. The ranking
is stable for a given installed dataset. The 0–100% bar displays clamped cosine
similarity multiplied by 100, not the probability that a guess is correct.

Local heat colors require both rank and association strength: hot requires top
ten and at least 50%; warm requires top 250 and at least 30%; a weak connection
requires top 1,500 and at least 20%; otherwise the clue is cold. “Best so far”
means only the best submitted guess. A 17% clue stays cold even when ranked #417.
The overlay suggests trying another topic when all submitted clues are cold.
Improvements, awards and clutch time still use actual cosine point gains.
Rank can change if the installed vocabulary grows.

With the bundled 30,000-word dataset:

| Secret | Guess | Rank |
| --- | --- | ---: |
| tiger | animal | 112 |
| tiger | jungle | 45 |
| tiger | lion | 7 |
| tiger | space | 24,305 |
| pail | beach | 2,282 |
| pail | sand | 129 |
| pail | bucket | 2 |

These are useful regression examples, not a guarantee of one prescribed route
through a word. Broad clues may cover many concepts, synonyms and plurals may
rank very highly, and a word with multiple meanings can have several clusters.

The next playtest confirmed that low-scoring leaders can lead players down an
unhelpful topic. For example, `farm` is #889 for `infield` at 17%, while `baseball`
is #12 at 67%. `room` is #417 for `pew` at 17%, while `church` is #6 at 39%.
`drink` is #22 for `whiskey`; `funeral` is #6 for `coffin`. These are distinct
topic clusters, so a weak best guess should not tell players to stay on that topic.

## Answer selection

The answer pool contains 481 reviewed Easy nouns, 852 reviewed Standard nouns,
and 969 automatically filtered Expert nouns. Easy is the default for new setups;
saved explicit difficulty settings remain intact. Standard uses an explicit
allowlist in `scripts/standard-nouns.txt`, rather than a corpus-frequency cutoff.
Specialist words such as `infield`, `pew` and `chancel` are Expert-only.
The wider
30,000-word guess vocabulary includes adjectives, verbs and other useful clues.
Known compounds can be typed with spaces: `sand castle` resolves to `sandcastle`.
This joins at most three words and only accepts the result if it is in the
installed vocabulary; arbitrary sentences do not become invented vectors.

The filter checks predominant noun usage across WordNet parts of speech and the
primary noun's physical category. It rejects named-person homonyms, irregular
verb forms, ordinary plural inflections, generic abstractions and known poor
secrets. Curated familiar nouns handle intentional senses and natural plurals,
such as `tiger`, `rose`, `watch`, `pants` and `scissors`. A rare noun sense alone
cannot qualify a word such as `dead`, `national` or `found`. Reported poor targets
such as `bracing`, `coping` and `grinding` are excluded across all difficulties.

Automated filtering is an approximation of playability. New unfair answers
should be reviewed and added to the exclusions or replaced by curated entries.
Expert includes less familiar concrete nouns; Easy is the best first playtest.
The API retains the `hard` identifier for compatibility with saved settings.

## Assets, rebuilding and upgrades

The bundle contains `local-vectors.bin`, `local-vocab.json`, `context-targets.json`
and `semantic-model.json`. The manifest pins dimensions, counts, the source,
license and hashes of all three data files. Startup rejects a partial or mixed
install. The data is a transformed Numberbatch subset under CC BY-SA 4.0; see
`licenses/NUMBERBATCH.txt` for attribution. The WordNet notice is kept separately.

`npm run setup:vectors` installs missing assets. Existing assets are reused.
Use `--rebuild` after changing curated nouns or filter rules. To use downloads
already on disk:

```sh
npm run setup:vectors -- --source /private/path/numberbatch-en-19.08.txt.gz --vocab /private/path/vocab.json --wordnet-zip /private/path/wordnet.zip
```

The GloVe vocabulary is used only to prioritize common English words by frequency;
its vector values are not used. The installer uses standard Python libraries and
system curl when available; TLS certificate checks remain enabled.

`npm run setup:vectors -- --refresh-targets` reclassifies the installed answer
pool after reviewing word lists or exclusions, without downloading vectors or
changing any guess ranks. It validates installed hashes and updates the pool hash.

Live rounds are stamped with their scoring model ID. On restoring a round from
the previous model, the app draws a fresh word and pauses for reconnection,
preserving earned points, streak and community records without awarding a loss.
Old guess ranks are discarded, so they cannot be mixed with new scores. Updated
answer pools reset affected shuffled bags; historical records remain unchanged.
Restoring a live answer removed from its difficulty pool also draws a fresh word
without recording a loss. Valid active words and their submitted guesses survive
pool-only reviews.

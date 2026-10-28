import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";

/**
 * Deterministic local commonsense cosine ranking. It loads a compact Numberbatch
 * subset when installed and keeps a small hand-built seed vocabulary as the
 * offline fallback. This is not Contexto's private vocabulary or model.
 */

const groups: Array<[string, string[]]> = [
  ["animal", "cat dog rabbit horse cow sheep goat pig chicken duck goose turkey eagle owl hawk parrot penguin whale dolphin shark octopus seal turtle frog snake lizard crocodile lion tiger bear wolf fox deer mouse rat squirrel bat bee butterfly spider ant crab lobster salmon trout tuna".split(" ")],
  ["food", "apple orange banana lemon lime grape strawberry blueberry cherry peach pear melon pineapple mango coconut avocado tomato potato carrot onion garlic lettuce spinach broccoli corn rice bread pasta pizza burger sandwich cheese butter egg chicken soup salad cookie cake chocolate honey sugar salt pepper coffee tea milk juice water".split(" ")],
  ["home", "house home apartment room kitchen bedroom bathroom garden roof door window chair table desk sofa bed lamp shelf mirror clock key lock carpet blanket pillow towel cup plate bowl fork spoon knife pan pot oven fridge".split(" ")],
  ["nature", "tree forest flower grass leaf root seed mountain hill valley river lake ocean sea beach island desert cave rock stone sand soil field meadow jungle volcano".split(" ")],
  ["weather", "sun moon star sky cloud rain snow wind storm thunder lightning rainbow fog ice fire smoke".split(" ")],
  ["transport", "car truck bus train bicycle motorcycle airplane helicopter boat ship taxi subway scooter rocket".split(" ")],
  ["body", "head face eye ear nose mouth tooth tongue neck shoulder arm hand finger chest heart stomach back leg knee foot skin hair brain bone blood".split(" ")],
  ["music", "music song singer guitar piano drum violin trumpet flute band concert melody rhythm".split(" ")],
  ["clothing", "shirt coat jacket dress skirt pants jeans shoe boot sock hat scarf glove belt".split(" ")],
  ["science", "science atom molecule energy gravity planet space earth chemistry biology physics cell metal plastic electricity magnet".split(" ")],
  ["sport", "sport game soccer football basketball baseball tennis golf hockey swimming running race boxing wrestling".split(" ")],
  ["technology", "computer phone screen keyboard internet website camera robot code app television radio".split(" ")],
  ["place", "city town village country school hospital office store market restaurant hotel library church museum park farm".split(" ")],
  ["emotion", "happy sad angry afraid love joy hope fear surprise calm laugh cry smile".split(" ")],
  ["action", "run walk jump swim fly climb sleep eat drink cook read write speak listen look build break play work drive".split(" ")],
  ["time", "time day night morning evening week month year today tomorrow yesterday hour minute calendar".split(" ")],
];

const subgroups: Array<[string, string[]]> = [
  ["pet", "cat dog rabbit parrot turtle goldfish".split(" ")],
  ["farm", "cow sheep goat pig chicken duck horse".split(" ")],
  ["wild", "lion tiger bear wolf fox deer eagle owl hawk".split(" ")],
  ["sea", "whale dolphin shark octopus seal crab lobster salmon tuna ocean sea beach ship boat".split(" ")],
  ["fruit", "apple orange banana lemon lime grape strawberry blueberry cherry peach pear melon pineapple mango coconut".split(" ")],
  ["vegetable", "tomato potato carrot onion garlic lettuce spinach broccoli corn".split(" ")],
  ["sweet", "cookie cake chocolate honey sugar strawberry blueberry".split(" ")],
  ["cooking", "bread pasta pizza burger sandwich cheese butter egg soup salad rice pan pot oven fridge".split(" ")],
  ["furniture", "chair table desk sofa bed lamp shelf mirror carpet".split(" ")],
  ["kitchenware", "cup plate bowl fork spoon knife pan pot oven fridge".split(" ")],
  ["waterway", "river lake ocean sea".split(" ")],
  ["woodland", "tree forest flower grass leaf root seed".split(" ")],
  ["sky", "sun moon star cloud rain snow wind storm thunder lightning rainbow fog airplane helicopter rocket".split(" ")],
  ["vehicle", "car truck bus taxi motorcycle scooter".split(" ")],
  ["rail", "train subway".split(" ")],
  ["human", "head face eye ear nose mouth tooth tongue neck shoulder arm hand finger chest heart stomach back leg knee foot skin hair brain bone blood".split(" ")],
  ["instrument", "guitar piano drum violin trumpet flute".split(" ")],
  ["clothing_upper", "shirt coat jacket dress".split(" ")],
  ["clothing_lower", "skirt pants jeans shoe boot sock".split(" ")],
  ["space", "planet space earth moon star sun".split(" ")],
  ["school", "school library book read write".split(" ")],
  ["health", "hospital doctor nurse heart blood".split(" ")],
  ["digital", "computer phone screen keyboard internet website code app".split(" ")],
  ["outdoors", "park farm field meadow forest mountain hill valley".split(" ")],
  ["feeling_positive", "happy love joy hope calm smile laugh".split(" ")],
  ["feeling_negative", "sad angry afraid fear cry".split(" ")],
  ["movement", "run walk jump swim fly climb drive".split(" ")],
  ["communication", "speak listen look read write song music radio television".split(" ")],
];

const dimensions = [...groups.map(([name]) => `topic:${name}`), ...subgroups.map(([name]) => `context:${name}`)];
const dimensionIndex = new Map(dimensions.map((name, index) => [name, index]));
type WordVector = number[] | Float32Array;
const vectors = new Map<string, WordVector>();

function addDimension(word: string, key: string, weight: number): void {
  const vector = vectors.get(word) ?? Array(dimensions.length).fill(0);
  const index = dimensionIndex.get(key);
  if (index !== undefined) vector[index] += weight;
  vectors.set(word, vector);
}

for (const [name, words] of groups) {
  for (const word of words) addDimension(word, `topic:${name}`, 1);
}
for (const [name, words] of subgroups) {
  for (const word of words) addDimension(word, `context:${name}`, 1.25);
}

// Numberbatch includes commonsense relationships as well as corpus embeddings.
// A pinned manifest prevents a partial data rebuild from silently mixing rows.
const pretrainedVectorsPath = new URL("./local-vectors.bin", import.meta.url);
const pretrainedWordsPath = new URL("./local-vocab.json", import.meta.url);
const modelPath = new URL("./semantic-model.json", import.meta.url);
let model: { id: string; label: string; license?: string; vectorSha256?: string; vocabSha256?: string; targetSha256?: string; dimensions?: number; vocabularySize?: number } = { id: "seed-v1", label: "Starter word associations" };
if ([pretrainedVectorsPath, pretrainedWordsPath, modelPath].some(existsSync)) {
  if (![pretrainedVectorsPath, pretrainedWordsPath, modelPath].every(existsSync)) throw new Error("Local semantic data is incomplete. Run npm run setup:vectors.");
  model = JSON.parse(readFileSync(modelPath, "utf8"));
  const pretrainedWords = JSON.parse(readFileSync(pretrainedWordsPath, "utf8")) as string[];
  const pretrainedBuffer = readFileSync(pretrainedVectorsPath);
  const dimensionCount = 300;
  if (model.dimensions !== dimensionCount || model.vocabularySize !== pretrainedWords.length || pretrainedWords.length < 1_000
    || new Set(pretrainedWords).size !== pretrainedWords.length || pretrainedWords.some((word) => !/^[a-z]{3,20}$/.test(word))
    || pretrainedBuffer.byteLength !== pretrainedWords.length * dimensionCount * Float32Array.BYTES_PER_ELEMENT
    || createHash("sha256").update(pretrainedBuffer).digest("hex") !== model.vectorSha256
    || createHash("sha256").update(readFileSync(pretrainedWordsPath)).digest("hex") !== model.vocabSha256) {
    throw new Error("Local semantic data failed verification. Run npm run setup:vectors again.");
  }
  const allPretrainedVectors = new Float32Array(pretrainedBuffer.buffer, pretrainedBuffer.byteOffset, pretrainedBuffer.byteLength / Float32Array.BYTES_PER_ELEMENT);
  vectors.clear();
  pretrainedWords.forEach((word, index) => {
    if (/^[a-z]{3,20}$/.test(word)) vectors.set(word, allPretrainedVectors.subarray(index * dimensionCount, (index + 1) * dimensionCount));
  });
  if (vectors.size < 1_000) {
    throw new Error("Local semantic vocabulary is incomplete. Run npm run setup:vectors again.");
  }
}
export const semanticModel = { id: model.id, label: model.label, license: model.license };
export const contextPoolId = model.targetSha256 || "seed-v1";

export const lexicon = [...vectors.keys()].sort();
export const wordVectors: ReadonlyMap<string, ArrayLike<number>> = vectors;

const norms = new Map<string, number>();
for (const [word, vector] of vectors) {
  norms.set(word, Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)));
}

function cosine(a: ArrayLike<number>, b: ArrayLike<number>, normA: number, normB: number): number {
  if (!normA || !normB) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i];
  return dot / (normA * normB);
}

const rankingCache = new Map<string, Map<string, number>>();

export function getWordSimilarity(targetInput: string, guessInput: string): number | null {
  const target = normalizeWord(targetInput);
  const guess = normalizeWord(guessInput);
  if (!vectors.has(target) || !vectors.has(guess)) return null;
  if (target === guess) return 1;
  return Math.max(-1, Math.min(1, cosine(vectors.get(target)!, vectors.get(guess)!, norms.get(target)!, norms.get(guess)!)));
}

export function getWordRank(targetInput: string, guessInput: string): number | null {
  const target = normalizeWord(targetInput);
  const guess = normalizeWord(guessInput);
  if (!vectors.has(target) || !vectors.has(guess)) return null;
  let ranks = rankingCache.get(target);
  if (ranks) { rankingCache.delete(target); rankingCache.set(target, ranks); }
  if (!ranks) {
    const targetVector = vectors.get(target)!;
    const targetNorm = norms.get(target)!;
    const ranked = lexicon
      .map((word) => ({ word, score: cosine(targetVector, vectors.get(word)!, targetNorm, norms.get(word)!) }))
      .sort((a, b) => b.score - a.score || Number(b.word === target) - Number(a.word === target) || a.word.localeCompare(b.word));
    ranks = new Map(ranked.map((entry, index) => [entry.word, index + 1]));
    rankingCache.set(target, ranks);
    if (rankingCache.size > 16) rankingCache.delete(rankingCache.keys().next().value!);
  }
  return ranks.get(guess) ?? null;
}

export function normalizeWord(value: string): string {
  return value.trim().toLocaleLowerCase("en-US").replace(/[^a-z'-]/g, "");
}

export function isSupportedWord(value: string): boolean {
  return vectors.has(normalizeWord(value));
}

// Restrict round targets to common nouns while keeping the full vocabulary
// available for guesses and similarity ranking.
const seedTargets = ["ocean", "forest", "pizza", "guitar", "computer", "rainbow", "tiger", "mountain", "coffee", "planet", "garden", "school"];
const contextTargetsPath = new URL("./context-targets.json", import.meta.url);
export type ContextDifficulty = "easy" | "normal" | "hard";
if (model.targetSha256 && (!existsSync(contextTargetsPath) || createHash("sha256").update(readFileSync(contextTargetsPath)).digest("hex") !== model.targetSha256)) throw new Error("The answer pools do not match the installed semantic model. Run npm run setup:vectors.");
const targetData = existsSync(contextTargetsPath) ? JSON.parse(readFileSync(contextTargetsPath, "utf8")) : null;
const fallbackTargets = (Array.isArray(targetData) ? targetData : seedTargets).filter((word: string) => vectors.has(word));
export const contextDifficultyPools: Record<ContextDifficulty, string[]> = Object.fromEntries(
  ["easy", "normal", "hard"].map((difficulty) => [difficulty, Array.isArray(targetData?.[difficulty])
    ? targetData[difficulty].filter((word: string) => vectors.has(word)) : [...fallbackTargets]])
) as Record<ContextDifficulty, string[]>;
export const contextWordPool: string[] = [...new Set(Object.values(contextDifficultyPools).flat())];
export function targetDifficulty(word: string): ContextDifficulty {
  return (["easy", "normal", "hard"] as const).find((difficulty) => contextDifficultyPools[difficulty].includes(word)) || "normal";
}

export const wordleAnswers = [
  "apple", "beach", "bread", "chair", "charm", "cloud", "dance", "dream", "earth", "flame", "flour", "fruit", "ghost", "grape", "green",
  "heart", "house", "image", "juice", "lemon", "light", "magic", "music", "night", "ocean", "piano", "plant", "queen", "radio", "river",
  "smile", "snake", "sound", "space", "spoon", "stone", "storm", "sugar", "tiger", "train", "water", "whale", "world", "write", "zebra",
];

const extraWordleGuesses = `about above abuse actor acute adapt admit adopt adult after again agent agree ahead alarm album alert alien alike alive allow alone along alter among anger angle angry apart apple apply arena argue arise array aside asset audio audit avoid awake award aware badly baker bases basic basin basis batch beach began begin begun being below bench berry birth black blame blank blind block blood board boast bonus boost booth bound brain brand bread break breed brief bring broad broke brown brush build built buyer cable cabin camel candy carry catch cause cease chain chair charm chart chase cheap check cheer chest chief child china choir chose civil claim class clean clear clerk click climb clock close cloth cloud coach coast color comic corny count court cover crack craft crash crazy cream crime crisp cross crowd crown cruel curve cycle daily dairy dance death debut delay depth devil diary dirty doubt dozen draft drama dream dress drill drink drive drove dying eager early earth eight elite empty enemy enjoy enter equal error event every exact exist extra faith false fault fiber field fifth fifty fight final first fixed flame flash fleet floor fluid focus force forth forty found frame frank fraud fresh front fruit fully funny giant given glass globe going grace grade grand grant grass grave great green greet grief gross group grown guard guess guest guide habit happy heart heavy hence horse hotel house human ideal image index inner input issue ivory jealous jelly joint judge juice kneel knife known label labor large laser later laugh layer learn least leave legal lemon level light limit linen liver local logic loose lower lucky magic major maker march match maybe mayor meant medal media mercy metal meter might minor model money month moral motor mount mouse mouth movie music never night noise north noted novel nurse occur ocean offer often olive onion opera order other ought owner paint panel paper party peace phase phone photo piano piece pilot pitch place plain plane plant plate point pound power press price pride prime print prior prize prove queen quick quiet quite radio raise range rapid ratio reach react ready refer right rival river roast robot rocky roman roof rough round route royal rural saint salad salty scale scare scene scope score sense serve seven shade shake shall shame shape share sharp sheep sheet shelf shell shift shine shirt shock shoot short shout shown since skill sleep slice slide slope small smart smile smoke snake solid solve sorry sound south space spare speak speed spell spend spent spice spill split sport spray squad stack staff stage stake stand start state steam steel steep stick still stock stone stood store storm story strip stuck study stuff sugar suite super sweet table taken taste teach teeth thank their theme there thick thing think third those three threw throw thumb tiger tight timer tired title today tooth topic total touch tough tower track trade train treat trend trial tried truck truly trust truth twice uncle under union unity until upper upset urban usage usual valid value video virus visit vital voice waste watch water wheel where which while white whole whose woman women world worry worse worst worth would write wrong wrote yield young youth`.split(/\s+/);

export const wordleWords = [...new Set([...wordleAnswers, ...extraWordleGuesses])];

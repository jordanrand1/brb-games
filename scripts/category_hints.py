"""Build broad hint labels from WordNet noun senses and reviewed overrides."""
import argparse
import hashlib
import json
import re
import zipfile
from functools import lru_cache
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LABELS = {
    "animals": "Animals & wildlife", "plants": "Plants & gardens",
    "food": "Food & drink", "sports": "Sports & games",
    "music": "Music & sound", "clothing": "Clothing & accessories",
    "transport": "Transport & travel", "home": "Home & furniture",
    "tools": "Tools & technology", "places": "Buildings & places",
    "body": "Body & health", "nature": "Nature & weather",
    "materials": "Materials & substances", "objects": "Objects & equipment",
    "arts": "Arts & entertainment",
    "people": "People & roles",
}
ALTERNATIVES = {
    "plants": "Nature & outdoors", "music": "Arts & entertainment",
    "clothing": "Things people wear", "home": "Everyday objects",
    "tools": "Making & fixing things", "places": "Places people use",
    "body": "People & living things", "nature": "The natural world",
    "materials": "What things are made of",
}
ROOTS = [
    ("music", ["musical_instrument"]),
    ("sports", ["sports_equipment", "game_equipment"]),
    ("clothing", ["clothing", "jewelry", "footwear"]),
    ("transport", ["vehicle", "aircraft", "road", "railway", "watercraft"]),
    ("home", ["furniture", "home_appliance", "kitchen_utensil", "bedding"]),
    ("body", ["medical_instrument", "medicine"]),
    ("tools", ["tool", "electronic_equipment", "electronic_device", "computer"]),
    ("places", ["structure", "room"]),
]
OVERRIDES = {
    "sports": "infield outfield centerfield leftfield ballpark baseball football basketball tennis golf hockey cricket stadium dugout scoreboard fairway skateboard ski ball puck bat racket trophy medal beachball",
    "food": "whiskey whisky brandy sherry martini champagne beer wine liquor alcohol beverage sushi snack ice loaf noodle cereal gum dough cream flour spice fruit milk juice tea coffee water",
    "music": "music guitar piano drum violin trumpet flute bell microphone speaker radio record harp fiddle banjo xylophone bagpipe jukebox loudspeaker amplifier stereo headphones earphone drumhead",
    "clothing": "watch pocket button zipper sunglasses cuff sleeve collar strap crown stocking wig uniform robe gown helmet scarf hat belt jeans pants glove shoe boot sock necktie jewelry",
    "home": "pew bench sofa couch chair table desk bed shelf mirror lamp carpet blanket pillow cushion mattress towel curtain drawer closet cabinet sink toilet shower bathtub fridge oven pan pot cup bowl plate fork spoon knife candle vase basket bucket pail jar bottle comb soap toothbrush toothpaste broom mop garbage wastebasket dustbin bin",
    "body": "coffin casket tomb grave gravestone graveyard cemetery corpse morgue mortuary mausoleum medication pill vaccine insulin virus bacteria parasite flea leech steroid serum antibiotic thyroid hormone",
    "tools": "computer keyboard screen laptop phone tablet monitor printer camera robot cable battery charger remote antenna calculator compass timer clock flashlight generator sensor drone circuit radar sonar telescope microscope transmitter transistor",
    "transport": "bridge tunnel station airport harbor port dock pier wharf shipyard freeway highway alley driveway pavement sidewalk crossroad junction turnpike runway cockpit axle brake engine tire wheel rail railroad railway locomotive rocket sail",
    "places": "house home apartment kitchen bedroom bathroom classroom building garage fence gate chimney fireplace roof door window ceiling floor stairs wall residence loft cabin cottage hut shack greenhouse barn farmhouse palace castle fort fortress tower church chapel cathedral abbey monastery convent synagogue shrine temple pulpit chancel altar nursery schoolhouse boardinghouse dormitory shelter",
    "nature": "rainbow rain snow wind storm thunder lightning fog blizzard monsoon hurricane tornado breeze snowfall rainfall drizzle hail sunshine sunlight moonlight starlight sunlight sun moon star planet earth world galaxy cosmos universe comet meteor meteorite air ice fire smoke cloud wave flood tide",
    "plants": "rose palm moss pine maple willow elm oak beech poppy violet daisy tulip sunflower dandelion cactus fern flower grass leaf root seed bud bark vine algae seaweed shrub tree acorn pinecone clover pollen petal",
    "arts": "painting picture photo photograph snapshot portrait sculpture sketch mosaic collage pottery carving crayon paint chalk book paperback notebook paper letter envelope stamp map flag diagram banner ribbon puppet toy doll puzzle kite balloon sandcastle",
}
# Familiar meanings take precedence over dictionary homonyms (a turtle can
# also be a sweater, a seal a stamp, and tuna a cactus). Keep these explicit.
REVIEWED = {
    "animals": "cat dog rabbit horse cow sheep goat pig chicken duck goose turkey eagle owl hawk parrot penguin whale dolphin shark octopus seal turtle frog snake lizard crocodile lion tiger bear wolf fox deer mouse rat squirrel bee butterfly spider ant crab lobster salmon trout tuna elephant giraffe zebra monkey gorilla kangaroo panda blowfish sardine oyster clam feather beak claw snout tail hoof wing mane beehive feeder",
    "plants": "hyacinth gourd",
    "nature": "forest garden snowball dew icicle saltwater seawater soil meadow snowman shell seashell twig splinter",
    "materials": "gold silver wool silk cotton leather cashmere fabric satin linen flannel cloth velvet mulch alloy",
    "places": "school museum village zoo warehouse country farm orchard vineyard market laboratory gym cinema studio ranch backyard corridor passageway doorway hallway depot courtyard ditch footpath roadside pathway lane trench mine shed nursery",
    "transport": "bus train van raft wagon windshield handlebar propeller rotor rudder mast motor horn hubcap fender cab tailgate ramp elevator",
    "home": "lid rug bath mat tray wineglass dish utensil coffeepot bookshelf bunk furnace radiator microwave cupboard hoop heater lamp chandelier burner boiler jug thermos flask canteen",
    "clothing": "skirt sandal slipper sneaker shoelace shoestring cloak coat seam stitch lipstick eyeshadow makeup mascara handkerchief bracelet ring laundry hem",
    "tools": "nail hammer anvil ladder pen pencil blackboard typewriter sundial thermometer thermostat device detector binoculars telescope television machine machinery motor magnet lens magnet torch instrument satellite headlight pipe plumbing turbine nozzle valve lever screw hardware tripod sieve",
    "arts": "leaflet watercolor easel figurine statue ornament scenery canvas silhouette yarn wreath bouquet",
    "body": "heart rib vitamin aspirin bandage crutch wheelchair denture lotion",
    "food": "apple orange banana lemon lime grape strawberry blueberry cherry peach pear melon pineapple mango coconut avocado tomato potato carrot onion garlic lettuce spinach broccoli corn rice bread pasta pizza burger sandwich cheese butter egg soup salad cookie cake chocolate honey sugar salt pepper coffee tea milk juice cereal sausage bacon yogurt cream toast flour bean pea nut peanut almond mushroom pancake waffle noodle popcorn donut cupcake candy pumpkin cucumber cabbage celery apricot plum beef pork poultry walnut nectar sourdough wafer lentil oat barley wheat grain lager",
    "people": "queen giant",
    "objects": "coffin casket urn container vessel",
}


def generate(archive_path: Path, targets: dict) -> bytes:
    with zipfile.ZipFile(archive_path) as archive:
        synsets, senses = {}, {}
        for line in archive.read("wordnet/data.noun").decode().splitlines():
            if not line or not line[0].isdigit():
                continue
            f = line.split("|", 1)[0].split()
            start = 4 + 2 * int(f[3], 16)
            pointers = [f[start + 2 + i * 4] for i in range(int(f[start])) if f[start + 1 + i * 4] in ("@", "@i")]
            synsets[f[0]] = (int(f[1]), pointers)
        for line in archive.read("wordnet/index.sense").decode().splitlines():
            key, offset, sense, count = line.split()
            lemma, detail = key.rsplit("%", 1)
            if detail[0] != "1":
                continue
            candidate = (int(count), -int(sense), lemma.islower(), offset)
            word = lemma.lower()
            if word not in senses or candidate > senses[word]:
                senses[word] = candidate
    @lru_cache(None)
    def ancestors(offset):
        return frozenset([offset]).union(*(ancestors(parent) for parent in synsets[offset][1]))
    roots = [(category, {senses[word][3] for word in words if word in senses}) for category, words in ROOTS]
    overrides = {word: category for category, words in OVERRIDES.items() for word in words.split()}
    overrides.update({word: category for category, words in REVIEWED.items() for word in words.split()})
    hints = {}
    for word in sorted(set(targets["easy"] + targets["normal"] + targets["hard"])):
        category = overrides.get(word)
        if not category:
            if word not in senses:
                raise RuntimeError(f"Add a reviewed category override for {word}.")
            offset = senses[word][3]
            lex = synsets[offset][0]
            category = {5: "animals", 8: "body", 13: "food", 15: "places", 17: "nature", 19: "nature", 20: "plants", 27: "materials"}.get(lex)
            if not category:
                lineage = ancestors(offset)
                category = next((label for label, ids in roots if lineage & ids), "objects")
        label = LABELS[category]
        if word in re.findall(r"[a-z]+", label.lower()):
            label = ALTERNATIVES.get(category, "Everyday things")
        hints[word] = label
    return (json.dumps({"version": 1, "categories": hints}, indent=2) + "\n").encode()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--wordnet-zip", type=Path, required=True)
    args = parser.parse_args()
    data = generate(args.wordnet_zip, json.loads((ROOT / "src/context-targets.json").read_text()))
    (ROOT / "src/context-categories.json").write_bytes(data)
    path = ROOT / "src/semantic-model.json"
    manifest = json.loads(path.read_text())
    manifest["categorySha256"] = hashlib.sha256(data).hexdigest()
    path.write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"Built local category hints for {len(json.loads(data)['categories'])} answers.")

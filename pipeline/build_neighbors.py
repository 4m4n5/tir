#!/usr/bin/env python3
"""
tir word-engine pipeline
========================
1. Curate a ~2k game-worthy English vocabulary (common, concrete words)
2. Load pre-trained GloVe embeddings (word co-occurrence based, not character-level)
3. For each word, compute top-50 nearest neighbors by cosine similarity
4. Filter out lexically-similar neighbors (shared prefix/suffix noise)
5. Write the neighbor graph to JSON (+ optional Firestore upload)

Usage:
    pip install -r requirements.txt
    python build_neighbors.py                      # build + write JSON
    python build_neighbors.py --upload             # build + upload to Firestore
    python build_neighbors.py --vocab-only         # just write the curated vocab
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path

import numpy as np
from tqdm import tqdm

SCRIPT_DIR = Path(__file__).parent
OUT_DIR = SCRIPT_DIR / "out"
VOCAB_FILE = OUT_DIR / "vocab.json"
NEIGHBORS_FILE = OUT_DIR / "neighbors.json"

TOP_K = 50
MIN_WORD_LEN = 3
MAX_WORD_LEN = 10

# GloVe model — trained on Wikipedia + Gigaword corpus.
# Word co-occurrence captures semantic similarity, not character patterns.
GLOVE_NAME = "glove-wiki-gigaword-300"

# Frequency filter: GloVe line number is a rough proxy for word commonness.
# Lower rank = more common in the training corpus (Wikipedia + Gigaword).
# 60k keeps all everyday words while cutting genuinely obscure vocabulary
# like "fumarole", "grimoire", "astrolabe", "brigantine", "sconce".
# Well-known words above the cutoff are preserved via FREQUENCY_ALLOWLIST.
MAX_GLOVE_RANK = 60_000

FREQUENCY_ALLOWLIST = {
    "donut", "igloo", "chipmunk", "icicle", "seahorse", "croissant",
    "xylophone", "quicksand", "drawbridge", "ember", "hyena", "gazebo",
    "gargoyle", "marigold", "amethyst", "streamer",
}

BLOCKLIST = {
    "ass", "damn", "hell", "crap", "slut", "whore", "bitch", "bastard",
    "dick", "cock", "pussy", "fuck", "shit", "piss", "tit", "tits",
    "boob", "boobs", "nude", "naked", "porn", "sex", "sexy", "rape",
    "kill", "murder", "suicide", "die", "dies", "dead", "death",
    "drug", "drugs", "weed", "meth", "heroin", "cocaine",
    "gun", "guns", "bomb", "bombs", "weapon", "weapons",
    "slave", "slaves", "nazi", "nazis",
}

# Curated vocabulary: common, concrete, well-known words grouped by domain.
# Every word here should be recognized by a typical English speaker.
SEED_WORDS = [
    # --- Nature & landscape ---
    "ocean", "river", "lake", "stream", "waterfall", "pond", "creek",
    "mountain", "hill", "valley", "canyon", "cliff", "cave", "ridge",
    "forest", "jungle", "meadow", "prairie", "desert", "island", "beach",
    "tree", "leaf", "branch", "root", "flower", "seed", "vine", "moss",
    "stone", "rock", "pebble", "boulder", "crystal", "gem", "diamond",
    "sun", "moon", "star", "sky", "cloud", "rain", "snow", "ice",
    "wind", "storm", "thunder", "lightning", "fog", "mist", "dew",
    "fire", "flame", "ember", "spark", "smoke", "ash",
    "earth", "soil", "sand", "dust", "mud", "clay",
    "volcano", "glacier", "geyser", "lava", "reef", "lagoon",
    "oasis", "dune", "swamp", "marsh", "delta",
    "grove", "orchard", "hedge", "canopy",
    "tide", "surf", "wave", "current",

    # --- Animals ---
    "wolf", "fox", "bear", "deer", "rabbit", "squirrel", "mouse",
    "eagle", "hawk", "owl", "crow", "robin", "sparrow", "swan",
    "whale", "dolphin", "shark", "fish", "salmon", "turtle", "frog",
    "snake", "lizard", "dragon", "horse", "lion", "tiger", "panther",
    "cat", "dog", "puppy", "kitten", "bird", "bee", "ant", "spider",
    "butterfly", "moth", "beetle", "worm",
    "falcon", "pelican", "penguin", "parrot", "peacock",
    "leopard", "cheetah", "gorilla", "monkey", "panda", "koala",
    "octopus", "jellyfish", "starfish", "crab", "lobster", "oyster",
    "stork", "crane", "heron", "flamingo",
    "elephant", "giraffe", "zebra", "hippo", "rhino", "camel",
    "buffalo", "moose", "elk", "otter", "seal", "walrus",
    "pigeon", "seagull", "woodpecker", "cardinal",

    # --- Food & drink ---
    "bread", "cake", "cookie", "pie", "soup", "stew", "salad",
    "apple", "orange", "lemon", "cherry", "grape", "peach", "plum",
    "berry", "melon", "banana", "mango", "coconut", "pineapple",
    "rice", "pasta", "noodle", "pizza", "burger", "taco", "sandwich",
    "cheese", "butter", "cream", "milk", "honey", "sugar", "salt",
    "pepper", "spice", "garlic", "onion", "tomato", "potato",
    "coffee", "tea", "juice", "wine", "water", "soda", "lemonade",
    "chocolate", "candy", "caramel", "vanilla", "cinnamon",
    "bacon", "steak", "chicken", "shrimp", "lobster",
    "waffle", "pancake", "donut", "muffin", "pretzel",
    "avocado", "broccoli", "carrot", "celery", "spinach", "mushroom",
    "olive", "almond", "walnut", "peanut", "cashew",
    "yogurt", "oatmeal", "cereal", "granola",

    # --- Home & objects ---
    "house", "home", "room", "door", "window", "wall", "floor",
    "roof", "garden", "fence", "gate", "bridge", "tower", "castle",
    "chair", "table", "bed", "lamp", "mirror", "clock", "candle",
    "book", "page", "letter", "pen", "ink", "paper", "envelope",
    "key", "lock", "ring", "chain", "rope", "thread", "needle",
    "bell", "drum", "horn", "piano", "guitar", "violin", "flute",
    "cup", "bowl", "plate", "spoon", "fork", "knife", "bottle",
    "basket", "box", "bag", "chest", "trunk",
    "blanket", "pillow", "curtain", "carpet", "shelf", "drawer",
    "oven", "stove", "fridge", "sink", "bathtub", "shower",
    "couch", "desk", "bench", "stool", "cabinet",
    "television", "radio", "phone", "camera", "computer", "keyboard",
    "umbrella", "suitcase", "backpack", "wallet", "purse",

    # --- Body & senses ---
    "heart", "hand", "eye", "ear", "mouth", "tooth", "bone",
    "blood", "skin", "hair", "voice", "breath", "smile",
    "dream", "sleep", "sight", "sound", "touch", "taste",
    "brain", "muscle", "shoulder", "elbow", "wrist", "ankle",
    "finger", "thumb", "palm", "fist", "skull",

    # --- Emotions & abstract ---
    "love", "hope", "fear", "joy", "peace", "calm", "rage",
    "pride", "shame", "grief", "trust", "doubt", "wonder", "awe",
    "truth", "wisdom", "grace", "charm", "power", "glory", "honor",
    "magic", "spell", "myth", "tale", "legend", "story", "song",
    "dance", "rhythm", "echo", "silence", "whisper", "shout",
    "freedom", "courage", "patience", "kindness", "mystery",
    "fortune", "luck", "fate", "destiny", "memory", "secret",
    "adventure", "journey", "voyage", "quest",

    # --- Weather & time ---
    "spring", "summer", "autumn", "winter", "dawn", "dusk", "noon",
    "night", "morning", "evening", "sunset", "sunrise", "twilight",
    "frost", "blizzard", "breeze", "hurricane", "tornado", "drought",
    "rainbow", "haze", "humidity",

    # --- Colors & light ---
    "red", "blue", "green", "yellow", "orange", "purple", "pink",
    "black", "white", "gray", "gold", "silver", "bronze", "copper",
    "light", "shadow", "glow", "shine", "flash", "sparkle",
    "dark", "bright", "crimson", "scarlet", "turquoise", "indigo",

    # --- Actions & movement ---
    "run", "walk", "jump", "climb", "swim", "fly", "fall",
    "spin", "twist", "slide", "roll", "drift", "float", "sink",
    "push", "pull", "throw", "catch", "hold", "drop", "lift",
    "break", "build", "grow", "shrink", "stretch", "bend", "fold",
    "cut", "carve", "paint", "draw", "write", "read", "sing",
    "cook", "bake", "brew", "stir", "pour", "mix", "blend",
    "hunt", "chase", "hide", "seek", "find", "search",
    "whistle", "clap", "snap", "stomp", "wave",
    "scatter", "gather", "stack", "wrap", "unwrap",

    # --- Places & travel ---
    "city", "town", "village", "road", "path", "trail", "street",
    "park", "field", "farm", "barn", "mill", "market", "shop",
    "port", "harbor", "dock", "ship", "boat", "sail", "anchor",
    "train", "track", "station", "car", "wheel", "engine",
    "temple", "church", "palace", "throne", "crown", "sword", "shield",
    "arena", "stage", "tent", "cabin", "lodge", "inn",
    "airport", "runway", "highway", "tunnel", "subway",
    "museum", "library", "hospital", "school", "university",
    "restaurant", "bakery", "pharmacy", "theater",
    "lighthouse", "fountain", "statue", "monument",
    "alley", "plaza", "courtyard", "balcony", "terrace",

    # --- Materials & textures ---
    "wood", "metal", "iron", "steel", "glass", "silk", "wool",
    "cotton", "leather", "velvet", "linen", "jade", "marble", "ivory",
    "wax", "rubber", "plastic", "foam", "rust",
    "concrete", "brick", "ceramic", "porcelain", "granite",
    "bamboo", "cedar", "oak", "pine", "willow", "birch", "elm",

    # --- Science & cosmos ---
    "planet", "comet", "orbit", "galaxy", "nebula", "aurora",
    "atom", "pulse", "beam", "prism", "lens",
    "magnet", "gravity", "voltage", "signal", "radar",
    "rocket", "satellite", "meteor", "asteroid",
    "telescope", "microscope", "laboratory", "experiment",
    "energy", "oxygen", "hydrogen", "carbon", "nitrogen",
    "fossil", "mineral", "element",

    # --- Clothing & accessories ---
    "crown", "flag", "medal", "trophy", "badge", "stamp", "coin",
    "mask", "cloak", "cape", "hat", "boot", "glove", "scarf",
    "jacket", "sweater", "shirt", "dress", "skirt",
    "helmet", "armor", "belt", "necklace", "bracelet", "earring",
    "ribbon", "buckle", "zipper", "button",
    "sunglasses", "sneaker", "sandal", "slipper",

    # --- Tools & weapons ---
    "arrow", "bow", "spear", "dagger", "hammer", "axe",
    "torch", "lantern", "compass", "map",
    "feather", "shell", "coral", "pearl", "amber",
    "chisel", "anvil", "forge", "kiln", "furnace",
    "wrench", "pliers", "screwdriver", "drill", "shovel",
    "ladder", "crane", "pulley", "lever",

    # --- Nature details ---
    "nest", "web", "hive", "burrow", "den",
    "puzzle", "maze", "riddle", "code",
    "gift", "prize", "reward", "token",
    "knot", "loop", "spiral", "arch", "dome", "vault",
    "icicle", "petal", "thorn", "acorn", "pinecone",
    "mushroom", "seaweed", "driftwood", "quicksand",

    # --- Plants & flowers ---
    "rose", "lily", "tulip", "daisy", "orchid", "lotus", "iris",
    "cactus", "fern", "ivy", "clover", "thistle", "sunflower",
    "lavender", "jasmine", "magnolia", "marigold",

    # --- Gems & precious ---
    "ruby", "emerald", "sapphire", "topaz", "opal",
    "quartz", "obsidian", "turquoise",

    # --- Roles & people ---
    "pilot", "sailor", "knight", "wizard", "archer", "scout",
    "captain", "warrior", "queen", "king", "prince", "princess",
    "pirate", "explorer", "shepherd", "farmer", "hunter",
    "artist", "musician", "dancer", "singer", "poet",
    "chef", "baker", "blacksmith", "carpenter", "inventor",
    "detective", "guardian", "champion", "villain", "hero",

    # --- Music & art ---
    "canvas", "sculpture", "painting", "portrait", "sketch",
    "melody", "harmony", "chorus", "symphony", "tempo",
    "opera", "ballet", "carnival", "festival", "parade",
    "theater", "cinema", "screenplay", "novel",

    # --- Sports & games ---
    "soccer", "basketball", "baseball", "football", "tennis",
    "hockey", "volleyball", "golf", "boxing", "wrestling",
    "marathon", "sprint", "relay", "hurdle",
    "chess", "checkers", "dominoes", "billiards",
    "trophy", "medal", "stadium", "arena",

    # --- Transport ---
    "bicycle", "motorcycle", "airplane", "helicopter",
    "submarine", "canoe", "kayak", "raft", "ferry",
    "chariot", "carriage", "wagon", "sleigh",
    "parachute", "balloon", "glider",

    # --- Misc concrete ---
    "telescope", "binoculars", "thermometer", "hourglass",
    "chandelier", "fireplace", "chimney", "windmill",
    "scarecrow", "totem", "gargoyle", "mosaic",
    "tapestry", "quilt", "hammock", "swing",
    "trampoline", "seesaw", "sandbox",
    "aquarium", "greenhouse",
    "igloo", "pyramid", "pagoda",
    "labyrinth", "dungeon", "moat", "drawbridge",
    "treasure", "compass", "anchor", "rudder",
    "firework", "confetti", "balloon", "streamer",
    "photograph", "postcard", "souvenir", "artifact",
    "potion", "antidote", "remedy",
    "lantern", "torch", "beacon", "spotlight",
    "shadow", "silhouette", "reflection", "mirage",
    "avalanche", "earthquake", "tsunami", "eruption",
    "constellation", "eclipse", "horizon", "zenith",

    # --- Expansion: more nature ---
    "bluff", "gorge", "plateau", "summit", "tundra", "savanna",
    "cove", "inlet", "rapids", "brook", "spring",
    "clearing", "thicket", "woodland", "rainforest", "wetland",
    "pebble", "gravel", "sandstone", "limestone", "chalk",
    "coral", "kelp", "plankton",
    "aurora", "twilight", "dusk", "dawn", "midnight", "horizon",

    # --- Expansion: more animals ---
    "raven", "condor", "osprey", "vulture", "albatross",
    "stallion", "mare", "colt", "mustang",
    "cobra", "viper", "python", "iguana", "chameleon", "gecko",
    "jaguar", "cougar", "lynx", "hyena", "jackal", "badger",
    "hedgehog", "armadillo", "sloth", "lemur", "chipmunk",
    "salmon", "trout", "herring", "mackerel", "tuna",
    "scorpion", "mantis", "cricket", "dragonfly", "firefly",
    "catfish", "swordfish", "seahorse", "stingray", "eel",
    "dove", "nightingale", "canary", "kingfisher",
    "bison", "antelope", "gazelle", "reindeer",

    # --- Expansion: mythology & fantasy ---
    "phoenix", "griffin", "unicorn", "centaur", "mermaid",
    "goblin", "ogre", "troll", "dwarf", "titan",
    "sorcerer", "oracle", "prophet", "druid",
    "enchantment", "illusion", "phantom", "specter",
    "relic", "amulet", "talisman", "medallion",
    "scroll", "tome",
    "fortress", "citadel", "bastion",
    "moat", "drawbridge", "catapult", "siege",

    # --- Expansion: more food ---
    "raspberry", "blueberry", "cranberry", "strawberry",
    "apricot", "pomegranate", "watermelon", "papaya", "guava",
    "ginger", "saffron", "nutmeg",
    "sushi", "ramen", "curry",
    "pastry", "croissant",
    "espresso", "cocoa",
    "syrup", "jam", "vinegar", "mustard",
    "chestnut", "hazelnut", "pecan", "pistachio",

    # --- Expansion: music & instruments ---
    "cello", "harp", "banjo", "trumpet", "trombone",
    "clarinet", "accordion", "harmonica",
    "xylophone",
    "ballad", "anthem", "lullaby", "waltz",
    "sonata", "concerto", "overture", "prelude",

    # --- Expansion: architecture & structures ---
    "cathedral", "monastery", "chapel", "shrine",
    "spire", "turret",
    "aqueduct", "pier", "wharf",
    "pavilion",
    "attic", "cellar", "basement", "loft",
    "corridor", "hallway", "staircase", "archway",
    "colosseum", "amphitheater", "obelisk",

    # --- Expansion: ocean & maritime ---
    "anchor", "compass", "helm", "mast", "hull", "keel",
    "rudder",
    "frigate", "schooner",
    "buoy", "harbor", "marina", "shipyard",
    "lighthouse", "beacon",
    "captain", "admiral", "navigator",

    # --- Expansion: crafts & trades ---
    "pottery", "weaving", "embroidery", "calligraphy",
    "woodwork", "masonry",
    "loom", "spindle",
    "mallet",
    "mortar",

    # --- Expansion: weather & phenomena ---
    "monsoon", "typhoon", "cyclone", "tempest",
    "whirlwind", "gale", "gust",
    "drizzle", "downpour", "deluge", "sleet", "hail",
    "icicle", "frost", "permafrost",
    "mirage", "halo", "prism", "spectrum",
    "thunder", "lightning", "aurora",

    # --- Expansion: emotions & states ---
    "nostalgia", "euphoria", "serenity", "melancholy",
    "triumph", "bliss", "solitude", "longing",
    "dread", "fury", "envy", "compassion", "devotion",
    "ambition", "resilience", "gratitude", "humility",
    "curiosity", "inspiration", "obsession", "passion",
    "harmony", "chaos", "balance", "tension",

    # --- Expansion: time & seasons ---
    "century", "decade", "epoch", "era", "eternity",
    "moment", "instant", "twilight", "midnight", "equinox",
    "solstice", "harvest", "bloom",

    # --- Expansion: cosmos & space ---
    "supernova", "cosmos",
    "constellation", "crater", "void",
    "starlight", "moonlight", "sunbeam", "daybreak",
    "eclipse", "solstice", "equinox",

    # --- Expansion: fabrics & materials ---
    "satin", "denim", "canvas",
    "tweed", "cashmere", "flannel",
    "platinum", "titanium", "cobalt",
    "tin", "alloy", "ore",
    "amber", "onyx", "garnet", "amethyst",
    "coral", "mother-of-pearl",

    # --- Expansion: more tools & objects ---
    "compass",
    "pendulum",
    "hourglass",
    "quill", "parchment", "manuscript",
    "chandelier",
    "tapestry", "fresco", "mural",
    "garland", "wreath", "bouquet",

    # --- Expansion: games & leisure ---
    "archery", "fencing",
    "dice", "roulette", "poker",
    "carousel", "ferris", "roller",
    "kite", "yo-yo", "frisbee", "boomerang",
    "puzzle", "jigsaw", "crossword", "riddle",

    # --- Expansion: drinks & beverages ---
    "whiskey", "bourbon", "brandy",
    "champagne", "cider",
    "sake", "vodka", "tequila",

    # --- Expansion: professions ---
    "astronaut",
    "scribe", "ambassador",
    "merchant", "voyager", "nomad", "pilgrim",
    "gladiator", "samurai", "viking",
    "jester",

    # --- Expansion: nature phenomena ---
    "geyser",
    "cavern",
    "quicksand", "whirlpool",
    "erosion", "sediment", "fossil",
]


def curate_vocab(
    glove_vocab: set[str] | None = None,
    glove_ranks: dict[str, int] | None = None,
) -> list[str]:
    """
    Build a deduplicated, filtered, game-worthy vocabulary.
    Filters: must exist in GloVe, must not be too obscure (frequency rank
    below MAX_GLOVE_RANK unless in FREQUENCY_ALLOWLIST), must pass
    length/blocklist checks.
    """
    seen = set()
    vocab = []
    freq_rejected = []

    def add(w: str) -> bool:
        w = w.lower().strip()
        if not w or not w.isalpha():
            return False
        if len(w) < MIN_WORD_LEN or len(w) > MAX_WORD_LEN:
            return False
        if w in BLOCKLIST:
            return False
        if w in seen:
            return False
        if glove_vocab is not None and w not in glove_vocab:
            return False
        if (glove_ranks is not None
                and w not in FREQUENCY_ALLOWLIST
                and glove_ranks.get(w, 0) >= MAX_GLOVE_RANK):
            freq_rejected.append(w)
            return False
        seen.add(w)
        vocab.append(w)
        return True

    for w in SEED_WORDS:
        add(w)

    print(f"  Final vocab: {len(vocab)} words")
    skipped = len(set(w.lower() for w in SEED_WORDS)) - len(vocab)
    if skipped > 0:
        print(f"  ({skipped} words skipped: duplicates, blocked, not in GloVe, or wrong length)")
    if freq_rejected:
        print(f"  ({len(freq_rejected)} words rejected for obscurity: {', '.join(freq_rejected[:15])}{'…' if len(freq_rejected) > 15 else ''})")
    return sorted(vocab)


def load_glove_model(glove_path: str | None = None):
    """Load pre-trained GloVe vectors from a text file. Also returns line-number
    ranks (lower = more common in corpus) for frequency filtering."""
    if glove_path is None:
        glove_path = str(SCRIPT_DIR / "glove.6B.300d.txt")
    print(f"\nLoading GloVe vectors from {glove_path} ...")
    vectors: dict[str, np.ndarray] = {}
    ranks: dict[str, int] = {}
    with open(glove_path, "r", encoding="utf-8") as f:
        for i, line in enumerate(tqdm(f, desc="  Loading", unit=" words")):
            parts = line.rstrip().split(" ")
            word = parts[0]
            vec = np.array([float(x) for x in parts[1:]], dtype=np.float32)
            vectors[word] = vec
            ranks[word] = i
    dim = len(next(iter(vectors.values())))
    print(f"  Loaded {len(vectors)} word vectors, dim={dim}")
    return vectors, ranks


def lexical_overlap(a: str, b: str) -> float:
    """
    Compute character-level overlap ratio between two words.
    Returns 0.0 (no overlap) to 1.0 (identical).
    Uses longest common substring ratio.
    """
    if a == b:
        return 1.0
    short, long = (a, b) if len(a) <= len(b) else (b, a)
    if len(short) < 3:
        return 0.0

    # Shared prefix ratio
    prefix_len = 0
    for i in range(min(len(a), len(b))):
        if a[i] == b[i]:
            prefix_len += 1
        else:
            break
    prefix_ratio = prefix_len / max(len(a), len(b))

    # Shared suffix ratio
    suffix_len = 0
    for i in range(1, min(len(a), len(b)) + 1):
        if a[-i] == b[-i]:
            suffix_len += 1
        else:
            break
    suffix_ratio = suffix_len / max(len(a), len(b))

    # If one word contains the other
    if short in long:
        return len(short) / len(long)

    return max(prefix_ratio, suffix_ratio)


def compute_neighbors(
    vocab: list[str],
    model: dict[str, np.ndarray],
    top_k: int = TOP_K,
    max_lexical_overlap: float = 0.6,
) -> dict[str, list[dict]]:
    """
    For each word, find its top_k nearest neighbors by cosine similarity
    using GloVe embeddings. Filters out lexically-similar neighbors.
    """
    print(f"\nComputing top-{top_k} neighbors for {len(vocab)} words ...")

    # Build embedding matrix for our vocab
    embeddings = np.array([model[w] for w in vocab], dtype=np.float32)

    # L2 normalize for cosine similarity via dot product
    norms = np.linalg.norm(embeddings, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    embeddings = embeddings / norms

    N = len(vocab)
    neighbors: dict[str, list[dict]] = {}
    filtered_count = 0

    CHUNK = 500
    for start in tqdm(range(0, N, CHUNK)):
        end = min(start + CHUNK, N)
        chunk = embeddings[start:end]
        sims = chunk @ embeddings.T

        for i_local in range(end - start):
            i_global = start + i_local
            word = vocab[i_global]
            row = sims[i_local]
            row[i_global] = -1.0

            # Get more candidates than needed to allow for filtering
            fetch_k = min(top_k * 3, N - 1)
            top_indices = np.argpartition(row, -fetch_k)[-fetch_k:]
            top_indices = top_indices[np.argsort(row[top_indices])[::-1]]

            word_neighbors = []
            for idx in top_indices:
                neighbor = vocab[idx]
                overlap = lexical_overlap(word, neighbor)
                if overlap >= max_lexical_overlap:
                    filtered_count += 1
                    continue
                word_neighbors.append(
                    {"w": neighbor, "s": round(float(row[idx]), 4)}
                )
                if len(word_neighbors) >= top_k:
                    break

            neighbors[word] = word_neighbors

    print(f"  Filtered {filtered_count} lexically-similar neighbors total")
    return neighbors


"""
Target word auto-scoring criteria:
  1. Length >= 4 characters (no "run", "red", "cat")
  2. Full neighbor graph (50 neighbors)
  3. Average neighbor score in [0.19, 0.45] — connected but not over-clustered
  4. Top neighbor score >= 0.25 — at least one strong connection
  5. Not in the BAD_TARGET_CATEGORIES set (basic verbs, adjectives, etc.)
  6. "Reachability" — at least 5 words in the vocab have this word in their
     top-30 neighbors (ensures it's discoverable from multiple directions)

These thresholds are derived from empirical analysis of known good targets
(dragon=0.36, crystal=0.30, volcano=0.30) vs bad targets (butter=0.52,
tomato=0.51 — too clustered; tome=0.14, abacus=0.15 — too isolated).
"""

BAD_TARGET_CATEGORIES = {
    # Basic verbs
    "run", "walk", "jump", "climb", "swim", "fly", "fall", "spin", "twist",
    "slide", "roll", "drift", "float", "sink", "push", "pull", "throw",
    "catch", "hold", "drop", "lift", "cut", "carve", "paint", "draw",
    "write", "read", "sing", "cook", "bake", "brew", "stir", "pour", "mix",
    "blend", "hunt", "chase", "hide", "seek", "find", "search", "clap",
    "snap", "stomp", "scatter", "gather", "stack", "wrap", "unwrap",
    "whistle", "fold", "bend", "stretch", "shrink", "break", "build",
    "grow", "wave",
    # Colors / basic adjectives
    "red", "blue", "green", "yellow", "orange", "purple", "pink", "black",
    "white", "gray", "dark", "bright", "calm",
    # Too short / abstract
    "the", "and", "key", "pen", "ink", "cup", "box", "bag", "bed", "ear",
    "eye", "cut", "run", "fly", "ice", "mud", "dew", "fog", "wax", "ash",
    "den", "web", "bow", "axe", "hat", "oak", "elm", "ivy", "fern",
    "ant", "bee", "dog", "cat",
}

MIN_TARGET_LEN = 4
MIN_AVG_SCORE = 0.19
MAX_AVG_SCORE = 0.45
MIN_TOP_SCORE = 0.25
MIN_INBOUND_LINKS = 5

# Reachability filter: a target must appear as a STRONG semantic neighbor
# (in the top-K with cosine score >= score threshold) of at least N other
# vocab words. This is the most direct proxy for "from how many words can a
# player land on this target in a single move?". Words with a poisoned GloVe
# embedding (e.g. dominated by surnames or company names like "griffin",
# "anchor", "delta", "python") fail this check even when their raw avg/top
# scores look acceptable, because their nearest neighbors aren't actually
# semantically related to them.
STRONG_INBOUND_TOP_K = 15
STRONG_INBOUND_MIN_SCORE = 0.30
MIN_STRONG_INBOUND = 3


def score_targets(neighbors: dict[str, list[dict]]) -> list[dict]:
    """
    Auto-score every word in the vocab for target suitability.
    Returns a sorted list of {word, score, avg, top, inbound, strongIn} dicts.
    """
    print(f"\n=== Scoring {len(neighbors)} words for target suitability ===")

    # Pre-compute inbound link counts (how many words have this word as a neighbor).
    # `inbound` = soft inbound (any of top-30, any score). Used for ranking.
    # `strong_inbound` = strong inbound (top-K, score >= threshold). Used as
    # the principled reachability gate.
    inbound: dict[str, int] = {}
    strong_inbound: dict[str, int] = {}
    for word, nbrs in neighbors.items():
        for i, n in enumerate(nbrs[:30]):
            w = n["w"]
            inbound[w] = inbound.get(w, 0) + 1
            if i < STRONG_INBOUND_TOP_K and n["s"] >= STRONG_INBOUND_MIN_SCORE:
                strong_inbound[w] = strong_inbound.get(w, 0) + 1

    targets = []
    rejected = {"short": 0, "category": 0, "few_neighbors": 0, "avg_low": 0,
                "avg_high": 0, "top_low": 0, "inbound_low": 0, "unreachable": 0}

    for word, nbrs in neighbors.items():
        if len(word) < MIN_TARGET_LEN:
            rejected["short"] += 1
            continue
        if word in BAD_TARGET_CATEGORIES:
            rejected["category"] += 1
            continue
        if len(nbrs) < 50:
            rejected["few_neighbors"] += 1
            continue

        scores = [n["s"] for n in nbrs]
        avg = sum(scores) / len(scores)
        top = scores[0]
        ib = inbound.get(word, 0)
        sib = strong_inbound.get(word, 0)

        if avg < MIN_AVG_SCORE:
            rejected["avg_low"] += 1
            continue
        if avg > MAX_AVG_SCORE:
            rejected["avg_high"] += 1
            continue
        if top < MIN_TOP_SCORE:
            rejected["top_low"] += 1
            continue
        if ib < MIN_INBOUND_LINKS:
            rejected["inbound_low"] += 1
            continue
        # Reachability gate. FREQUENCY_ALLOWLIST overrides for genuinely common
        # words whose embedding happens to be sparse (e.g. "donut", "igloo").
        if sib < MIN_STRONG_INBOUND and word not in FREQUENCY_ALLOWLIST:
            rejected["unreachable"] += 1
            continue

        # Composite score: prefer moderate avg (sweet spot ~0.30), good
        # *strong* inbound (real reachability, not just any links), longer words.
        avg_sweetness = 1.0 - abs(avg - 0.30) / 0.15
        score = round(avg_sweetness * 0.4 + min(sib / 20, 1.0) * 0.3 + min(len(word) / 8, 1.0) * 0.3, 4)
        targets.append({"word": word, "score": score, "avg": round(avg, 4),
                         "top": round(top, 4), "inbound": ib, "strongIn": sib})

    targets.sort(key=lambda t: t["score"], reverse=True)

    print(f"  Valid targets: {len(targets)}")
    print(f"  Rejected: {rejected}")
    print(f"  Top 10: {', '.join(t['word'] for t in targets[:10])}")
    print(f"  Bottom 5: {', '.join(t['word'] for t in targets[-5:])}")
    return targets


def upload_to_firestore(neighbors: dict[str, list[dict]], targets: list[dict] | None = None, project_id: str = "tirapp-c596f") -> None:
    """Upload neighbor graph to Firestore as per-word documents."""
    import firebase_admin
    from firebase_admin import credentials, firestore

    if not firebase_admin._apps:
        project_dir = SCRIPT_DIR.parent
        sa_path = project_dir / "service-account.json"

        if sa_path.exists():
            cred = credentials.Certificate(str(sa_path))
            firebase_admin.initialize_app(cred)
        else:
            firebase_admin.initialize_app(options={"projectId": project_id})

    db = firestore.client()
    coll = db.collection("precomputed").document("neighbors").collection("words")

    print(f"\nUploading {len(neighbors)} words to Firestore ...")
    batch = db.batch()
    count = 0

    for word, nbrs in tqdm(neighbors.items()):
        doc_ref = coll.document(word)
        batch.set(doc_ref, {
            "neighbors": [n["w"] for n in nbrs],
            "scores": [n["s"] for n in nbrs],
        })
        count += 1

        if count % 450 == 0:
            batch.commit()
            batch = db.batch()

    if count % 450 != 0:
        batch.commit()

    db.collection("precomputed").document("neighbors").set({
        "vocabSize": len(neighbors),
        "topK": TOP_K,
        "model": GLOVE_NAME,
        "updatedAt": firestore.SERVER_TIMESTAMP,
    })

    print(f"  Uploaded {count} word documents + metadata")

    if targets:
        print(f"\nUploading {len(targets)} scored targets to Firestore ...")
        target_words = [t["word"] for t in targets]
        target_scores = [t["score"] for t in targets]
        db.collection("precomputed").document("targets").set({
            "words": target_words,
            "scores": target_scores,
            "count": len(targets),
            "criteria": {
                "minLen": MIN_TARGET_LEN,
                "minAvgScore": MIN_AVG_SCORE,
                "maxAvgScore": MAX_AVG_SCORE,
                "minTopScore": MIN_TOP_SCORE,
                "minInboundLinks": MIN_INBOUND_LINKS,
                "minStrongInbound": MIN_STRONG_INBOUND,
                "strongInboundTopK": STRONG_INBOUND_TOP_K,
                "strongInboundMinScore": STRONG_INBOUND_MIN_SCORE,
            },
            "updatedAt": firestore.SERVER_TIMESTAMP,
        })
        print(f"  Uploaded precomputed/targets ({len(targets)} words)")


def main():
    parser = argparse.ArgumentParser(description="tir word-engine pipeline")
    parser.add_argument("--upload", action="store_true", help="Upload to Firestore after building")
    parser.add_argument("--vocab-only", action="store_true", help="Only curate and write vocab")
    parser.add_argument("--from-json", type=str, help="Skip compute, load neighbors from JSON")
    args = parser.parse_args()

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    # Step 1: Load GloVe model
    glove_ranks: dict[str, int] | None = None
    if not args.vocab_only and not args.from_json:
        model, glove_ranks = load_glove_model()
        glove_vocab = set(model.keys())
    else:
        model = None
        glove_vocab = None

    # Step 2: Curate vocabulary (with frequency filter when GloVe is loaded)
    print("=== Step 1: Curate vocabulary ===")
    vocab = curate_vocab(glove_vocab, glove_ranks)

    VOCAB_FILE.write_text(json.dumps(vocab, indent=2))
    print(f"  Wrote {VOCAB_FILE}")

    if args.vocab_only:
        return

    if args.from_json:
        print(f"\n=== Loading neighbors from {args.from_json} ===")
        neighbors = json.loads(Path(args.from_json).read_text())
    else:
        # Step 3: Compute neighbors
        print("\n=== Step 2: Compute neighbors ===")
        t0 = time.time()
        neighbors = compute_neighbors(vocab, model)
        print(f"  Computed in {time.time()-t0:.1f}s")

        # Write JSON
        NEIGHBORS_FILE.write_text(json.dumps(neighbors))
        print(f"  Wrote {NEIGHBORS_FILE}")

        # Write a human-readable sample
        sample_words = ["ocean", "cat", "fire", "dream", "castle", "piano", "chocolate"]
        sample = {}
        for w in sample_words:
            if w in neighbors:
                sample[w] = neighbors[w][:10]
        sample_file = OUT_DIR / "sample.json"
        sample_file.write_text(json.dumps(sample, indent=2))
        print(f"  Wrote {sample_file} (sample of {len(sample)} words)")

    # Step 4: Score targets
    print("\n=== Step 3: Score targets ===")
    targets = score_targets(neighbors)

    targets_file = OUT_DIR / "targets.json"
    targets_file.write_text(json.dumps(targets, indent=2))
    print(f"  Wrote {targets_file}")

    # Step 5: Upload to Firestore
    if args.upload:
        print("\n=== Step 4: Upload to Firestore ===")
        upload_to_firestore(neighbors, targets)

    print("\nDone!")


if __name__ == "__main__":
    main()

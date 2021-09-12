# Helper functions and settings
from apollo.models import *
import random
from nltk.stem import WordNetLemmatizer
from tir.settings import MODEL_PATH, MODEL

wordnet_lemmatizer = WordNetLemmatizer()

STARTER_WORDS = ["cat", "man", "building", "helicopter", "plane", "dog"]
TARGET_WORDS = ["house", "Obama", "garden", "garbage", "light", "Frost"]

import importlib.util
import tempfile
import unittest
import zipfile
from pathlib import Path

spec = importlib.util.spec_from_file_location("setup_vectors", Path(__file__).resolve().parents[1] / "scripts" / "setup-vectors.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class AnswerFilterTests(unittest.TestCase):
    def test_primary_pos_concrete_sense_names_and_inflections(self):
        data = "\n".join([
            "00000001 14 n 01 dead 0 | deceased people",
            "00000002 06 n 01 found 0 | an obscure noun",
            "00000003 06 n 02 bucket 0 pail 0 | container",
            "00000004 05 n 01 tiger 0 | animal",
            "00000005 06 n 01 national 0 | an obscure noun",
            "00000006 06 n 01 john 0 | toilet",
            "00000007 18 n 01 John 0 | named person",
            "00000008 08 n 01 teeth 0 | teeth",
            "00000009 06 n 01 spoke 0 | wheel part",
            "00000010 06 n 01 gadget 0 | object",
            "00000011 06 n 01 watch 0 | timepiece",
        ])
        senses = "\n".join([
            "dead%1:14:00:: 00000001 1 9", "dead%3:00:00:: 00000999 1 76",
            "found%1:06:00:: 00000002 1 1", "found%2:00:00:: 00000999 1 13",
            "bucket%1:06:00:: 00000003 1 5", "pail%1:06:00:: 00000003 1 4",
            "tiger%1:05:00:: 00000004 1 4",
            "national%1:06:00:: 00000005 1 2", "national%3:00:00:: 00000999 1 70",
            "john%1:06:00:: 00000006 1 2", "John%1:18:00:: 00000007 1 1",
            "teeth%1:08:00:: 00000008 1 2", "spoke%1:06:00:: 00000009 1 2",
            "gadget%1:06:00:: 00000010 1 2",
            "watch%1:06:00:: 00000011 1 1", "watch%2:00:00:: 00000999 1 40",
        ])
        frequency = {word: index for index, word in enumerate("dead found bucket pail tiger national john teeth spoke gadget watch".split())}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "wordnet.zip"
            with zipfile.ZipFile(path, "w") as archive:
                archive.writestr("wordnet/data.noun", data)
                archive.writestr("wordnet/index.sense", senses)
                archive.writestr("wordnet/noun.exc", "teeth tooth\n")
                archive.writestr("wordnet/verb.exc", "spoke speak\n")
            answers = module.noun_candidates(path, frequency, {"watch", "sandcastle"})
        for word in ["dead", "found", "national", "john", "teeth", "spoke"]:
            self.assertNotIn(word, answers)
        for word in ["bucket", "pail", "tiger", "gadget", "watch", "sandcastle"]:
            self.assertIn(word, answers)


if __name__ == "__main__":
    unittest.main()

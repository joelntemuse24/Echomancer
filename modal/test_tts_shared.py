import unittest

from tts_shared import (
    partition_contiguous_paragraphs,
    split_text_into_sentence_units,
)


class PartitionContiguousParagraphsTests(unittest.TestCase):
    def test_balances_ordered_text_across_available_chains(self):
        paragraphs = [{"text": str(i) * 10_000} for i in range(10)]

        chunks = partition_contiguous_paragraphs(
            paragraphs,
            max_chunks=5,
            min_chunk_chars=20_000,
        )

        self.assertEqual(len(chunks), 5)
        self.assertEqual(
            [p for chunk in chunks for p in chunk],
            paragraphs,
        )
        self.assertEqual([len(chunk) for chunk in chunks], [2, 2, 2, 2, 2])

    def test_keeps_small_books_on_one_continuation_chain(self):
        paragraphs = [{"text": "a" * 4_000}, {"text": "b" * 4_000}]

        chunks = partition_contiguous_paragraphs(
            paragraphs,
            max_chunks=5,
            min_chunk_chars=20_000,
        )

        self.assertEqual(chunks, [paragraphs])

    def test_never_creates_empty_chunks(self):
        paragraphs = [{"text": "a"}, {"text": "b"}, {"text": "c"}]

        chunks = partition_contiguous_paragraphs(
            paragraphs,
            max_chunks=10,
            min_chunk_chars=1,
        )

        self.assertEqual(len(chunks), 3)
        self.assertTrue(all(chunks))


class SentenceUnitTests(unittest.TestCase):
    def test_preserves_paragraph_boundaries_and_abbreviations(self):
        units = split_text_into_sentence_units(
            "Dr. Hale entered the room. Nobody spoke.\n\nThe rain stopped."
        )

        self.assertEqual(
            [unit["text"] for unit in units],
            ["Dr. Hale entered the room.", "Nobody spoke.", "The rain stopped."],
        )
        self.assertTrue(units[1]["ends_paragraph"])
        self.assertTrue(units[2]["ends_paragraph"])


if __name__ == "__main__":
    unittest.main()

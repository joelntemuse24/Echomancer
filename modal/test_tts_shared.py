import unittest

from tts_shared import partition_contiguous_paragraphs


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


if __name__ == "__main__":
    unittest.main()

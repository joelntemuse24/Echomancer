"""Evaluation text set: public domain, and deliberately varied.

Every passage is public domain (Conan Doyle, Austen, Melville, Carroll, Shelley)
so the eval can be committed and shared. They cover the shapes that change how
often a TTS model breathes: short declaratives, dialogue with many sentence
edges, long subordinate clauses, and numerals.
"""

from __future__ import annotations

TEXTS: dict[str, dict] = {
    "scandal": {
        "title": "A Scandal in Bohemia (Conan Doyle, 1892)",
        "kind": "narrative",
        "text": (
            "To Sherlock Holmes she is always the woman. I have seldom heard him mention her "
            "under any other name. In his eyes she eclipses and predominates the whole of her "
            "sex. It was not that he felt any emotion akin to love for Irene Adler. All "
            "emotions, and that one particularly, were abhorrent to his cold, precise but "
            "admirably balanced mind. He was, I take it, the most perfect reasoning and "
            "observing machine that the world has seen, but as a lover he would have placed "
            "himself in a false position. He never spoke of the softer passions, save with a "
            "gibe and a sneer."
        ),
    },
    "bennet": {
        "title": "Pride and Prejudice, chapter 1 (Austen, 1813)",
        "kind": "dialogue",
        "text": (
            "My dear Mr. Bennet, said his lady to him one day, have you heard that Netherfield "
            "Park is let at last? Mr. Bennet replied that he had not. But it is, returned she, "
            "for Mrs. Long has just been here, and she told me all about it. Mr. Bennet made "
            "no answer. Do you not want to know who has taken it? cried his wife impatiently. "
            "You want to tell me, and I have no objection to hearing it. This was invitation "
            "enough."
        ),
    },
    "whale": {
        "title": "Moby-Dick, chapter 1 (Melville, 1851)",
        "kind": "long-clause",
        "text": (
            "Call me Ishmael. Some years ago, never mind how long precisely, having little or "
            "no money in my purse, and nothing particular to interest me on shore, I thought I "
            "would sail about a little and see the watery part of the world. It is a way I have "
            "of driving off the spleen and regulating the circulation. Whenever I find myself "
            "growing grim about the mouth, whenever it is a damp, drizzly November in my soul, "
            "then I account it high time to get to sea as soon as I can."
        ),
    },
    "looking": {
        "title": "Through the Looking-Glass (Carroll, 1871)",
        "kind": "numbers",
        "text": (
            "One thing was certain, that the white kitten had had nothing to do with it. It "
            "was the black kitten's fault entirely. For the white kitten had been having its "
            "face washed by the old cat for the last quarter of an hour, and was consequently "
            "in a very uncomfortable state, and could not have got into mischief if it had "
            "tried. So you see that it could not have been the white kitten. It was the black "
            "kitten's fault, and it had been winding up the ball of worsted for the last ten "
            "minutes, and had rolled it about until it was quite untidy."
        ),
    },
}


def text_ids() -> list[str]:
    return sorted(TEXTS)


def get(text_id: str) -> str:
    return TEXTS[text_id]["text"]

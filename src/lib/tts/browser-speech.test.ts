import { describe, expect, it } from "vitest";
import {
  matchAndrewNeuralVoice,
  matchEdgeNeuralVoice,
  scoreAndrewNeuralVoice,
} from "./browser-speech";
import { MICHELLE_NEURAL_VOICE_ID } from "./standard-voice";

const voice = (name: string, voiceURI = name, lang = "en-US") => ({
  name,
  voiceURI,
  lang,
});

describe("Andrew Neural browser matching", () => {
  it("accepts Edge online natural Andrew", () => {
    const hit = matchAndrewNeuralVoice([
      voice("Google US English"),
      voice("Microsoft Andrew Online (Natural) - English (United States)"),
      voice("Samantha"),
    ]);
    expect(hit?.name).toMatch(/Andrew/i);
    expect(hit?.name).toMatch(/Natural|Online/i);
  });

  it("accepts the short Edge TTS id in voiceURI", () => {
    const hit = matchAndrewNeuralVoice([
      voice("Andrew", "en-US-AndrewNeural", "en-US"),
    ]);
    expect(hit?.voiceURI).toBe("en-US-AndrewNeural");
    expect(scoreAndrewNeuralVoice(hit!)).toBeGreaterThanOrEqual(100);
  });

  it("rejects a random system voice and older non-neural Andrew", () => {
    expect(
      matchAndrewNeuralVoice([
        voice("Google US English"),
        voice("Samantha"),
        voice("Alex"),
        voice("Microsoft David Desktop - English (United States)"),
      ])
    ).toBeNull();

    expect(
      scoreAndrewNeuralVoice(voice("Microsoft Andrew Desktop - English (United States)"))
    ).toBe(0);
  });

  it("matches Michelle Neural and rejects a random female voice", () => {
    const michelle = matchEdgeNeuralVoice(
      [
        voice("Google US English"),
        voice("Microsoft Michelle Online (Natural) - English (United States)"),
        voice("Samantha"),
      ],
      { shortName: "Michelle", locale: "en-US", neuralId: MICHELLE_NEURAL_VOICE_ID }
    );
    expect(michelle?.name).toMatch(/Michelle/i);

    expect(
      matchEdgeNeuralVoice(
        [voice("Samantha"), voice("Google US English")],
        { shortName: "Michelle", locale: "en-US", neuralId: MICHELLE_NEURAL_VOICE_ID }
      )
    ).toBeNull();
  });
});

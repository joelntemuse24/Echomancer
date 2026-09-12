import { describe, expect, it } from "vitest";
import {
  matchAndrewNeuralVoice,
  matchEdgeNeuralVoice,
  scoreAndrewNeuralVoice,
} from "./browser-speech";
import {
  AVA_NEURAL_VOICE_ID,
  LIBBY_NEURAL_VOICE_ID,
} from "./standard-voice";

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

  it("matches Ava and Libby neurals and rejects a random female voice", () => {
    const ava = matchEdgeNeuralVoice(
      [
        voice("Google US English"),
        voice("Microsoft Ava Online (Natural) - English (United States)"),
        voice("Samantha"),
      ],
      { shortName: "Ava", locale: "en-US", neuralId: AVA_NEURAL_VOICE_ID }
    );
    expect(ava?.name).toMatch(/Ava/i);

    const libby = matchEdgeNeuralVoice(
      [
        voice("Google UK English Female", "Google UK English Female", "en-GB"),
        voice("Libby", LIBBY_NEURAL_VOICE_ID, "en-GB"),
      ],
      { shortName: "Libby", locale: "en-GB", neuralId: LIBBY_NEURAL_VOICE_ID }
    );
    expect(libby?.voiceURI).toBe(LIBBY_NEURAL_VOICE_ID);

    expect(
      matchEdgeNeuralVoice(
        [voice("Samantha"), voice("Google US English")],
        { shortName: "Ava", locale: "en-US", neuralId: AVA_NEURAL_VOICE_ID }
      )
    ).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { AUDIO_EXTENSIONS, downmixToMono, isAudioFile } from "../src/audio";

describe("isAudioFile", () => {
  it("accepts every supported audio extension", () => {
    for (const ext of AUDIO_EXTENSIONS) {
      expect(isAudioFile(`meetings/recording${ext}`)).toBe(true);
    }
  });

  it("is case-insensitive", () => {
    expect(isAudioFile("A/B/Clip.MP3")).toBe(true);
    expect(isAudioFile("a/b/clip.WAV")).toBe(true);
  });

  it("rejects non-audio files", () => {
    expect(isAudioFile("notes/meeting.md")).toBe(false);
    expect(isAudioFile("images/photo.png")).toBe(false);
    expect(isAudioFile("audio.mp3x")).toBe(false);
    expect(isAudioFile("mp3")).toBe(false);
  });
});

describe("downmixToMono", () => {
  it("returns the single channel unchanged", () => {
    const mono = new Float32Array([0.1, -0.2, 0.3]);
    // Compare against the same Float32 values (bit-identical for 1 channel).
    expect(Array.from(downmixToMono([mono], 3))).toEqual(Array.from(mono));
  });

  it("averages stereo channels", () => {
    const left = new Float32Array([1.0, 0.0]);
    const right = new Float32Array([0.0, 1.0]);
    expect(Array.from(downmixToMono([left, right], 2))).toEqual([0.5, 0.5]);
  });

  it("returns zeros for no channels", () => {
    expect(Array.from(downmixToMono([], 4))).toEqual([0, 0, 0, 0]);
  });
});

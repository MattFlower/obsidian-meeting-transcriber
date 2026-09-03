import { describe, expect, it } from "vitest";
import {
  assignWordSpeakers,
  buildTurns,
  DEFAULT_TURN_OPTIONS,
  labelSpeakers,
  paragraphsFromWords,
  parseSpeakerTranscript,
  renderSpeakerTranscript,
  renumberTurns,
  speakerTranscript,
  type SpeakerSegment,
  type SpeakerTurn,
  type TimedWord,
  mixedSpeakerTranscript,
  smoothLabels,
} from "../src/speakers";

function w(text: string, start: number, end: number): TimedWord {
  return { text, start, end };
}

function seg(start: number, end: number, speaker: number): SpeakerSegment {
  return { start, end, speaker };
}

/** `n` one-second words back to back starting at `from`, named `p0 p1 ...`. */
function run(prefix: string, n: number, from: number): TimedWord[] {
  const out: TimedWord[] = [];
  for (let i = 0; i < n; i++) {
    out.push(w(`${prefix}${i}`, from + i, from + i + 1));
  }
  return out;
}

const texts = (turns: SpeakerTurn[]) =>
  turns.map((t) => [t.speaker, t.text] as const);

describe("assignWordSpeakers", () => {
  it("gives a word inside one segment that segment's speaker", () => {
    const ids = assignWordSpeakers(
      [w("a", 1, 2), w("b", 6, 7)],
      [seg(0, 5, 3), seg(5, 10, 7)],
    );
    expect(ids).toEqual([3, 7]);
  });

  it("gives a straddling word to the segment with the larger overlap", () => {
    const segments = [seg(0, 5, 0), seg(5, 10, 1)];
    expect(assignWordSpeakers([w("a", 4, 7)], segments)).toEqual([1]);
    expect(assignWordSpeakers([w("a", 3, 6)], segments)).toEqual([0]);
  });

  it("keeps the previous word's speaker when overlapped segments tie", () => {
    // X ends where A and B both start; A and B fully cover the tied words.
    const segments = [seg(0, 2, 1), seg(2, 10, 0), seg(2, 10, 1)];
    expect(
      assignWordSpeakers([w("x", 0.5, 1), w("y", 3, 4), w("z", 5, 6)], segments),
    ).toEqual([1, 1, 1]);
  });

  it("breaks a tie with no previous word by earliest start, then lowest id", () => {
    expect(
      assignWordSpeakers([w("a", 3, 4)], [seg(2, 10, 5), seg(2, 10, 0)]),
    ).toEqual([0]);
    expect(
      assignWordSpeakers([w("a", 3, 4)], [seg(1, 10, 5), seg(2, 10, 0)]),
    ).toEqual([5]);
  });

  it("gives a word in a gap to the segment with the nearer edge", () => {
    const segments = [seg(0, 10, 0), seg(20, 30, 1)];
    expect(assignWordSpeakers([w("a", 12, 13)], segments)).toEqual([0]);
    expect(assignWordSpeakers([w("a", 18, 19)], segments)).toEqual([1]);
  });

  it("measures the before-edge from the latest-ending passed segment", () => {
    // B is nested inside A and ends early; A's edge is the near one.
    const segments = [seg(0, 10, 0), seg(1, 3, 1), seg(20, 30, 2)];
    expect(assignWordSpeakers([w("a", 11, 12)], segments)).toEqual([0]);
  });

  it("breaks a gap tie with the previous word's speaker, else the earliest segment", () => {
    // Word midpoint 11 is one second from B's end and from C's start.
    const segments = [seg(0, 4, 1), seg(5, 10, 0), seg(12, 20, 1)];
    expect(
      assignWordSpeakers([w("a", 3, 4), w("b", 10.5, 11.5)], segments),
    ).toEqual([1, 1]);
    expect(assignWordSpeakers([w("b", 10.5, 11.5)], segments)).toEqual([0]);
  });

  it("returns -1 for every word when there are no segments", () => {
    expect(assignWordSpeakers([w("a", 0, 1), w("b", 1, 2)], [])).toEqual([
      -1, -1,
    ]);
    expect(assignWordSpeakers([], [])).toEqual([]);
  });

  it("treats a zero-length word as a point with half-open containment", () => {
    const segments = [seg(0, 5, 0), seg(5, 10, 1)];
    expect(assignWordSpeakers([w("a", 2, 2)], segments)).toEqual([0]);
    expect(assignWordSpeakers([w("a", 5, 5)], segments)).toEqual([1]);
    // Past the end of everything: nearest edge.
    expect(assignWordSpeakers([w("a", 10, 10)], segments)).toEqual([1]);
  });

  it("does not depend on the order segments are given in", () => {
    const words = [w("a", 1, 2), w("b", 4, 7), w("c", 12, 13)];
    const segments = [seg(5, 10, 1), seg(0, 5, 0), seg(20, 30, 2)];
    expect(assignWordSpeakers(words, segments)).toEqual(
      assignWordSpeakers(words, segments.slice().reverse()),
    );
    expect(assignWordSpeakers(words, segments)).toEqual([0, 1, 1]);
  });

  it("matches a brute-force reference on random data", () => {
    // Times are multiples of 0.25 so every subtraction is exact and the
    // reference's tie detection cannot disagree with the sweep's by an ulp.
    for (let seedNo = 1; seedNo <= 150; seedNo++) {
      const rand = lcg(seedNo);
      const segments: SpeakerSegment[] = [];
      const m = 1 + Math.floor(rand() * 8);
      for (let i = 0; i < m; i++) {
        const start = Math.floor(rand() * 120) / 4;
        const length = (1 + Math.floor(rand() * 24)) / 4;
        segments.push(seg(start, start + length, Math.floor(rand() * 4)));
      }
      const words: TimedWord[] = [];
      let t = Math.floor(rand() * 8) / 4;
      for (let i = 0; i < 25; i++) {
        const length = Math.floor(rand() * 5) / 4; // 0 .. 1, some points
        words.push(w(`w${i}`, t, t + length));
        t += length + Math.floor(rand() * 9) / 4;
      }
      expect(assignWordSpeakers(words, segments), `seed ${seedNo}`).toEqual(
        referenceAssign(words, segments),
      );
    }
  });
});

describe("labelSpeakers", () => {
  it("numbers speakers by first appearance and blanks -1", () => {
    expect(labelSpeakers([2, 2, 0, -1, 2, 1])).toEqual([
      "Speaker 1",
      "Speaker 1",
      "Speaker 2",
      "",
      "Speaker 1",
      "Speaker 3",
    ]);
    expect(labelSpeakers([])).toEqual([]);
  });
});

describe("buildTurns", () => {
  it("merges consecutive equal labels with text, start and end", () => {
    const words = [...run("a", 2, 0), ...run("b", 2, 2)];
    const turns = buildTurns(words, ["A", "A", "B", "B"], { minTurnWords: 1 });
    expect(turns).toEqual([
      { speaker: "A", text: "a0 a1", start: 0, end: 2 },
      { speaker: "B", text: "b0 b1", start: 2, end: 4 },
    ]);
  });

  it("throws a RangeError on a label/word length mismatch", () => {
    expect(() => buildTurns([w("a", 0, 1)], [])).toThrow(RangeError);
    expect(() => buildTurns([], ["A"])).toThrow(RangeError);
  });

  it("returns no turns for no words", () => {
    expect(buildTurns([], [])).toEqual([]);
  });

  it("absorbs a tiny turn into the neighbour with the smaller time gap", () => {
    // B sits 2 s after A and 0.5 s before C.
    const words = [...run("a", 3, 0), w("b", 5, 6), ...run("c", 3, 6.5)];
    const turns = buildTurns(words, ["A", "A", "A", "B", "C", "C", "C"]);
    expect(turns).toEqual([
      { speaker: "A", text: "a0 a1 a2", start: 0, end: 3 },
      { speaker: "C", text: "b c0 c1 c2", start: 5, end: 9.5 },
    ]);
  });

  it("prefers the previous neighbour when the gaps tie", () => {
    const words = [...run("a", 3, 0), w("b", 4, 5), ...run("c", 3, 6)];
    const turns = buildTurns(words, ["A", "A", "A", "B", "C", "C", "C"]);
    expect(texts(turns)).toEqual([
      ["A", "a0 a1 a2 b"],
      ["C", "c0 c1 c2"],
    ]);
  });

  it("repeats absorption until every turn is long enough", () => {
    // B joins C (0.2 s away, versus 0.5 s back to A); the merged two-word
    // C is still tiny and joins D (0.1 s away, versus 0.5 s back to A).
    const words = [
      ...run("a", 3, 0),
      w("b", 3.5, 4),
      w("c", 4.2, 4.7),
      ...run("d", 3, 4.8),
    ];
    const turns = buildTurns(words, ["A", "A", "A", "B", "C", "D", "D", "D"]);
    expect(turns).toEqual([
      { speaker: "A", text: "a0 a1 a2", start: 0, end: 3 },
      { speaker: "D", text: "b c d0 d1 d2", start: 3.5, end: 7.8 },
    ]);
  });

  it("never absorbs a single turn", () => {
    expect(buildTurns([w("hi", 0, 1)], ["Speaker 1"])).toEqual([
      { speaker: "Speaker 1", text: "hi", start: 0, end: 1 },
    ]);
    expect(texts(buildTurns(run("a", 2, 0), ["X", "X"]))).toEqual([
      ["X", "a0 a1"],
    ]);
  });

  it("absorbs a tiny turn at either end into its only neighbour", () => {
    const words = run("x", 4, 0);
    expect(texts(buildTurns(words, ["B", "A", "A", "A"]))).toEqual([
      ["A", "x0 x1 x2 x3"],
    ]);
    expect(texts(buildTurns(words, ["A", "A", "A", "B"]))).toEqual([
      ["A", "x0 x1 x2 x3"],
    ]);
  });

  it("treats the empty label like any other", () => {
    const words = run("x", 7, 0);
    expect(
      texts(buildTurns(words, ["", "", "", "Speaker 1", "", "", ""])),
    ).toEqual([["", "x0 x1 x2 x3 x4 x5 x6"]]);
    expect(
      texts(buildTurns(words, ["A", "A", "A", "", "B", "B", "B"])),
    ).toEqual([
      ["A", "x0 x1 x2 x3"],
      ["B", "x4 x5 x6"],
    ]);
  });

  it("does no smoothing when minTurnWords is 1", () => {
    const turns = buildTurns(run("x", 3, 0), ["A", "B", "A"], {
      minTurnWords: 1,
    });
    expect(texts(turns)).toEqual([
      ["A", "x0"],
      ["B", "x1"],
      ["A", "x2"],
    ]);
  });

  it("defaults to three words", () => {
    expect(DEFAULT_TURN_OPTIONS.minTurnWords).toBe(3);
    const words = run("x", 6, 0);
    // A two-word turn is absorbed by default, kept with minTurnWords: 2.
    expect(texts(buildTurns(words, ["A", "A", "A", "B", "B", "A"]))).toEqual([
      ["A", "x0 x1 x2 x3 x4 x5"],
    ]);
    expect(
      texts(buildTurns(words, ["A", "A", "A", "B", "B", "A"], { minTurnWords: 2 })),
    ).toHaveLength(2);
  });
});

describe("renumberTurns", () => {
  it("closes numbering gaps by first appearance and leaves other labels alone", () => {
    const input: SpeakerTurn[] = [
      { speaker: "Speaker 3", text: "a" },
      { speaker: "Me", text: "b" },
      { speaker: "Speaker 1", text: "c" },
      { speaker: "Speaker 3", text: "d" },
      { speaker: "", text: "e" },
      { speaker: "Alice", text: "f" },
    ];
    const out = renumberTurns(input);
    expect(out.map((t) => t.speaker)).toEqual([
      "Speaker 1",
      "Me",
      "Speaker 2",
      "Speaker 1",
      "",
      "Alice",
    ]);
    // New objects; the input is untouched.
    expect(out[0]).not.toBe(input[0]);
    expect(input[0].speaker).toBe("Speaker 3");
  });

  it("keeps start and end on the renumbered turns", () => {
    const out = renumberTurns([
      { speaker: "Speaker 9", text: "a", start: 1, end: 2 },
    ]);
    expect(out).toEqual([{ speaker: "Speaker 1", text: "a", start: 1, end: 2 }]);
  });

  it("uses the given prefix and treats it literally", () => {
    const out = renumberTurns(
      [
        { speaker: "Spk. 7", text: "a" },
        { speaker: "Speaker 7", text: "b" },
      ],
      "Spk. ",
    );
    expect(out.map((t) => t.speaker)).toEqual(["Spk. 1", "Speaker 7"]);
  });
});

describe("paragraphsFromWords", () => {
  it("starts a new paragraph at a pause of at least the threshold", () => {
    const words = [
      w("one", 0, 1),
      w("two", 1.5, 2),
      w("three", 4, 5), // 2 s pause
      w("four", 5.5, 6),
    ];
    expect(paragraphsFromWords(words)).toBe("one two\n\nthree four");
    expect(paragraphsFromWords(words, 3)).toBe("one two three four");
    expect(paragraphsFromWords(words, 0.6)).toBe("one two\n\nthree four");
    // The threshold is inclusive: the 0.5 s gaps split at exactly 0.5.
    expect(paragraphsFromWords(words, 0.5)).toBe(
      "one\n\ntwo\n\nthree\n\nfour",
    );
  });

  it("returns an empty string for no words", () => {
    expect(paragraphsFromWords([])).toBe("");
  });
});

describe("renderSpeakerTranscript", () => {
  it("labels turns in bold and leaves unlabelled turns plain", () => {
    expect(
      renderSpeakerTranscript([
        { speaker: "", text: "intro" },
        { speaker: "Speaker 1", text: "hello" },
        { speaker: "Alice", text: "hi" },
      ]),
    ).toBe("intro\n\n**Speaker 1:** hello\n\n**Alice:** hi");
  });

  it("puts the label on the first paragraph of a multi-paragraph turn only", () => {
    expect(
      renderSpeakerTranscript([
        { speaker: "Speaker 1", text: "first.\n\nsecond." },
        { speaker: "Speaker 2", text: "reply" },
      ]),
    ).toBe("**Speaker 1:** first.\n\nsecond.\n\n**Speaker 2:** reply");
  });

  it("skips blank turns and trims whitespace", () => {
    expect(
      renderSpeakerTranscript([
        { speaker: "Speaker 1", text: "   " },
        { speaker: " Speaker 2 ", text: "  text  \n" },
        { speaker: "", text: "" },
      ]),
    ).toBe("**Speaker 2:** text");
    expect(renderSpeakerTranscript([])).toBe("");
  });
});

describe("parseSpeakerTranscript", () => {
  it("round-trips rendered output, including renamed labels", () => {
    const rendered = renderSpeakerTranscript([
      { speaker: "Alice", text: "Let's ship it." },
      { speaker: "Speaker 2", text: "Agreed.\n\nOn Monday, though." },
      { speaker: "Alice", text: "Fine." },
    ]);
    const parsed = parseSpeakerTranscript(rendered);
    expect(parsed).toEqual([
      { speaker: "Alice", text: "Let's ship it." },
      { speaker: "Speaker 2", text: "Agreed.\n\nOn Monday, though." },
      { speaker: "Alice", text: "Fine." },
    ]);
    expect(renderSpeakerTranscript(parsed!)).toBe(rendered);
  });

  it("accepts the **Label**: variant and an empty text", () => {
    expect(parseSpeakerTranscript("**Bob**: hello there\n\n**Bob:**")).toEqual([
      { speaker: "Bob", text: "hello there" },
      { speaker: "Bob", text: "" },
    ]);
  });

  it("keeps a leading unlabelled paragraph as an unlabelled turn and round-trips it", () => {
    const md = "Some preamble.\n\nMore preamble.\n\n**Speaker 1:** hi";
    const parsed = parseSpeakerTranscript(md);
    expect(parsed).toEqual([
      { speaker: "", text: "Some preamble.\n\nMore preamble." },
      { speaker: "Speaker 1", text: "hi" },
    ]);
    expect(renderSpeakerTranscript(parsed!)).toBe(md);
  });

  it("returns null for a plain transcript", () => {
    expect(parseSpeakerTranscript("just words\n\nmore words")).toBeNull();
    expect(parseSpeakerTranscript("")).toBeNull();
    // Bold without a colon is emphasis, not a label.
    expect(parseSpeakerTranscript("**really** important")).toBeNull();
  });

  it("tolerates extra whitespace and blank-line pileup", () => {
    expect(
      parseSpeakerTranscript("\n\n**Alice :**   hi  \n\n\n\n  more  \n"),
    ).toEqual([{ speaker: "Alice", text: "hi\n\nmore" }]);
  });
});

describe("speakerTranscript", () => {
  it("renders one speaker as plain pause-split paragraphs", () => {
    const words = [w("a", 0, 1), w("b", 1, 2), w("c", 5, 6)];
    expect(speakerTranscript(words, [seg(0, 6, 0)])).toEqual({
      text: "a b\n\nc",
      speakers: 1,
    });
  });

  it("renders no segments as plain paragraphs with zero speakers", () => {
    expect(speakerTranscript([w("a", 0, 1), w("b", 1, 2)], [])).toEqual({
      text: "a b",
      speakers: 0,
    });
    expect(speakerTranscript([], [])).toEqual({ text: "", speakers: 0 });
  });

  it("renders two speakers as labelled turns", () => {
    const words = [...run("a", 3, 0), ...run("b", 3, 3)];
    expect(speakerTranscript(words, [seg(0, 3, 4), seg(3, 6, 2)])).toEqual({
      text: "**Speaker 1:** a0 a1 a2\n\n**Speaker 2:** b0 b1 b2",
      speakers: 2,
    });
  });

  it("falls back to plain text when smoothing leaves one speaker", () => {
    const words = [...run("a", 3, 0), w("x", 3, 4)];
    expect(speakerTranscript(words, [seg(0, 3, 0), seg(3, 4, 1)])).toEqual({
      text: "a0 a1 a2 x",
      speakers: 1,
    });
  });

  it("renumbers after smoothing removes a speaker", () => {
    const words = [...run("a", 3, 0), w("x", 3, 4), ...run("b", 3, 4)];
    const segments = [seg(0, 3, 0), seg(3, 4, 1), seg(4, 7, 2)];
    expect(speakerTranscript(words, segments)).toEqual({
      text: "**Speaker 1:** a0 a1 a2 x\n\n**Speaker 2:** b0 b1 b2",
      speakers: 2,
    });
  });

  it("honours the pause option in the single-speaker fallback", () => {
    const words = [w("a", 0, 1), w("b", 1.5, 2)];
    expect(
      speakerTranscript(words, [seg(0, 2, 0)], { pauseParagraphSeconds: 0.5 })
        .text,
    ).toBe("a\n\nb");
  });

  it("keeps a fixed label such as Me alongside renumbered speakers", () => {
    const words = run("x", 12, 0);
    const labels = [
      ...Array<string>(3).fill("Me"),
      ...Array<string>(3).fill("Speaker 4"),
      ...Array<string>(3).fill("Me"),
      ...Array<string>(3).fill("Speaker 2"),
    ];
    const turns = renumberTurns(buildTurns(words, labels));
    expect(turns.map((t) => t.speaker)).toEqual([
      "Me",
      "Speaker 1",
      "Me",
      "Speaker 2",
    ]);
    expect(renderSpeakerTranscript(turns)).toBe(
      "**Me:** x0 x1 x2\n\n**Speaker 1:** x3 x4 x5\n\n" +
        "**Me:** x6 x7 x8\n\n**Speaker 2:** x9 x10 x11",
    );
  });
});

/** Deterministic PRNG so the random cross-check is reproducible. */
function lcg(seed: number): () => number {
  let state = (seed * 2654435761) >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/**
 * O(n * m) restatement of the assignWordSpeakers rules, scanning every
 * segment for every word, to check the sweep's bookkeeping.
 */
function referenceAssign(
  words: TimedWord[],
  segments: SpeakerSegment[],
): number[] {
  const EPS = 1e-6;
  let prev: number | null = null;
  return words.map((word) => {
    if (segments.length === 0) return -1;
    const ws = word.start;
    const we = Math.max(word.end, ws);
    const point = we <= ws;
    const overlapping = segments
      .map((s) => ({
        s,
        score: point
          ? s.start <= ws && ws < s.end
            ? 1
            : 0
          : Math.min(we, s.end) - Math.max(ws, s.start),
      }))
      .filter((c) => c.score > 0);
    let tied: SpeakerSegment[];
    if (overlapping.length > 0) {
      const best = Math.max(...overlapping.map((c) => c.score));
      tied = overlapping.filter((c) => c.score >= best - EPS).map((c) => c.s);
    } else {
      const mid = (ws + we) / 2;
      const byDistance = segments.map((s) => ({
        s,
        d: s.start > mid ? s.start - mid : mid - s.end,
      }));
      const best = Math.min(...byDistance.map((c) => c.d));
      tied = byDistance.filter((c) => c.d <= best + EPS).map((c) => c.s);
    }
    let chosen: number;
    if (prev !== null && tied.some((s) => s.speaker === prev)) {
      chosen = prev;
    } else {
      const earliest = tied.reduce((a, b) =>
        b.start < a.start || (b.start === a.start && b.speaker < a.speaker)
          ? b
          : a,
      );
      chosen = earliest.speaker;
    }
    prev = chosen;
    return chosen;
  });
}

describe("smoothLabels", () => {
  const words = ["a", "b", "c", "d", "e"].map((t, i) => w(t, i, i + 1));

  it("absorbs a tiny run into its nearer neighbour and leaves the rest alone", () => {
    expect(
      smoothLabels(words, ["A", "A", "B", "A", "A"], { minTurnWords: 2 }),
    ).toEqual(["A", "A", "A", "A", "A"]);
    expect(
      smoothLabels(words, ["A", "A", "A", "B", "B"], { minTurnWords: 2 }),
    ).toEqual(["A", "A", "A", "B", "B"]);
  });

  it("rejects mismatched lengths", () => {
    expect(() => smoothLabels(words, ["A"])).toThrow(RangeError);
  });
});

describe("mixedSpeakerTranscript", () => {
  const words = [
    w("hi", 0, 1),
    w("hello", 1, 2),
    w("there", 2, 3),
    w("ok", 3, 4),
    w("bye", 4, 5),
  ];
  const fixed = ["Me", null, null, "Me", null];

  it("keeps fixed labels and numbers the diarized voices among the open words", () => {
    const result = mixedSpeakerTranscript(
      words,
      fixed,
      [seg(0.9, 3.1, 7), seg(3.9, 5, 3)],
      "Others",
      { minTurnWords: 1 },
    );
    expect(result.text).toBe(
      "**Me:** hi\n\n**Speaker 1:** hello there\n\n**Me:** ok\n\n**Speaker 2:** bye",
    );
    expect(result.speakers).toBe(3);
  });

  it("uses the fallback label when diarization hears one voice among the open words", () => {
    const result = mixedSpeakerTranscript(words, fixed, [seg(0, 5, 0)], "Others");
    expect(result.text).toBe(
      "**Me:** hi\n\n**Others:** hello there\n\n**Me:** ok\n\n**Others:** bye",
    );
    expect(result.speakers).toBe(2);
  });

  it("never absorbs a fixed one-word interjection into a diarized neighbour", () => {
    const result = mixedSpeakerTranscript(
      words,
      fixed,
      [seg(0.9, 3.1, 0), seg(3.9, 5, 1)],
      "Others",
    );
    // Default smoothing merges the two short open runs into one voice,
    // which then takes the fallback label; "Me" stays where it was said.
    expect(result.text).toBe(
      "**Me:** hi\n\n**Others:** hello there\n\n**Me:** ok\n\n**Others:** bye",
    );
  });

  it("delegates to speakerTranscript when nothing is fixed", () => {
    const result = mixedSpeakerTranscript(words, [null, null, null, null, null], [], "Others");
    expect(result.speakers).toBe(0);
    expect(result.text).toBe("hi hello there ok bye");
  });

  it("rejects mismatched lengths", () => {
    expect(() => mixedSpeakerTranscript(words, ["Me"], [], "Others")).toThrow(RangeError);
  });
});

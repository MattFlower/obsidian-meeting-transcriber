import { describe, expect, it } from "vitest";
import {
  buildControlLine,
  buildNormalizeMessages,
  chunkTranscript,
  countWords,
  maxTokensFor,
  normalizeTranscript,
  resolveControl,
  S1_MINI_SYSTEM_PROMPT,
  stripThinkBlock,
  type NormalizeBackend,
  type NormalizerSettings,
  type NormalizerStructure,
  type NormalizerStyling,
  normalizeSpeakerTranscript,
} from "../src/normalize";

const settings: NormalizerSettings = {
  normalizerBaseUrl: "http://localhost:11434/v1",
  normalizerApiKey: "",
  normalizerModel: "s1-mini",
  normalizerStyling: "semi-formal",
  normalizerStructure: "prose",
};

/** `n` distinct words with no punctuation, e.g. "w0 w1 w2". */
function words(n: number, prefix = "w"): string {
  return Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(" ");
}

/** The transcript line of a user message (after the control line). */
function transcriptOf(userContent: string): string {
  return userContent.split("\n").slice(1).join("\n");
}

interface SeenCall {
  url: string;
  init: RequestInit;
  body: {
    model: string;
    messages: { role: string; content: string }[];
    temperature: number;
    max_tokens?: number;
    chat_template_kwargs?: { enable_thinking?: boolean };
  };
}

/**
 * A fake fetch that records every request, answers with `reply(transcript,
 * callNumber)` (a string becomes a chat completion, a Response is returned
 * as is), and tracks how many requests were ever in flight at once.
 */
function makeFetch(
  reply: (transcript: string, n: number) => string | Response,
) {
  const calls: SeenCall[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const body = JSON.parse(init.body as string);
    calls.push({ url, init, body });
    await new Promise<void>((resolve) => setImmediate(resolve));
    inFlight -= 1;
    const out = reply(transcriptOf(body.messages[1].content), calls.length);
    if (out instanceof Response) return out;
    return new Response(
      JSON.stringify({ choices: [{ message: { content: out } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, maxInFlight: () => maxInFlight };
}

describe("prompt format", () => {
  it("uses the model card's system prompt byte for byte", () => {
    expect(S1_MINI_SYSTEM_PROMPT).toBe(
      "You are a text normalizer for speech-to-text transcripts. The input " +
        "begins with a control line specifying the styling, structure, and " +
        "context settings; clean the transcript to match those settings and " +
        "output only the cleaned text.",
    );
  });

  it("sends the system prompt, then a control line, newline and the raw text", () => {
    expect(buildNormalizeMessages(settings, "so um hello there")).toEqual([
      { role: "system", content: S1_MINI_SYSTEM_PROMPT },
      {
        role: "user",
        content:
          "[Styling: semi-formal] [Structure: prose] [Context: general]\n" +
          "so um hello there",
      },
    ]);
  });

  it("takes styling and structure from settings and fixes context to general", () => {
    expect(buildControlLine("casual", "lists")).toBe(
      "[Styling: casual] [Structure: lists] [Context: general]",
    );
    const messages = buildNormalizeMessages(
      { ...settings, normalizerStyling: "formal", normalizerStructure: "lists" },
      "x",
    );
    expect(messages[1].content.startsWith("[Styling: formal] [Structure: lists]")).toBe(true);
  });

  it("falls back to the defaults for values outside the trained sets", () => {
    expect(
      resolveControl({
        ...settings,
        normalizerStyling: "shouty" as NormalizerStyling,
        normalizerStructure: "" as NormalizerStructure,
      }),
    ).toEqual({ styling: "semi-formal", structure: "prose" });
  });
});

describe("chunkTranscript", () => {
  it("yields nothing for empty or blank input", () => {
    expect(chunkTranscript("")).toEqual([]);
    expect(chunkTranscript("  \n\n \n")).toEqual([]);
  });

  it("returns a short transcript as one chunk with whitespace collapsed", () => {
    expect(chunkTranscript("one  two\nthree")).toEqual(["one two three"]);
  });

  it("packs whole sentences and never cuts one in half", () => {
    expect(
      chunkTranscript("One two three. Four five six. Seven eight nine.", 6),
    ).toEqual(["One two three. Four five six.", "Seven eight nine."]);
  });

  it("hard-splits a punctuation-less run on word count", () => {
    const run = words(1200);
    const chunks = chunkTranscript(run);
    expect(chunks.map(countWords)).toEqual([500, 500, 200]);
    expect(chunks.join(" ")).toBe(run);
  });

  it("does not treat a decimal point as a sentence boundary", () => {
    expect(chunkTranscript("Call at 3.15pm. Then go.", 3)).toEqual([
      "Call at 3.15pm.",
      "Then go.",
    ]);
  });

  it("ends a sentence after a closing quote that follows the punctuation", () => {
    expect(chunkTranscript('He said "go." Then left.', 3)).toEqual([
      'He said "go."',
      "Then left.",
    ]);
  });

  it("treats paragraph breaks as boundaries but may merge paragraphs", () => {
    expect(chunkTranscript("alpha beta\n\ngamma delta", 3)).toEqual([
      "alpha beta",
      "gamma delta",
    ]);
    expect(chunkTranscript("alpha beta\n\ngamma delta", 10)).toEqual([
      "alpha beta gamma delta",
    ]);
  });
});

describe("stripThinkBlock", () => {
  it("drops the empty think block a thinking-off template emits", () => {
    expect(stripThinkBlock("<think>\n\n</think>\n\nHello.")).toBe("Hello.");
  });

  it("drops a think block with content", () => {
    expect(stripThinkBlock("<think>let me see</think>Hello.")).toBe("Hello.");
  });

  it("treats an unterminated think block as no output", () => {
    expect(stripThinkBlock("<think>never closed")).toBe("");
  });

  it("leaves ordinary text alone apart from trimming", () => {
    expect(stripThinkBlock("  Hello.  ")).toBe("Hello.");
  });
});

describe("maxTokensFor", () => {
  it("applies the model card's 1.3 × tokens + 32 ceiling", () => {
    // "a b c": max(ceil(5/4), ceil(3 × 1.3)) = 4 tokens → ceil(5.2) + 32.
    expect(maxTokensFor("a b c")).toBe(38);
    expect(maxTokensFor(words(500))).toBeGreaterThan(maxTokensFor(words(100)));
  });
});

describe("normalizeTranscript request", () => {
  it("posts greedy, thinking-off chat completions to <base>/chat/completions", async () => {
    const { fetchImpl, calls } = makeFetch(() => "Hello there.");
    const result = await normalizeTranscript(settings, "so um hello there", {
      fetchImpl,
    });
    expect(result).toEqual({
      text: "Hello there.",
      chunks: 1,
      fallbackChunks: 0,
      emptyChunks: 0,
    });
    expect(calls).toHaveLength(1);
    const [{ url, init, body }] = calls;
    expect(url).toBe("http://localhost:11434/v1/chat/completions");
    expect(body.model).toBe("s1-mini");
    expect(body.temperature).toBe(0);
    expect(body.max_tokens).toBe(maxTokensFor("so um hello there"));
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(body.messages[0]).toEqual({
      role: "system",
      content: S1_MINI_SYSTEM_PROMPT,
    });
    expect(body.messages[1].content).toBe(
      "[Styling: semi-formal] [Structure: prose] [Context: general]\n" +
        "so um hello there",
    );
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("sends a Bearer token only when a key is configured", async () => {
    const { fetchImpl, calls } = makeFetch(() => "Hi.");
    await normalizeTranscript(
      { ...settings, normalizerApiKey: "k", normalizerBaseUrl: "http://x/v1/" },
      "hi",
      { fetchImpl },
    );
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer k");
    expect(calls[0].url).toBe("http://x/v1/chat/completions");
  });

  it("uses an injected backend instead of fetch", async () => {
    const { fetchImpl, calls } = makeFetch(() => "unused");
    const backend: NormalizeBackend = async ({ messages }) =>
      `[${transcriptOf(messages[1].content)}]`;
    const result = await normalizeTranscript(settings, "hello", {
      fetchImpl,
      backend,
    });
    expect(result.text).toBe("[hello]");
    expect(calls).toHaveLength(0);
  });

  it("refuses to run without a server URL or model name", async () => {
    await expect(
      normalizeTranscript({ ...settings, normalizerBaseUrl: " " }, "hi"),
    ).rejects.toThrow(/server URL and model name/);
    await expect(
      normalizeTranscript({ ...settings, normalizerModel: "" }, "hi"),
    ).rejects.toThrow(/server URL and model name/);
  });
});

describe("normalizeTranscript chunks", () => {
  // 400 + 400 + 100 words in three paragraphs packs into 400 and 500.
  const long = `${words(400, "a")}\n\n${words(400, "b")}\n\n${words(100, "c")}`;
  const expectedChunks = chunkTranscript(long);

  it("sends chunks one at a time in order, reports progress, and joins paragraphs", async () => {
    expect(expectedChunks).toHaveLength(2);
    const { fetchImpl, calls, maxInFlight } = makeFetch((t) => t.toUpperCase());
    const progress: { chunk: number; total: number }[] = [];
    const result = await normalizeTranscript(settings, long, {
      fetchImpl,
      onProgress: (p) => progress.push(p),
    });
    expect(calls.map((c) => transcriptOf(c.body.messages[1].content))).toEqual(
      expectedChunks,
    );
    expect(maxInFlight()).toBe(1);
    expect(progress).toEqual([
      { chunk: 1, total: 2 },
      { chunk: 2, total: 2 },
    ]);
    expect(result.chunks).toBe(2);
    expect(result.text).toBe(
      expectedChunks.map((c) => c.toUpperCase()).join("\n\n"),
    );
  });

  it("strips a leading think block from each reply", async () => {
    const { fetchImpl } = makeFetch(
      (t) => `<think>\n\n</think>\n\n${t.toUpperCase()}`,
    );
    const result = await normalizeTranscript(settings, "hello world", {
      fetchImpl,
    });
    expect(result.text).toBe("HELLO WORLD");
  });

  it("keeps the raw chunk when the reply is wildly longer than the input", async () => {
    const raw = words(50);
    const { fetchImpl } = makeFetch((t) => `${t} ${t} ${t} ${t} ${t}`);
    const result = await normalizeTranscript(settings, raw, { fetchImpl });
    expect(result).toEqual({
      text: raw,
      chunks: 1,
      fallbackChunks: 1,
      emptyChunks: 0,
    });
  });

  it("keeps the raw chunk when a long chunk comes back empty", async () => {
    const { fetchImpl } = makeFetch((t, n) => (n === 1 ? t.toUpperCase() : ""));
    const result = await normalizeTranscript(settings, long, { fetchImpl });
    expect(result.fallbackChunks).toBe(1);
    expect(result.emptyChunks).toBe(1);
    expect(result.text).toBe(
      `${expectedChunks[0].toUpperCase()}\n\n${expectedChunks[1]}`,
    );
  });

  it("accepts an empty reply for filler-only input as a valid result", async () => {
    const { fetchImpl } = makeFetch(() => "");
    const result = await normalizeTranscript(settings, "um uh", { fetchImpl });
    expect(result).toEqual({
      text: "",
      chunks: 1,
      fallbackChunks: 0,
      emptyChunks: 1,
    });
  });

  it("fails loudly, naming the thinking flag, when every chunk of real speech is empty", async () => {
    const { fetchImpl } = makeFetch(() => "<think>\n\n</think>\n\n");
    await expect(
      normalizeTranscript(settings, words(50), { fetchImpl }),
    ).rejects.toThrow(/thinking/);
  });
});

describe("normalizeTranscript errors", () => {
  it("explains an unreachable server", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    await expect(
      normalizeTranscript(settings, "hi", { fetchImpl }),
    ).rejects.toThrow(
      /Could not reach the S1-mini server at http:\/\/localhost:11434\/v1/,
    );
  });

  it("adds a model-name hint to HTTP 404", async () => {
    const { fetchImpl } = makeFetch(
      () => new Response("model not found", { status: 404 }),
    );
    const err = await normalizeTranscript(settings, "hi", { fetchImpl }).catch(
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/HTTP 404/);
    expect((err as Error).message).toMatch(/ollama create s1-mini/);
  });

  it("passes other HTTP errors through unchanged", async () => {
    const { fetchImpl } = makeFetch(() => new Response("boom", { status: 500 }));
    const err = await normalizeTranscript(settings, "hi", { fetchImpl }).catch(
      (e: Error) => e,
    );
    expect((err as Error).message).toMatch(/HTTP 500 boom/);
    expect((err as Error).message).not.toMatch(/Could not reach/);
  });

  it("rejects a reply without message content", async () => {
    const { fetchImpl } = makeFetch(
      () => new Response(JSON.stringify({ choices: [] }), { status: 200 }),
    );
    await expect(
      normalizeTranscript(settings, "hi", { fetchImpl }),
    ).rejects.toThrow(/no message content/);
  });

  it("times out a request that never answers", async () => {
    const fetchImpl = ((_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      })) as unknown as typeof fetch;
    await expect(
      normalizeTranscript(settings, "hi", { fetchImpl, timeoutMs: 10 }),
    ).rejects.toThrow(/timed out after 1 s/);
  });
});


describe("normalizeSpeakerTranscript", () => {
  function echoBackend(seen: string[]): NormalizeBackend {
    return async ({ messages }) => {
      const t = transcriptOf(messages[1].content);
      seen.push(t);
      return `[${t}]`;
    };
  }

  it("delegates a plain transcript to normalizeTranscript unchanged", async () => {
    const seen: string[] = [];
    const text = words(30);
    const result = await normalizeSpeakerTranscript(settings, text, {
      backend: echoBackend(seen),
    });
    expect(seen).toEqual([text]);
    expect(result.text).toBe(`[${text}]`);
    expect(result.chunks).toBe(1);
  });

  it("keeps short turns verbatim and normalizes long turns with labels reattached", async () => {
    const seen: string[] = [];
    const first = words(30, "a");
    const third = words(25, "b");
    const transcript = `**Speaker 1:** ${first}\n\n**Speaker 2:** Yeah.\n\n**Alice:** ${third}`;
    const result = await normalizeSpeakerTranscript(settings, transcript, {
      backend: echoBackend(seen),
    });
    expect(seen).toEqual([first, third]);
    expect(result.text).toBe(
      `**Speaker 1:** [${first}]\n\n**Speaker 2:** Yeah.\n\n**Alice:** [${third}]`,
    );
    expect(result.chunks).toBe(2);
  });

  it("reports progress monotonically across turns", async () => {
    const backend: NormalizeBackend = async ({ messages }) =>
      transcriptOf(messages[1].content);
    const progress: string[] = [];
    // 600 words without punctuation hard-split into two chunks per turn.
    const turn = words(600);
    await normalizeSpeakerTranscript(settings, `**A:** ${turn}\n\n**B:** ${turn}`, {
      backend,
      onProgress: (p) => progress.push(`${p.chunk}/${p.total}`),
    });
    expect(progress).toEqual(["1/4", "2/4", "3/4", "4/4"]);
  });

  it("keeps a turn raw when only that turn comes back empty", async () => {
    let calls = 0;
    const backend: NormalizeBackend = async ({ messages }) => {
      calls++;
      return calls === 1 ? "" : transcriptOf(messages[1].content);
    };
    const a = words(30, "a");
    const b = words(30, "b");
    const result = await normalizeSpeakerTranscript(settings, `**A:** ${a}\n\n**B:** ${b}`, {
      backend,
    });
    expect(result.text).toBe(`**A:** ${a}\n\n**B:** ${b}`);
    expect(result.fallbackChunks).toBe(1);
    expect(result.emptyChunks).toBe(1);
  });

  it("raises the thinking hint when every long turn comes back empty", async () => {
    const backend: NormalizeBackend = async () => "";
    await expect(
      normalizeSpeakerTranscript(settings, `**A:** ${words(30)}\n\n**B:** Yes.`, {
        backend,
      }),
    ).rejects.toThrow(/thinking/i);
  });

  it("turns a multi-paragraph reply into continuation paragraphs under one label", async () => {
    const backend: NormalizeBackend = async ({ messages }) => {
      const ws = transcriptOf(messages[1].content).split(" ");
      return `${ws.slice(0, 10).join(" ")}\n\n${ws.slice(10).join(" ")}`;
    };
    const long = words(30);
    const ws = long.split(" ");
    const result = await normalizeSpeakerTranscript(settings, `**A:** ${long}`, {
      backend,
    });
    expect(result.text).toBe(
      `**A:** ${ws.slice(0, 10).join(" ")}\n\n${ws.slice(10).join(" ")}`,
    );
  });
});

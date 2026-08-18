import { describe, expect, it } from "vitest";
import {
  buildSummarizePrompt,
  callChatCompletion,
  parseSummaryResponse,
  sanitizeTags,
} from "../src/summarize";

describe("buildSummarizePrompt", () => {
  it("returns system + user messages requesting strict JSON", () => {
    const messages = buildSummarizePrompt("hello world");
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("system");
    expect(messages[1].role).toBe("user");
    const system = messages[0].content;
    expect(system).toContain("JSON");
    expect(system).toContain('"summary"');
    expect(system).toContain('"description"');
    expect(system).toContain('"tags"');
    expect(messages[1].content).toContain("hello world");
  });
});

describe("sanitizeTags", () => {
  it("lowercases and kebab-cases tags", () => {
    expect(sanitizeTags(["Project Alpha", "Q3 Planning"])).toEqual([
      "project-alpha",
      "q3-planning",
    ]);
  });

  it("dedupes case-insensitively", () => {
    expect(sanitizeTags(["meeting", "Meeting", "MEETING"])).toEqual([
      "meeting",
    ]);
  });

  it("drops empty and non-string entries", () => {
    expect(sanitizeTags(["", "  ", 42, null, "ok"])).toEqual(["ok"]);
  });

  it("caps at 8 tags", () => {
    const tags = Array.from({ length: 12 }, (_, i) => `tag${i}`);
    expect(sanitizeTags(tags)).toHaveLength(8);
  });

  it("returns [] for non-arrays", () => {
    expect(sanitizeTags("nope")).toEqual([]);
    expect(sanitizeTags(undefined)).toEqual([]);
  });
});

describe("parseSummaryResponse", () => {
  it("parses clean JSON", () => {
    const out = parseSummaryResponse(
      '{"summary":"S","description":"D","tags":["a","b"]}',
    );
    expect(out).toEqual({ summary: "S", description: "D", tags: ["a", "b"] });
  });

  it("parses fenced JSON", () => {
    const out = parseSummaryResponse(
      '```json\n{"summary":"S","description":"D","tags":["a"]}\n```',
    );
    expect(out.summary).toBe("S");
    expect(out.tags).toEqual(["a"]);
  });

  it("parses JSON surrounded by prose", () => {
    const out = parseSummaryResponse(
      'Here is the result:\n{"summary":"S","description":"D","tags":["a"]}\nHope that helps!',
    );
    expect(out.description).toBe("D");
  });

  it("sanitizes messy tags", () => {
    const out = parseSummaryResponse(
      '{"summary":"S","description":"D","tags":["Big Topic","big-topic","Big Topic","x y z"]}',
    );
    expect(out.tags).toEqual(["big-topic", "x-y-z"]);
  });

  it("accepts a response with only tags", () => {
    const out = parseSummaryResponse('{"tags":["a"]}');
    expect(out.tags).toEqual(["a"]);
    expect(out.summary).toBe("");
  });

  it("throws a useful error for non-JSON input", () => {
    expect(() => parseSummaryResponse("no json here")).toThrow(
      /No JSON object/,
    );
  });

  it("throws a useful error for invalid JSON", () => {
    expect(() => parseSummaryResponse('{"summary": }')).toThrow(/Invalid JSON/);
  });

  it("throws when the object has no usable fields", () => {
    expect(() => parseSummaryResponse('{"foo":"bar"}')).toThrow(
      /no usable/,
    );
  });
});

describe("callChatCompletion", () => {
  it("posts to /chat/completions and returns the message content", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const fakeFetch = (async (url: string, init: RequestInit) => {
      seen.url = url;
      seen.init = init;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"summary":"S"}' } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const content = await callChatCompletion(
      { llmBaseUrl: "https://api.openai.com/v1/", llmApiKey: "k", llmModel: "m" },
      [{ role: "user", content: "hi" }],
      fakeFetch,
    );
    expect(content).toBe('{"summary":"S"}');
    expect(seen.url).toBe("https://api.openai.com/v1/chat/completions");
    const headers = seen.init?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer k");
    const body = JSON.parse(seen.init?.body as string);
    expect(body.model).toBe("m");
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("omits the Authorization header when no key is set", async () => {
    const seen: { init?: RequestInit } = {};
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      seen.init = init;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    await callChatCompletion(
      { llmBaseUrl: "http://localhost:11434/v1", llmApiKey: "", llmModel: "llama" },
      [{ role: "user", content: "hi" }],
      fakeFetch,
    );
    const headers = seen.init?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("throws on HTTP errors", async () => {
    const fakeFetch = (async () =>
      new Response("boom", { status: 500 })) as unknown as typeof fetch;
    await expect(
      callChatCompletion(
        { llmBaseUrl: "http://x", llmApiKey: "", llmModel: "m" },
        [],
        fakeFetch,
      ),
    ).rejects.toThrow(/HTTP 500/);
  });
});

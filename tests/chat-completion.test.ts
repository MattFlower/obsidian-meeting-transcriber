import { describe, expect, it } from "vitest";
import {
  callChatCompletion,
  ChatCompletionHttpError,
} from "../src/chat-completion";

const llm = { llmBaseUrl: "http://localhost:11434/v1", llmApiKey: "", llmModel: "m" };

function makeFetch(response: () => Response) {
  const seen: { init?: RequestInit; body?: Record<string, unknown> } = {};
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    seen.init = init;
    seen.body = JSON.parse(init.body as string);
    return response();
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

const ok = () =>
  new Response(JSON.stringify({ choices: [{ message: { content: "x" } }] }), {
    status: 200,
  });

describe("callChatCompletion options", () => {
  it("defaults to temperature 0.2 with no max_tokens or extra fields", async () => {
    const { fetchImpl, seen } = makeFetch(ok);
    await callChatCompletion(llm, [{ role: "user", content: "hi" }], fetchImpl);
    expect(seen.body).toEqual({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.2,
    });
    expect(seen.init?.signal).toBeUndefined();
  });

  it("applies temperature, max_tokens, extra body fields and the abort signal", async () => {
    const { fetchImpl, seen } = makeFetch(ok);
    const controller = new AbortController();
    await callChatCompletion(llm, [], fetchImpl, {
      temperature: 0,
      maxTokens: 42,
      extraBody: { chat_template_kwargs: { enable_thinking: false } },
      signal: controller.signal,
    });
    expect(seen.body).toEqual({
      model: "m",
      messages: [],
      temperature: 0,
      max_tokens: 42,
      chat_template_kwargs: { enable_thinking: false },
    });
    expect(seen.init?.signal).toBe(controller.signal);
  });

  it("throws a ChatCompletionHttpError carrying status and body", async () => {
    const { fetchImpl } = makeFetch(() => new Response("nope", { status: 404 }));
    const err = await callChatCompletion(llm, [], fetchImpl).catch((e) => e);
    expect(err).toBeInstanceOf(ChatCompletionHttpError);
    expect(err.status).toBe(404);
    expect(err.body).toBe("nope");
    expect(err.message).toBe("LLM request failed: HTTP 404 nope");
  });
});

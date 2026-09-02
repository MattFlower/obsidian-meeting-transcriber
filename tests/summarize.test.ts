import { describe, expect, it } from "vitest";
import {
  buildCliPrompt,
  buildSummarizePrompt,
  callChatCompletion,
  extendedPath,
  parseSummaryResponse,
  runCliPrompt,
  sanitizeTags,
  splitCommand,
  summarizeTranscript,
  type SpawnImpl,
  type SummarizerSettings,
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

describe("buildCliPrompt", () => {
  it("contains the JSON-shape instructions and the transcript", () => {
    const prompt = buildCliPrompt("hello world");
    expect(prompt).toContain(
      '{"summary": string, "description": string, "tags": string[]}',
    );
    expect(prompt).toContain("hello world");
  });
});

function makeFakeSpawn(opts: {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  errorCode?: string;
  /** Never emit "close", to exercise the timeout path. */
  neverCloses?: boolean;
  /** Emit this as an "error" on stdin before close. */
  stdinError?: string;
}) {
  const exitCode = opts.exitCode ?? 0;
  const stdout = opts.stdout ?? "";
  const stderr = opts.stderr ?? "";
  const capture = { written: [] as string[], ended: false, killed: false };
  const spawnImpl = ((file: string, args: string[]) => {
    const stdoutListeners: Array<(chunk: string) => void> = [];
    const stderrListeners: Array<(chunk: string) => void> = [];
    const stdinListeners: Array<(err: Error) => void> = [];
    const childListeners: Record<string, Array<(...args: any[]) => void>> = {};
    // Same shape as a real ChildProcess: the prompt goes to child.stdin.
    const child = {
      stdin: {
        write: (d: string) => {
          capture.written.push(d);
          return true;
        },
        end: () => {
          capture.ended = true;
        },
        on: (ev: string, cb: (err: Error) => void) => {
          if (ev === "error") stdinListeners.push(cb);
          return undefined;
        },
      },
      stdout: {
        on: (ev: string, cb: (chunk: string) => void) => {
          if (ev === "data") stdoutListeners.push(cb);
          return undefined;
        },
      },
      stderr: {
        on: (ev: string, cb: (chunk: string) => void) => {
          if (ev === "data") stderrListeners.push(cb);
          return undefined;
        },
      },
      on: (ev: string, cb: (...args: any[]) => void) => {
        (childListeners[ev] ??= []).push(cb);
        return undefined;
      },
      kill: () => {
        capture.killed = true;
        return true;
      },
    };
    queueMicrotask(() => {
      stdoutListeners.forEach((cb) => cb(stdout));
      stderrListeners.forEach((cb) => cb(stderr));
      const stdinError = opts.stdinError;
      if (stdinError) {
        stdinListeners.forEach((cb) => cb(new Error(stdinError)));
      }
      if (opts.errorCode) {
        (childListeners["error"] ?? []).forEach((cb) =>
          cb({ code: opts.errorCode } as NodeJS.ErrnoException),
        );
      }
      if (!opts.neverCloses) {
        (childListeners["close"] ?? []).forEach((cb) => cb(exitCode));
      }
    });
    return child;
  }) as unknown as SpawnImpl;
  return { spawnImpl, capture };
}

describe("runCliPrompt", () => {
  it("resolves with trimmed stdout on exit 0 and writes the prompt to stdin", async () => {
    const { spawnImpl, capture } = makeFakeSpawn({
      exitCode: 0,
      stdout: "  answer text\n",
    });
    const out = await runCliPrompt("claude -p", "the prompt", spawnImpl);
    expect(out).toBe("answer text");
    expect(capture.written.join("")).toBe("the prompt");
  });

  it("closes stdin after writing the prompt so the CLI sees end-of-input", async () => {
    const { spawnImpl, capture } = makeFakeSpawn({ exitCode: 0, stdout: "ok" });
    await runCliPrompt("claude -p", "the prompt", spawnImpl);
    expect(capture.ended).toBe(true);
  });

  it("kills the child and rejects when it exceeds the timeout", async () => {
    const { spawnImpl, capture } = makeFakeSpawn({ neverCloses: true });
    await expect(
      runCliPrompt("claude -p", "p", spawnImpl, 20),
    ).rejects.toThrow(/timed out/);
    expect(capture.killed).toBe(true);
  });

  it("rejects an empty command without spawning", async () => {
    const { spawnImpl, capture } = makeFakeSpawn({});
    await expect(runCliPrompt("   ", "p", spawnImpl)).rejects.toThrow(/empty/);
    expect(capture.written).toEqual([]);
  });

  it("rejects an empty quoted command without spawning", async () => {
    const { spawnImpl, capture } = makeFakeSpawn({});
    await expect(runCliPrompt('"" -p', "p", spawnImpl)).rejects.toThrow(/empty/);
    expect(capture.written).toEqual([]);
  });

  it("carries a stdin error into the failure message", async () => {
    const { spawnImpl } = makeFakeSpawn({
      exitCode: 1,
      stdinError: "write EPIPE",
    });
    await expect(runCliPrompt("claude -p", "p", spawnImpl)).rejects.toThrow(
      /exited with code 1.*stdin error: write EPIPE/s,
    );
  });

  it("rejects on non-zero exit with stderr in the message", async () => {
    const { spawnImpl } = makeFakeSpawn({
      exitCode: 1,
      stderr: "first line\nboom happened",
    });
    await expect(
      runCliPrompt("claude -p", "p", spawnImpl),
    ).rejects.toThrow(/exited with code 1.*boom happened/s);
  });

  it("rejects with a 'command not found' error on ENOENT", async () => {
    const { spawnImpl } = makeFakeSpawn({ errorCode: "ENOENT" });
    await expect(
      runCliPrompt("nope-cli -p", "p", spawnImpl),
    ).rejects.toThrow(/command not found: `nope-cli`/);
  });
});

describe("splitCommand", () => {
  it("splits on runs of whitespace", () => {
    expect(splitCommand("  claude   -p ")).toEqual(["claude", "-p"]);
  });

  it("keeps a quoted path with spaces as one argument", () => {
    expect(splitCommand('"/Applications/My Tools/claude" -p')).toEqual([
      "/Applications/My Tools/claude",
      "-p",
    ]);
    expect(splitCommand("'/opt/x y/codex' exec")).toEqual([
      "/opt/x y/codex",
      "exec",
    ]);
  });

  it("returns [] for an empty command", () => {
    expect(splitCommand("   ")).toEqual([]);
  });
});

describe("extendedPath", () => {
  it("appends common install directories after the inherited PATH", () => {
    const out = extendedPath({ PATH: "/usr/bin:/bin" }, "darwin", "/Users/me");
    expect(out.split(":")).toEqual([
      "/usr/bin",
      "/bin",
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/Users/me/.local/bin",
      "/Users/me/.npm-global/bin",
      "/Users/me/bin",
    ]);
  });

  it("does not duplicate a directory already on PATH", () => {
    const out = extendedPath(
      { PATH: "/opt/homebrew/bin:/usr/bin" },
      "linux",
      "/home/me",
    );
    expect(out.startsWith("/opt/homebrew/bin:/usr/bin:")).toBe(true);
    expect(out.split(":").filter((p) => p === "/opt/homebrew/bin")).toHaveLength(1);
  });

  it("leaves PATH untouched on Windows", () => {
    expect(extendedPath({ Path: "C:\\Windows" }, "win32", "C:\\Users\\me")).toBe(
      "C:\\Windows",
    );
  });
});

// These run the real child_process path (no spawnImpl) so the contract with
// Node's ChildProcess is exercised, not a fake of it.
describe("runCliPrompt against a real child process", () => {
  const node = `"${process.execPath}"`;

  it("writes the prompt to stdin and returns stdout", async () => {
    const out = await runCliPrompt(
      `${node} -e "process.stdin.on('data',(d)=>process.stdout.write(d))"`,
      "hello from stdin",
    );
    expect(out).toBe("hello from stdin");
  });

  it("reports a non-zero exit with the stderr tail", async () => {
    await expect(
      runCliPrompt(
        `${node} -e "process.stderr.write('boom');process.exit(2)"`,
        "p",
      ),
    ).rejects.toThrow(/exited with code 2.*boom/s);
  });

  it("rejects with 'command not found' for a missing executable", async () => {
    await expect(
      runCliPrompt("definitely-not-a-real-cli-4f1c -p", "p"),
    ).rejects.toThrow(/command not found/);
  });

  it("survives a child that exits without reading its stdin", async () => {
    // A 1 MiB prompt cannot fit the pipe buffer, so the write hits EPIPE.
    const out = await runCliPrompt(
      `${node} -e process.exit(0)`,
      "x".repeat(1 << 20),
    );
    expect(out).toBe("");
  });
});

const baseSummarizerSettings: SummarizerSettings = {
  summarizerBackend: "cloud",
  llmBaseUrl: "https://api.openai.com/v1",
  llmApiKey: "sk-cloud",
  llmModel: "gpt-4o-mini",
  localBaseUrl: "http://localhost:11434/v1",
  localModel: "llama3.1",
  cliCommand: "claude -p",
};

function makeJsonFetch(label: string) {
  const seen: { calls: number; url?: string; init?: RequestInit } = {
    calls: 0,
  };
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.calls += 1;
    seen.url = url;
    seen.init = init;
    return new Response(
      JSON.stringify({ choices: [{ message: { content: label } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

describe("summarizeTranscript", () => {
  it("cloud backend calls the cloud URL with the API key", async () => {
    const { fetchImpl, seen } = makeJsonFetch('{"summary":"Cloud S"}');
    const result = await summarizeTranscript(
      baseSummarizerSettings,
      "transcript here",
      { fetchImpl },
    );
    expect(result.summary).toBe("Cloud S");
    expect(seen.url).toBe("https://api.openai.com/v1/chat/completions");
    const headers = seen.init?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer sk-cloud");
    const body = JSON.parse(seen.init?.body as string);
    expect(body.model).toBe("gpt-4o-mini");
  });

  it("local backend uses the local URL/model and sends no Authorization header", async () => {
    const { fetchImpl, seen } = makeJsonFetch('{"summary":"Local S"}');
    const result = await summarizeTranscript(
      { ...baseSummarizerSettings, summarizerBackend: "local" },
      "transcript here",
      { fetchImpl },
    );
    expect(result.summary).toBe("Local S");
    expect(seen.url).toBe("http://localhost:11434/v1/chat/completions");
    const headers = seen.init?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBeUndefined();
    const body = JSON.parse(seen.init?.body as string);
    expect(body.model).toBe("llama3.1");
  });

  it("cli backend runs the CLI and parses fenced JSON from its stdout", async () => {
    const { spawnImpl, capture } = makeFakeSpawn({
      exitCode: 0,
      stdout:
        '```json\n{"summary":"CLI S","description":"d","tags":["a"]}\n```',
    });
    const result = await summarizeTranscript(
      { ...baseSummarizerSettings, summarizerBackend: "cli" },
      "transcript here",
      { spawnImpl },
    );
    expect(result).toEqual({
      summary: "CLI S",
      description: "d",
      tags: ["a"],
    });
    // the CLI prompt carries the transcript and the JSON-shape instructions
    expect(capture.written.join("")).toContain("transcript here");
    expect(capture.written.join("")).toContain('"summary"');
  });

  it("switching the backend changes which dependency is invoked", async () => {
    const { fetchImpl, seen } = makeJsonFetch('{"summary":"S"}');
    const { spawnImpl, capture } = makeFakeSpawn({
      exitCode: 0,
      stdout: '{"summary":"CLI S"}',
    });
    const deps = { fetchImpl, spawnImpl };

    await summarizeTranscript(
      { ...baseSummarizerSettings, summarizerBackend: "cli" },
      "t",
      deps,
    );
    expect(capture.written).toHaveLength(1);
    expect(seen.calls).toBe(0);

    await summarizeTranscript(
      { ...baseSummarizerSettings, summarizerBackend: "local" },
      "t",
      deps,
    );
    expect(capture.written).toHaveLength(1);
    expect(seen.calls).toBe(1);
  });
});

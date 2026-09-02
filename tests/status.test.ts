import { describe, expect, it, vi } from "vitest";

import { StatusBoard } from "../src/status";

function makeBoard(): { board: StatusBoard; render: ReturnType<typeof vi.fn> } {
  const render = vi.fn();
  return { board: new StatusBoard(render), render };
}

describe("StatusBoard", () => {
  it("renders one owner's line and clears it with an empty string", () => {
    const { board, render } = makeBoard();
    board.set("transcribe:a.mp3", "Decoding audio…");
    expect(render).toHaveBeenLastCalledWith("Decoding audio…");
    board.set("transcribe:a.mp3", "");
    expect(render).toHaveBeenLastCalledWith("");
    expect(board.text()).toBe("");
  });

  it("keeps a file transcription's text while the live panel refreshes and clears its own", () => {
    const { board } = makeBoard();
    board.set("transcribe:a.mp3", "Transcribing (this can take a while)…");
    board.set("live-panel-1", "● Live recording 00:01");
    expect(board.text()).toBe(
      "Transcribing (this can take a while)… · ● Live recording 00:01",
    );

    // Updating an existing owner keeps its position.
    board.set("live-panel-1", "● Live recording 00:02");
    expect(board.text()).toBe(
      "Transcribing (this can take a while)… · ● Live recording 00:02",
    );

    board.set("live-panel-1", "");
    expect(board.text()).toBe("Transcribing (this can take a while)…");
    board.set("transcribe:a.mp3", "");
    expect(board.text()).toBe("");
  });

  it("only invokes the renderer when the visible text changes", () => {
    const { board, render } = makeBoard();
    board.set("nobody", "");
    expect(render).not.toHaveBeenCalled();

    board.set("model-download", "Model 2/4: decoder.int8.onnx");
    board.set("model-download", "Model 2/4: decoder.int8.onnx");
    expect(render).toHaveBeenCalledTimes(1);

    board.set("model-download", "");
    board.set("model-download", "");
    expect(render).toHaveBeenCalledTimes(2);
    expect(render).toHaveBeenLastCalledWith("");
  });

  it("caps the joined text with an ellipsis", () => {
    const board = new StatusBoard(vi.fn(), 24);
    board.set("a", "Transcribing (this can take a while)…");
    board.set("b", "● Live recording 00:01");
    expect(board.text()).toBe("Transcribing (this can …");
    expect(board.text()).toHaveLength(24);
  });
});

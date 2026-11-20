import { describe, expect, it } from "vitest";
import { parseHubMessage } from "./protocol";

describe("parseHubMessage (PROTOCOL.md)", () => {
  it("treats an untyped message as a pose", () => {
    expect(parseHubMessage('{"x": 1420.5, "y": 980.2, "yaw_deg": 37.4}')).toEqual({
      kind: "pose",
      pose: { x: 1420.5, y: 980.2, yaw_deg: 37.4 },
    });
  });

  it("defaults a missing yaw to 0", () => {
    expect(parseHubMessage({ x: 1, y: 2 })).toEqual({ kind: "pose", pose: { x: 1, y: 2, yaw_deg: 0 } });
  });

  it("parses state, control, hello and diag", () => {
    expect(parseHubMessage('{"type":"state","state":{"placed":true}}').kind).toBe("state");
    expect(parseHubMessage('{"type":"control","patch":{"model_denom":40}}')).toEqual({
      kind: "control",
      patch: { model_denom: 40 },
    });
    expect(parseHubMessage('{"type":"hello"}').kind).toBe("hello");
    expect(parseHubMessage('{"type":"diag","build":"x"}').kind).toBe("diag");
  });

  it("ignores unknown types, junk and typed messages that look like poses", () => {
    expect(parseHubMessage('{"type":"future-thing"}').kind).toBe("ignored");
    expect(parseHubMessage("not json").kind).toBe("ignored");
    expect(parseHubMessage("[1,2]").kind).toBe("ignored");
    expect(parseHubMessage('{"type":"other","x":1,"y":2}').kind).toBe("ignored");
    expect(parseHubMessage('{"x":"1","y":2}').kind).toBe("ignored");
  });
});

import { describe, expect, it } from "vitest";
import { encodeSharedPlan, parseHubMessage } from "./protocol";

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

describe("shared plan messages (PROTOCOL.md Plan)", () => {
  const plan = { schema_version: "2.0", walls: [], rooms: [] };

  it("round-trips through encodeSharedPlan and parseHubMessage", () => {
    const text = encodeSharedPlan({ plan_id: "p1", name: "Flat", plan, ppm: 50, wall_height_m: 2.5 });
    expect(text).not.toBeNull();
    expect(parseHubMessage(text)).toEqual({
      kind: "plan",
      shared: { plan_id: "p1", name: "Flat", plan, ppm: 50, wall_height_m: 2.5 },
    });
  });

  it("refuses to encode a plan over the byte limit", () => {
    expect(encodeSharedPlan({ plan_id: "p", name: "n", plan }, 50)).toBeNull();
  });

  it("ignores plan messages without a walls array and cleans optional fields", () => {
    expect(parseHubMessage('{"type":"plan","plan":{}}').kind).toBe("ignored");
    expect(parseHubMessage('{"type":"plan","plan":[1]}').kind).toBe("ignored");
    const m = parseHubMessage('{"type":"plan","plan":{"walls":[]},"ppm":-1,"name":"  "}');
    expect(m).toEqual({ kind: "plan", shared: { plan_id: "", name: "Shared plan", plan: { walls: [] }, ppm: undefined, wall_height_m: undefined } });
  });

  it("ignores plan_rejected (unknown to clients)", () => {
    expect(parseHubMessage('{"type":"plan_rejected","reason":"x"}').kind).toBe("ignored");
  });
});

/**
 * Loads the bundled sample plans from public/samples for tests, so tests run on
 * the exact files the app ships and seeds.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { RawPlan } from "@/lib/plan";

export function loadSample(name: string): RawPlan {
  const file = resolve(__dirname, "../../public/samples", `${name}.json`);
  return JSON.parse(readFileSync(file, "utf-8")) as RawPlan;
}

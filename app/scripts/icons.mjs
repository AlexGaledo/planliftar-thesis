// Renders the PlanVisAR icons (public/icons/*.png + logo.svg) from the mark in
// src/components/Logo.tsx. Run: node scripts/icons.mjs
import { writeFile } from "node:fs/promises";
import { chromium } from "@playwright/test";

const C = { paper: "#fafaf7", ink: "#12302f", accent: "#c2410c" };
const mark = ({ ink, accent, paper }) => `
  <ellipse cx="32" cy="58.5" rx="11" ry="3" stroke="${accent}" stroke-width="2.5"/>
  <path d="M32 5 C19.5 5 11.5 14.2 11.5 25.5 C11.5 39.5 32 56 32 56 C32 56 52.5 39.5 52.5 25.5 C52.5 14.2 44.5 5 32 5 Z" fill="${ink}"/>
  <path d="M28 35 H22 V16 H42 V35 H33" stroke="${paper}" stroke-width="2.6"/>
  <path d="M32 16 V23 M22 26 H28" stroke="${paper}" stroke-width="2.6"/>
  <circle cx="37" cy="29" r="2.6" fill="${accent}"/>`;

// scale = share of the canvas the 64-unit mark occupies (maskable keeps it in the 80% safe zone).
const svg = (scale, bg = true) => {
  const pad = (64 / scale - 64) / 2;
  const box = 64 + 2 * pad;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-pad} ${-pad} ${box} ${box}" fill="none" stroke-linecap="round" stroke-linejoin="round">${
    bg ? `<rect x="${-pad}" y="${-pad}" width="${box}" height="${box}" fill="${C.paper}"/>` : ""
  }${mark(C)}</svg>`;
};

await writeFile("public/icons/logo.svg", svg(1, false));
const browser = await chromium.launch();
const page = await browser.newPage();
for (const [name, size, scale] of [
  ["icon-192", 192, 0.82],
  ["icon-512", 512, 0.82],
  ["maskable-192", 192, 0.6],
  ["maskable-512", 512, 0.6],
  ["apple-touch-icon", 180, 0.72],
]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0}svg{display:block;width:${size}px;height:${size}px}</style>${svg(scale)}`);
  await page.screenshot({ path: `public/icons/${name}.png`, omitBackground: false });
  console.log("wrote", name);
}
await browser.close();

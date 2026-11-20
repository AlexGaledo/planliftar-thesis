/** Error paths: corrupt file, huge file, server down. */
import { connect } from "node:net";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function uploadExpectingError(page: Page, name: string, buffer: Buffer) {
  await page.goto("/new");
  await page.locator("#image-input").setInputFiles({ name, mimeType: "image/png", buffer });
  await page.getByRole("button", { name: "Analyse plan" }).click();
  const alert = page.locator("form").getByRole("alert");
  await expect(alert).toBeVisible();
  await expect(alert).not.toContainText(/Failed to fetch|TypeError|HTTP \d{3}/);
  await expect(page).toHaveURL(/\/new$/);
  return alert;
}

test("a corrupt image is refused by the server with a readable message", async ({ page, diag }) => {
  diag.allowConsole("status of 415", "status of 400");
  // Not an image at all: the server checks magic bytes (415).
  const notImage = await uploadExpectingError(page, "broken.png", Buffer.from("this is not a png at all"));
  await expect(notImage).toContainText("PNG, JPEG or WebP");
  // A PNG header followed by garbage: it gets past the type check, then fails to decode (400).
  const truncated = await uploadExpectingError(page, "truncated.png", Buffer.concat([PNG_MAGIC, Buffer.alloc(200, 7)]));
  await expect(truncated).toContainText(/image/i);
});

/** POST a body of `size` bytes and return the status as soon as the server answers (it may not read it all). */
function postHuge(baseURL: string, size: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(baseURL);
    const boundary = "----e2eboundary";
    // Headers only, no body bytes: the server must answer from Content-Length
    // alone. (Sending body bytes it never reads makes Windows reset the
    // connection, which can swallow the 413 before we read it.)
    const sock = connect(Number(url.port || 80), url.hostname, () => {
      sock.write(
        `POST /api/jobs HTTP/1.1\r\nHost: ${url.host}\r\nContent-Type: multipart/form-data; boundary=${boundary}\r\n` +
          `Content-Length: ${size}\r\nConnection: close\r\n\r\n`,
      );
    });
    let raw = "";
    sock.on("data", (c) => {
      raw += c.toString("latin1");
      const split = raw.indexOf("\r\n\r\n");
      const len = /content-length:\s*(\d+)/i.exec(raw)?.[1];
      if (split >= 0 && len && raw.length >= split + 4 + Number(len)) {
        sock.destroy();
        resolve({ status: Number(raw.split(" ")[1]), body: raw.slice(split + 4, split + 4 + Number(len)) });
      }
    });
    sock.on("error", reject);
  });
}

test("a file over 15 MB is caught before upload, and the server refuses one too", async ({ page, baseURL }) => {
  await page.goto("/new");
  let uploaded = false;
  page.on("request", (r) => {
    if (r.url().endsWith("/api/jobs") && r.method() === "POST") uploaded = true;
  });
  const huge = Buffer.alloc(16 * 1024 * 1024, 0);
  PNG_MAGIC.copy(huge);
  await page.locator("#image-input").setInputFiles({ name: "huge.png", mimeType: "image/png", buffer: huge });
  await expect(page.getByRole("alert")).toContainText("15 MB");
  await expect(page.getByRole("button", { name: "Analyse plan" })).toBeDisabled();
  expect(uploaded).toBe(false);

  // The server refuses on Content-Length, before reading the body. It answers
  // 413 and closes the connection, so read the status with a raw socket rather
  // than an HTTP client that insists on sending the whole body first.
  const res = await Promise.race([
    postHuge(baseURL!, 17 * 1024 * 1024),
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error("no answer to a 17 MB upload in 15 s")), 15_000)),
  ]);
  expect(res.status).toBe(413);
  expect(JSON.parse(res.body).error).toMatch(/15 MB/);
});

test("server down: upload and status explain it and offer demo mode", async ({ page, diag }) => {
  diag.allowConsole("Failed to load resource", "ERR_CONNECTION_REFUSED", "ERR_FAILED");
  await page.route("**/api/**", (route) => route.abort("connectionrefused"));
  await page.goto("/new");
  await expect(page.getByText("The analysis server is not reachable.")).toBeVisible();
  await page.locator("#image-input").setInputFiles({ name: "plan.png", mimeType: "image/png", buffer: Buffer.from("x") });
  await page.getByRole("button", { name: "Analyse plan" }).click();
  const alert = page.locator("form").getByRole("alert");
  await expect(alert).toContainText("Cannot reach the server");
  await expect(alert.getByRole("button", { name: /demo/i })).toBeVisible();
});

test("an unknown or expired job says so", async ({ page, diag }) => {
  diag.allowConsole("404");
  await page.goto("/new/job/does-not-exist");
  await expect(page.getByRole("alert")).toContainText(/no longer on the server|Upload the plan again/);
});

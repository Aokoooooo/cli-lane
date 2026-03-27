import { expect, test } from "bun:test";
import path from "node:path";
import { normalizeCwd } from "../src/path-utils";

test("normalizes cwd consistently", async () => {
  const cwd = await normalizeCwd("./");
  expect(cwd.length).toBeGreaterThan(0);
});

test("resolves relative paths to absolute paths", async () => {
  const cwd = await normalizeCwd(".");
  expect(path.isAbsolute(cwd)).toBe(true);
});

test("strips trailing separators", async () => {
  const cwd = await normalizeCwd("./");
  expect(cwd.endsWith(path.sep)).toBe(false);
});

test("falls back when realpath fails", async () => {
  const cwd = await normalizeCwd("does-not-exist");
  expect(cwd).toContain("does-not-exist");
});

test("is idempotent for normalized paths", async () => {
  const cwd = await normalizeCwd(".");
  expect(await normalizeCwd(cwd)).toBe(cwd);
});

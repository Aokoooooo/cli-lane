import { expect, test } from "bun:test";

test("cli prints help output", () => {
  const result = Bun.spawnSync([process.execPath, "run", "src/cli.ts", "--help"], {
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(result.exitCode).toBe(0);
  expect(new TextDecoder().decode(result.stdout).trim()).toBe("cli-lane");
});

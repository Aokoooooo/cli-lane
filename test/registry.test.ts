import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  acquireStartupLock,
  isStaleLock,
  isStaleRegistration,
  readRegistration,
  releaseStartupLock,
  removeRegistration,
  writeRegistration,
  type Registration,
} from "../src/registry";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createTempDir() {
  const dir = await mkdtemp(join(tmpdir(), "cli-lane-registry-test-"));
  tempDirs.push(dir);
  return dir;
}

function createRegistration(overrides: Partial<Registration> = {}): Registration {
  return {
    pid: process.pid,
    port: 4312,
    token: "token-1",
    startedAt: 1_700_000_000_000,
    version: "1.0.0",
    protocolVersion: 1,
    ...overrides,
  };
}

test("writes, reads, and removes registration files", async () => {
  const dir = await createTempDir();
  const filePath = join(dir, "server", "registration.json");
  const registration = createRegistration();

  await writeRegistration(filePath, registration);

  expect(await readRegistration(filePath)).toEqual(registration);

  await removeRegistration(filePath);

  expect(await readRegistration(filePath)).toBeNull();
});

test("treats registrations as stale when coordinator connection fails", () => {
  const registration = createRegistration();

  expect(
    isStaleRegistration(registration, {
      pidExists: true,
      connectOk: false,
      tokenMatches: true,
      protocolMatches: true,
    }),
  ).toBe(true);
});

test("keeps healthy registrations non-stale", () => {
  const registration = createRegistration();

  expect(
    isStaleRegistration(registration, {
      pidExists: true,
      connectOk: true,
      tokenMatches: true,
      protocolMatches: true,
    }),
  ).toBe(false);
});

test("treats registrations as stale when the recorded pid is gone", () => {
  const registration = createRegistration({ pid: 999_999 });

  expect(
    isStaleRegistration(registration, {
      pidExists: false,
      connectOk: true,
      tokenMatches: true,
      protocolMatches: true,
    }),
  ).toBe(true);
});

test("treats registrations as stale when the token does not match", () => {
  const registration = createRegistration();

  expect(
    isStaleRegistration(registration, {
      pidExists: true,
      connectOk: true,
      tokenMatches: false,
      protocolMatches: true,
    }),
  ).toBe(true);
});

test("treats registrations as stale when the protocol version does not match", () => {
  const registration = createRegistration();

  expect(
    isStaleRegistration(registration, {
      pidExists: true,
      connectOk: true,
      tokenMatches: true,
      protocolMatches: false,
    }),
  ).toBe(true);
});

test("acquires and releases startup locks", async () => {
  const dir = await createTempDir();
  const filePath = join(dir, "locks", "startup.lock");

  expect(
    await acquireStartupLock(filePath, {
      pid: process.pid,
      acquiredAt: 100,
      staleAfterMs: 1_000,
    }),
  ).toBe(true);

  expect(
    await acquireStartupLock(filePath, {
      pid: process.pid,
      acquiredAt: 200,
      staleAfterMs: 1_000,
    }),
  ).toBe(false);

  await releaseStartupLock(filePath);

  expect(
    await acquireStartupLock(filePath, {
      pid: process.pid,
      acquiredAt: 300,
      staleAfterMs: 1_000,
    }),
  ).toBe(true);
});

test("treats locks as stale after the timeout", () => {
  expect(
    isStaleLock(
      {
        pid: process.pid,
        acquiredAt: 100,
      },
      {
        pidExists: true,
        now: 1_500,
        staleAfterMs: 1_000,
        startupTimeoutMs: 5_000,
        coordinatorAvailable: false,
      },
    ),
  ).toBe(true);
});

test("treats locks as stale when the lock holder pid is gone", () => {
  expect(
    isStaleLock(
      {
        pid: 999_999,
        acquiredAt: 100,
      },
      {
        pidExists: false,
        now: 150,
        staleAfterMs: 1_000,
        startupTimeoutMs: 5_000,
        coordinatorAvailable: false,
      },
    ),
  ).toBe(true);
});

test("treats locks as stale when startup timed out without a usable coordinator", () => {
  expect(
    isStaleLock(
      {
        pid: process.pid,
        acquiredAt: 100,
      },
      {
        pidExists: true,
        now: 1_500,
        staleAfterMs: 10_000,
        startupTimeoutMs: 1_000,
        coordinatorAvailable: false,
      },
    ),
  ).toBe(true);
});

test("retries bootstrap when an existing startup lock timed out", async () => {
  const dir = await createTempDir();
  const filePath = join(dir, "locks", "startup.lock");
  await mkdir(dirname(filePath), { recursive: true });
  await Bun.write(filePath, JSON.stringify({ pid: process.pid, acquiredAt: 100 }));

  expect(
    await acquireStartupLock(filePath, {
      pid: process.pid,
      acquiredAt: 1_500,
      staleAfterMs: 10_000,
      startupTimeoutMs: 1_000,
      coordinatorAvailable: () => false,
    }),
  ).toBe(true);
});

test("replaces a startup lock left by a dead process", async () => {
  const dir = await createTempDir();
  const filePath = join(dir, "locks", "startup.lock");
  await mkdir(dirname(filePath), { recursive: true });
  await Bun.write(filePath, JSON.stringify({ pid: 999_999, acquiredAt: 100 }));

  expect(
    await acquireStartupLock(filePath, {
      pid: process.pid,
      acquiredAt: 200,
      staleAfterMs: 10_000,
      startupTimeoutMs: 1_000,
      pidExists: (pid) => pid === process.pid,
      coordinatorAvailable: () => false,
    }),
  ).toBe(true);
});

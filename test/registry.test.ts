import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
  type StartupLock,
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

function createLock(overrides: Partial<StartupLock> = {}): StartupLock {
  return {
    pid: process.pid,
    acquiredAt: 100,
    ownerId: "owner-1",
    ...overrides,
  };
}

test("missing registration files return null explicitly", async () => {
  const dir = await createTempDir();
  const filePath = join(dir, "server", "registration.json");

  expect(await readRegistration(filePath)).toBeNull();
});

test("corrupt or partial registration files are treated as unavailable", async () => {
  const dir = await createTempDir();
  const filePath = join(dir, "server", "registration.json");
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, '{"pid":123,"token":"partial"', "utf8");

  expect(await readRegistration(filePath)).toBeNull();
});

test("writes, reads, and removes registration files", async () => {
  const dir = await createTempDir();
  const filePath = join(dir, "server", "registration.json");
  const registration = createRegistration();

  await writeRegistration(filePath, registration);

  expect(await readRegistration(filePath)).toEqual(registration);

  await removeRegistration(filePath);

  expect(await readRegistration(filePath)).toBeNull();
});

test("writes registration atomically without leaving temp files behind", async () => {
  const dir = await createTempDir();
  const parentDir = join(dir, "server");
  const filePath = join(parentDir, "registration.json");
  const registration = createRegistration();

  await writeRegistration(filePath, registration);

  expect(await readFile(filePath, "utf8")).toBe(JSON.stringify(registration));
  expect((await readdir(parentDir)).filter((entry) => entry.startsWith("registration.json.") && entry.endsWith(".tmp"))).toEqual([]);
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

test("acquires and releases startup locks with explicit ownership", async () => {
  const dir = await createTempDir();
  const filePath = join(dir, "locks", "startup.lock");

  const firstOwner = await acquireStartupLock(filePath, {
    pid: process.pid,
    acquiredAt: 100,
    staleAfterMs: 1_000,
    startupTimeoutMs: 1_000,
    ownerId: "owner-1",
  });
  expect(firstOwner).toEqual(createLock());

  expect(
    await acquireStartupLock(filePath, {
      pid: process.pid,
      acquiredAt: 200,
      staleAfterMs: 1_000,
      startupTimeoutMs: 1_000,
      ownerId: "owner-2",
      coordinatorAvailable: () => true,
    }),
  ).toBeNull();

  expect(await releaseStartupLock(filePath, firstOwner!)).toBe(true);

  const secondOwner = await acquireStartupLock(filePath, {
    pid: process.pid,
    acquiredAt: 300,
    staleAfterMs: 1_000,
    startupTimeoutMs: 1_000,
    ownerId: "owner-3",
  });
  expect(secondOwner).toEqual(createLock({ acquiredAt: 300, ownerId: "owner-3" }));
});

test("treats locks as stale after the timeout", () => {
  expect(
    isStaleLock(
      createLock(),
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
      createLock({ pid: 999_999 }),
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
      createLock(),
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
  await writeFile(filePath, JSON.stringify(createLock()), "utf8");

  const newOwner = await acquireStartupLock(filePath, {
    pid: process.pid,
    acquiredAt: 1_500,
    staleAfterMs: 10_000,
    startupTimeoutMs: 1_000,
    ownerId: "owner-2",
    coordinatorAvailable: () => false,
  });

  expect(newOwner).toEqual(createLock({ acquiredAt: 1_500, ownerId: "owner-2" }));
  expect(await readFile(filePath, "utf8")).toBe(
    JSON.stringify(createLock({ acquiredAt: 1_500, ownerId: "owner-2" })),
  );
});

test("replaces a startup lock left by a dead process", async () => {
  const dir = await createTempDir();
  const filePath = join(dir, "locks", "startup.lock");
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(createLock({ pid: 999_999, ownerId: "dead-owner" })), "utf8");

  const newOwner = await acquireStartupLock(filePath, {
    pid: process.pid,
    acquiredAt: 200,
    staleAfterMs: 10_000,
    startupTimeoutMs: 1_000,
    ownerId: "owner-2",
    pidExists: (pid) => pid === process.pid,
    coordinatorAvailable: () => false,
  });

  expect(newOwner).toEqual(createLock({ acquiredAt: 200, ownerId: "owner-2" }));
});

test("contested stale takeover must not clobber a newer lock", async () => {
  const dir = await createTempDir();
  const filePath = join(dir, "locks", "startup.lock");
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(createLock({ pid: 999_999, ownerId: "stale-owner" })), "utf8");

  const firstTakeover = await acquireStartupLock(filePath, {
    pid: process.pid,
    acquiredAt: 200,
    staleAfterMs: 10_000,
    startupTimeoutMs: 1_000,
    ownerId: "fresh-owner",
    pidExists: (pid) => pid === process.pid,
    coordinatorAvailable: () => false,
  });
  const contestedTakeover = await acquireStartupLock(filePath, {
    pid: process.pid,
    acquiredAt: 300,
    staleAfterMs: 10_000,
    startupTimeoutMs: 1_000,
    ownerId: "contender-owner",
    coordinatorAvailable: () => true,
  });

  expect(firstTakeover).toEqual(createLock({ acquiredAt: 200, ownerId: "fresh-owner" }));
  expect(contestedTakeover).toBeNull();
  expect(await readFile(filePath, "utf8")).toBe(
    JSON.stringify(createLock({ acquiredAt: 200, ownerId: "fresh-owner" })),
  );
});

test("stale owner cleanup must not delete a newer lock", async () => {
  const dir = await createTempDir();
  const filePath = join(dir, "locks", "startup.lock");
  const oldOwner = createLock({ pid: 999_999, ownerId: "stale-owner" });
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(oldOwner), "utf8");

  const newOwner = await acquireStartupLock(filePath, {
    pid: process.pid,
    acquiredAt: 200,
    staleAfterMs: 10_000,
    startupTimeoutMs: 1_000,
    ownerId: "fresh-owner",
    pidExists: (pid) => pid === process.pid,
    coordinatorAvailable: () => false,
  });

  expect(await releaseStartupLock(filePath, oldOwner)).toBe(false);
  expect(await readFile(filePath, "utf8")).toBe(
    JSON.stringify(createLock({ acquiredAt: 200, ownerId: "fresh-owner" })),
  );
  expect(newOwner).toEqual(createLock({ acquiredAt: 200, ownerId: "fresh-owner" }));
});

test("stale guard recovery allows lock takeover to proceed", async () => {
  const dir = await createTempDir();
  const filePath = join(dir, "locks", "startup.lock");
  const guardPath = `${filePath}.guard`;
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(createLock({ pid: 999_999, ownerId: "stale-lock" })), "utf8");
  await writeFile(
    guardPath,
    JSON.stringify(createLock({ pid: 999_999, acquiredAt: 0, ownerId: "stale-guard" })),
    "utf8",
  );

  const newOwner = await acquireStartupLock(filePath, {
    pid: process.pid,
    acquiredAt: 200,
    staleAfterMs: 10_000,
    startupTimeoutMs: 1_000,
    ownerId: "fresh-owner",
    pidExists: (pid) => pid === process.pid,
    coordinatorAvailable: () => false,
  });

  expect(newOwner).toEqual(createLock({ acquiredAt: 200, ownerId: "fresh-owner" }));
  expect(await readFile(filePath, "utf8")).toBe(
    JSON.stringify(createLock({ acquiredAt: 200, ownerId: "fresh-owner" })),
  );
});

test("a newer valid guard is not removed by a contender", async () => {
  const dir = await createTempDir();
  const filePath = join(dir, "locks", "startup.lock");
  const guardPath = `${filePath}.guard`;
  const validGuard = createLock({
    pid: process.pid,
    acquiredAt: Date.now(),
    ownerId: "valid-guard",
  });
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(createLock({ pid: 999_999, ownerId: "stale-lock" })), "utf8");
  await writeFile(guardPath, JSON.stringify(validGuard), "utf8");

  expect(
    await acquireStartupLock(filePath, {
      pid: process.pid,
      acquiredAt: 200,
      staleAfterMs: 10_000,
      startupTimeoutMs: 1_000,
      ownerId: "contender-owner",
      pidExists: (pid) => pid === process.pid,
      coordinatorAvailable: () => false,
      guardTimeoutMs: 20,
    }),
  ).toBeNull();

  expect(await readFile(guardPath, "utf8")).toBe(JSON.stringify(validGuard));
  expect(await readFile(filePath, "utf8")).toBe(
    JSON.stringify(createLock({ pid: 999_999, ownerId: "stale-lock" })),
  );
});

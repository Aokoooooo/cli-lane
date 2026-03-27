import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type Registration = {
  pid: number;
  port: number;
  token: string;
  startedAt: number;
  version: string;
  protocolVersion: number;
};

export type RegistrationHealth = {
  pidExists: boolean;
  connectOk: boolean;
  tokenMatches: boolean;
  protocolMatches: boolean;
};

export type StartupLock = {
  pid: number;
  acquiredAt: number;
  ownerId: string;
};

export type StartupLockState = {
  pidExists: boolean;
  now: number;
  staleAfterMs: number;
  startupTimeoutMs: number;
  coordinatorAvailable: boolean;
};

export type AcquireStartupLockOptions = {
  pid: number;
  acquiredAt: number;
  staleAfterMs: number;
  startupTimeoutMs: number;
  ownerId?: string;
  now?: number;
  pidExists?: (pid: number) => boolean;
  coordinatorAvailable?: () => boolean;
  guardNow?: () => number;
  guardPidExists?: (pid: number) => boolean;
  guardStaleAfterMs?: number;
  guardTimeoutMs?: number;
  onBeforeStaleGuardIsolation?: () => void | Promise<void>;
};

type LockFileRecord = {
  raw: string;
  lock: StartupLock | null;
};

type MutationGuardOptions = {
  now?: () => number;
  pidExists?: (pid: number) => boolean;
  staleAfterMs?: number;
  timeoutMs?: number;
  beforeStaleGuardIsolation?: () => void | Promise<void>;
};

const defaultGuardStaleAfterMs = 1_000;
const defaultGuardTimeoutMs = 1_000;

export async function readRegistration(filePath: string): Promise<Registration | null> {
  return readJsonFile<Registration>(filePath);
}

export async function writeRegistration(filePath: string, registration: Registration): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });

  const tempPath = createTempPath(filePath);
  try {
    await writeFile(tempPath, JSON.stringify(registration), "utf8");
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

export async function removeRegistration(filePath: string): Promise<void> {
  await rm(filePath, { force: true });
}

export function isStaleRegistration(
  _registration: Registration,
  state: RegistrationHealth,
): boolean {
  return !state.pidExists || !state.connectOk || !state.tokenMatches || !state.protocolMatches;
}

export function isStaleLock(lock: StartupLock, state: StartupLockState): boolean {
  if (!state.pidExists) {
    return true;
  }

  const ageMs = state.now - lock.acquiredAt;
  if (ageMs > state.staleAfterMs) {
    return true;
  }

  return ageMs > state.startupTimeoutMs && !state.coordinatorAvailable;
}

export async function acquireStartupLock(
  filePath: string,
  options: AcquireStartupLockOptions,
): Promise<StartupLock | null> {
  await mkdir(dirname(filePath), { recursive: true });

  const nextLock: StartupLock = {
    pid: options.pid,
    acquiredAt: options.acquiredAt,
    ownerId: options.ownerId ?? randomUUID(),
  };

  if (await tryWriteExclusive(filePath, JSON.stringify(nextLock))) {
    return nextLock;
  }

  return withMutationGuard(filePath, async () => {
    const currentRecord = await readLockFileRecord(filePath);
    if (currentRecord === null) {
      return (await tryWriteExclusive(filePath, JSON.stringify(nextLock))) ? nextLock : null;
    }

    if (
      currentRecord.lock !== null &&
      !isStaleLock(currentRecord.lock, {
        pidExists: (options.pidExists ?? defaultPidExists)(currentRecord.lock.pid),
        now: options.now ?? options.acquiredAt,
        staleAfterMs: options.staleAfterMs,
        startupTimeoutMs: options.startupTimeoutMs,
        coordinatorAvailable: (options.coordinatorAvailable ?? (() => false))(),
      })
    ) {
      return null;
    }

    const latestRecord = await readLockFileRecord(filePath);
    if (latestRecord === null) {
      return (await tryWriteExclusive(filePath, JSON.stringify(nextLock))) ? nextLock : null;
    }

    if (latestRecord.raw !== currentRecord.raw) {
      return null;
    }

    await rm(filePath, { force: true });
    return (await tryWriteExclusive(filePath, JSON.stringify(nextLock))) ? nextLock : null;
  }, {
    now: options.guardNow,
    pidExists: options.guardPidExists,
    staleAfterMs: options.guardStaleAfterMs,
    timeoutMs: options.guardTimeoutMs,
    beforeStaleGuardIsolation: options.onBeforeStaleGuardIsolation,
  });
}

export async function releaseStartupLock(
  filePath: string,
  owner: StartupLock,
  options: MutationGuardOptions = {},
): Promise<boolean> {
  const result = await withMutationGuard(filePath, async () => {
    const currentRecord = await readLockFileRecord(filePath);
    if (currentRecord === null || currentRecord.lock === null) {
      return false;
    }

    if (!isSameLockOwner(currentRecord.lock, owner)) {
      return false;
    }

    const latestRecord = await readLockFileRecord(filePath);
    if (latestRecord === null || latestRecord.raw !== currentRecord.raw) {
      return false;
    }

    await rm(filePath, { force: true });
    return true;
  }, options);
  return result ?? false;
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  const raw = await readTextFile(filePath);
  if (raw === null) {
    return null;
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function readLockFileRecord(filePath: string): Promise<LockFileRecord | null> {
  const raw = await readTextFile(filePath);
  if (raw === null) {
    return null;
  }

  try {
    return { raw, lock: JSON.parse(raw) as StartupLock };
  } catch {
    return { raw, lock: null };
  }
}

async function readTextFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }

    throw error;
  }
}

async function tryWriteExclusive(filePath: string, contents: string): Promise<boolean> {
  try {
    await writeFile(filePath, contents, {
      encoding: "utf8",
      flag: "wx",
    });
    return true;
  } catch (error) {
    if (isFileExistsError(error)) {
      return false;
    }

    throw error;
  }
}

async function withMutationGuard<T>(
  filePath: string,
  action: () => Promise<T>,
  options: MutationGuardOptions,
): Promise<T | null> {
  const guardPath = `${filePath}.guard`;
  const guardOwner = await acquireMutationGuard(guardPath, options);
  if (guardOwner === null) {
    return null;
  }

  try {
    return await action();
  } finally {
    await releaseMutationGuard(guardPath, guardOwner);
  }
}

async function acquireMutationGuard(
  guardPath: string,
  options: MutationGuardOptions,
): Promise<StartupLock | null> {
  const now = options.now ?? Date.now;
  const deadline = now() + (options.timeoutMs ?? defaultGuardTimeoutMs);
  const nextGuard: StartupLock = {
    pid: process.pid,
    acquiredAt: now(),
    ownerId: randomUUID(),
  };

  while (true) {
    if (await tryWriteExclusive(guardPath, JSON.stringify(nextGuard))) {
      return nextGuard;
    }

    const currentRecord = await readLockFileRecord(guardPath);
    if (currentRecord !== null && isStaleMutationGuard(currentRecord.lock, {
      now: now(),
      pidExists: options.pidExists ?? defaultPidExists,
      staleAfterMs: options.staleAfterMs ?? defaultGuardStaleAfterMs,
    })) {
      if (await isolateObservedGuard(guardPath, currentRecord.raw, options.beforeStaleGuardIsolation)) {
        continue;
      }
      continue;
    }

    if (now() >= deadline) {
      return null;
    }

    await sleep(5);
  }
}

async function releaseMutationGuard(guardPath: string, owner: StartupLock): Promise<boolean> {
  const currentRecord = await readLockFileRecord(guardPath);
  if (currentRecord === null || currentRecord.lock === null) {
    return false;
  }

  if (!isSameLockOwner(currentRecord.lock, owner)) {
    return false;
  }

  const latestRecord = await readLockFileRecord(guardPath);
  if (latestRecord === null || latestRecord.raw !== currentRecord.raw) {
    return false;
  }

  await rm(guardPath, { force: true });
  return true;
}

async function isolateObservedGuard(
  guardPath: string,
  observedRaw: string,
  beforeStaleGuardIsolation?: () => void | Promise<void>,
): Promise<boolean> {
  await beforeStaleGuardIsolation?.();

  const quarantinePath = `${guardPath}.${randomUUID()}.quarantine`;

  try {
    await link(guardPath, quarantinePath);
  } catch (error) {
    if (isMissingFileError(error)) {
      return false;
    }

    throw error;
  }

  try {
    const quarantinedRecord = await readLockFileRecord(quarantinePath);
    if (quarantinedRecord === null || quarantinedRecord.raw !== observedRaw) {
      return false;
    }

    const [guardStat, quarantineStat] = await Promise.all([
      safeLstat(guardPath),
      safeLstat(quarantinePath),
    ]);
    if (
      guardStat === null ||
      quarantineStat === null ||
      guardStat.dev !== quarantineStat.dev ||
      guardStat.ino !== quarantineStat.ino
    ) {
      return false;
    }

    await rm(guardPath, { force: false });
    return true;
  } catch (error) {
    if (isMissingFileError(error)) {
      return false;
    }

    throw error;
  } finally {
    await rm(quarantinePath, { force: true });
  }
}

function createTempPath(filePath: string): string {
  return join(dirname(filePath), `${filePath.split("/").pop() ?? "file"}.${randomUUID()}.tmp`);
}

function isStaleMutationGuard(
  guard: StartupLock | null,
  options: Required<Pick<MutationGuardOptions, "pidExists" | "staleAfterMs">> & { now: number },
): boolean {
  if (guard === null) {
    return true;
  }

  if (!options.pidExists(guard.pid)) {
    return true;
  }

  return options.now - guard.acquiredAt > options.staleAfterMs;
}

function isSameLockOwner(left: StartupLock, right: StartupLock): boolean {
  return left.pid === right.pid && left.acquiredAt === right.acquiredAt && left.ownerId === right.ownerId;
}

function defaultPidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeLstat(filePath: string) {
  try {
    return await lstat(filePath);
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }

    throw error;
  }
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isFileExistsError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

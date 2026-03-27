import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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
};

type LockFileRecord = {
  raw: string;
  lock: StartupLock | null;
};

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
  });
}

export async function releaseStartupLock(filePath: string, owner: StartupLock): Promise<boolean> {
  return withMutationGuard(filePath, async () => {
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
  });
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

async function withMutationGuard<T>(filePath: string, action: () => Promise<T>): Promise<T> {
  const guardPath = `${filePath}.guard`;

  while (!(await tryWriteExclusive(guardPath, String(process.pid)))) {
    await sleep(5);
  }

  try {
    return await action();
  } finally {
    await rm(guardPath, { force: true });
  }
}

function createTempPath(filePath: string): string {
  return join(dirname(filePath), `${filePath.split("/").pop() ?? "file"}.${randomUUID()}.tmp`);
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

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isFileExistsError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

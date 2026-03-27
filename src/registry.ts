import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

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
};

export type StartupLockState = {
  pidExists: boolean;
  now: number;
  staleAfterMs: number;
  startupTimeoutMs: number;
  coordinatorAvailable: boolean;
};

export type AcquireStartupLockOptions = StartupLock & {
  staleAfterMs: number;
  startupTimeoutMs: number;
  now?: number;
  pidExists?: (pid: number) => boolean;
  coordinatorAvailable?: () => boolean;
};

export async function readRegistration(filePath: string): Promise<Registration | null> {
  return readJsonFile<Registration>(filePath);
}

export async function writeRegistration(filePath: string, registration: Registration): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(registration), "utf8");
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
): Promise<boolean> {
  await mkdir(dirname(filePath), { recursive: true });

  const nextLock: StartupLock = {
    pid: options.pid,
    acquiredAt: options.acquiredAt,
  };

  if (await tryWriteLock(filePath, nextLock)) {
    return true;
  }

  const currentLock = await readJsonFile<StartupLock>(filePath);
  if (
    currentLock !== null &&
    !isStaleLock(currentLock, {
      pidExists: (options.pidExists ?? defaultPidExists)(currentLock.pid),
      now: options.now ?? options.acquiredAt,
      staleAfterMs: options.staleAfterMs,
      startupTimeoutMs: options.startupTimeoutMs,
      coordinatorAvailable: (options.coordinatorAvailable ?? (() => false))(),
    })
  ) {
    return false;
  }

  await rm(filePath, { force: true });
  return tryWriteLock(filePath, nextLock);
}

export async function releaseStartupLock(filePath: string): Promise<void> {
  await rm(filePath, { force: true });
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }

    throw error;
  }
}

async function tryWriteLock(filePath: string, lock: StartupLock): Promise<boolean> {
  try {
    await writeFile(filePath, JSON.stringify(lock), {
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

function defaultPidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isFileExistsError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

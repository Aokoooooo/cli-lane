import type { PsTask, TaskEvent } from "../protocol";

export function exitCodeFromTaskEvent(event: Extract<TaskEvent, { type: "exited" }>): number {
  if (event.signal) {
    return signalExitCode(event.signal);
  }

  return event.code ?? 1;
}

export function signalExitCode(signal: string): number {
  const signalNumber = SIGNAL_NUMBERS[signal];
  return signalNumber === undefined ? 128 : 128 + signalNumber;
}

export function formatPsTask(task: PsTask): string {
  const parts = [
    task.taskId,
    task.status,
    `cwd=${task.cwd}`,
    `argv=${formatArgv(task.argv)}`,
    `subscribers=${task.subscriberCount}`,
    `merged=${task.merged ? "yes" : "no"}`,
  ];

  if (task.queuePosition !== undefined) {
    parts.push(`position=${task.queuePosition}`);
  }

  return parts.join(" ");
}

export function writeLine(writer: { write(chunk: string): unknown }, line: string): void {
  writer.write(`${line}\n`);
}

const SIGNAL_NUMBERS: Record<string, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGILL: 4,
  SIGTRAP: 5,
  SIGABRT: 6,
  SIGBUS: 7,
  SIGFPE: 8,
  SIGKILL: 9,
  SIGUSR1: 10,
  SIGSEGV: 11,
  SIGUSR2: 12,
  SIGPIPE: 13,
  SIGALRM: 14,
  SIGTERM: 15,
};

function formatArgv(argv: string[]): string {
  return argv.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg)).join(" ");
}

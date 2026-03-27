export type TaskMergeMode = "by-cwd" | "global" | "off";
export type TaskStatus = "queued" | "running" | "finished" | "canceled";
export type CancelReason = "auto" | "manual";

export type TaskManagerRequest = {
  cwd: string;
  argv: string[];
  mergeMode: TaskMergeMode;
};

export type TaskSubscriber = {
  subscriberId: string;
  requestedCwd: string;
};

export type TaskSnapshot = {
  taskId: string;
  argv: string[];
  mergeMode: TaskMergeMode;
  status: TaskStatus;
  requestedCwds: string[];
  canonicalExecutionCwd: string;
  subscriberCount: number;
  cancelReason?: CancelReason;
  finishedAt?: number;
  expiresAt?: number;
};

type TaskRecord = {
  taskId: string;
  argv: string[];
  mergeMode: TaskMergeMode;
  status: TaskStatus;
  canonicalExecutionCwd: string;
  subscribers: Map<string, TaskSubscriber>;
  mergeKey?: string;
  cancelReason?: CancelReason;
  finishedAt?: number;
  expiresAt?: number;
};

export type CreateOrAttachResult = {
  taskId: string;
  subscriberId: string;
  merged: boolean;
};

export type TaskManagerOptions = {
  finishedTaskTtlMs?: number;
  now?: () => number;
};

export class TaskManager {
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly mergeIndex = new Map<string, string>();
  private readonly finishedTaskTtlMs: number;
  private readonly now: () => number;
  private nextTaskId = 1;
  private nextSubscriberId = 1;

  constructor(options: TaskManagerOptions = {}) {
    this.finishedTaskTtlMs = options.finishedTaskTtlMs ?? 5_000;
    this.now = options.now ?? (() => Date.now());
  }

  createOrAttach(request: TaskManagerRequest): CreateOrAttachResult {
    this.pruneExpiredFinishedTasks();

    const mergeKey = this.resolveMergeKey(request);

    if (mergeKey) {
      const existingTaskId = this.mergeIndex.get(mergeKey);
      const existing = existingTaskId ? this.tasks.get(existingTaskId) : undefined;

      if (existing && this.isMergeable(existing)) {
        const subscriberId = this.attachSubscriber(existing, request.cwd);
        return {
          taskId: existing.taskId,
          subscriberId,
          merged: true,
        };
      }
    }

    const taskId = `task-${this.nextTaskId++}`;
    const subscriberId = `sub-${this.nextSubscriberId++}`;
    const task: TaskRecord = {
      taskId,
      argv: [...request.argv],
      mergeMode: request.mergeMode,
      status: "queued",
      canonicalExecutionCwd: request.cwd,
      subscribers: new Map([[subscriberId, { subscriberId, requestedCwd: request.cwd }]]),
      mergeKey,
    };

    this.tasks.set(taskId, task);

    if (mergeKey) {
      this.mergeIndex.set(mergeKey, taskId);
    }

    return { taskId, subscriberId, merged: false };
  }

  detachSubscriber(taskId: string, subscriberId: string): boolean {
    this.pruneExpiredFinishedTasks();

    const task = this.tasks.get(taskId);

    if (!task || !task.subscribers.delete(subscriberId)) {
      return false;
    }

    if (task.subscribers.size === 0 && (task.status === "queued" || task.status === "running")) {
      this.cancelTaskInternal(task, "auto");
    }

    return true;
  }

  cancelTask(taskId: string): boolean {
    this.pruneExpiredFinishedTasks();

    const task = this.tasks.get(taskId);

    if (!task || (task.status !== "queued" && task.status !== "running")) {
      return false;
    }

    this.cancelTaskInternal(task, "manual");
    return true;
  }

  markTaskRunning(taskId: string): boolean {
    this.pruneExpiredFinishedTasks();

    const task = this.tasks.get(taskId);

    if (!task || task.status !== "queued") {
      return false;
    }

    task.status = "running";
    return true;
  }

  markTaskFinished(taskId: string): boolean {
    this.pruneExpiredFinishedTasks();

    const task = this.tasks.get(taskId);

    if (!task || task.status !== "running") {
      return false;
    }

    task.status = "finished";
    task.cancelReason = undefined;
    this.stampTerminalRetention(task);
    this.removeMergeIndex(task);
    return true;
  }

  listTasks(): TaskSnapshot[] {
    this.pruneExpiredFinishedTasks();

    return [...this.tasks.values()].map((task) => this.toSnapshot(task));
  }

  listActiveTasks(): TaskSnapshot[] {
    this.pruneExpiredFinishedTasks();

    return [...this.tasks.values()]
      .filter((task) => task.status === "queued" || task.status === "running")
      .map((task) => this.toSnapshot(task));
  }

  private attachSubscriber(task: TaskRecord, requestedCwd: string): string {
    const subscriberId = `sub-${this.nextSubscriberId++}`;
    task.subscribers.set(subscriberId, { subscriberId, requestedCwd });
    return subscriberId;
  }

  private cancelTaskInternal(task: TaskRecord, reason: CancelReason): void {
    task.status = "canceled";
    task.cancelReason = reason;
    this.stampTerminalRetention(task);
    this.removeMergeIndex(task);
  }

  private stampTerminalRetention(task: TaskRecord): void {
    const now = this.now();
    task.finishedAt = now;
    task.expiresAt = now + this.finishedTaskTtlMs;
  }

  private toSnapshot(task: TaskRecord): TaskSnapshot {
    return {
      taskId: task.taskId,
      argv: [...task.argv],
      mergeMode: task.mergeMode,
      status: task.status,
      requestedCwds: this.collectRequestedCwds(task),
      canonicalExecutionCwd: task.canonicalExecutionCwd,
      subscriberCount: task.subscribers.size,
      cancelReason: task.cancelReason,
      finishedAt: task.finishedAt,
      expiresAt: task.expiresAt,
    };
  }

  private collectRequestedCwds(task: TaskRecord): string[] {
    const requestedCwds: string[] = [];
    const seen = new Set<string>();

    for (const subscriber of task.subscribers.values()) {
      if (seen.has(subscriber.requestedCwd)) {
        continue;
      }

      seen.add(subscriber.requestedCwd);
      requestedCwds.push(subscriber.requestedCwd);
    }

    if (requestedCwds.length > 0) {
      return requestedCwds;
    }

    return [task.canonicalExecutionCwd];
  }

  private isMergeable(task: TaskRecord): boolean {
    return task.status === "queued" || task.status === "running";
  }

  private removeMergeIndex(task: TaskRecord): void {
    if (task.mergeKey && this.mergeIndex.get(task.mergeKey) === task.taskId) {
      this.mergeIndex.delete(task.mergeKey);
    }
  }

  private pruneExpiredFinishedTasks(): void {
    const now = this.now();

    for (const [taskId, task] of this.tasks) {
      if (task.status !== "finished" && task.status !== "canceled") {
        continue;
      }

      if (task.expiresAt !== undefined && task.expiresAt <= now) {
        this.tasks.delete(taskId);
      }
    }
  }

  private resolveMergeKey(request: TaskManagerRequest): string | undefined {
    const argvKey = JSON.stringify(request.argv);

    if (request.mergeMode === "off") {
      return undefined;
    }

    if (request.mergeMode === "global") {
      return `global:${argvKey}`;
    }

    return `cwd:${request.cwd}:${argvKey}`;
  }
}

export type SchedulerTask = {
  taskId: string;
  serialMode: "global" | "by-cwd";
  mergeMode: "by-cwd" | "global" | "off";
  serialKey: string;
};

type LaneState = {
  queue: SchedulerTask[];
  runningTaskId?: string;
};

export class Scheduler {
  private readonly lanes = new Map<string, LaneState>();
  private readonly tasks = new Map<string, { task: SchedulerTask; laneKey: string }>();

  enqueue(task: SchedulerTask): void {
    const laneKey = this.resolveLaneKey(task);
    const lane = this.getLane(laneKey);

    lane.queue.push(task);
    this.tasks.set(task.taskId, { task, laneKey });
  }

  nextRunnable(serialKey: string): SchedulerTask | undefined {
    const lane = this.lanes.get(serialKey);

    if (!lane || lane.runningTaskId || lane.queue.length === 0) {
      return undefined;
    }

    return lane.queue[0];
  }

  markRunning(taskId: string): void {
    const entry = this.tasks.get(taskId);

    if (!entry) {
      return;
    }

    const lane = this.lanes.get(entry.laneKey);

    if (!lane || lane.runningTaskId || lane.queue[0]?.taskId !== taskId) {
      return;
    }

    lane.runningTaskId = taskId;
  }

  markFinished(taskId: string): void {
    const entry = this.tasks.get(taskId);

    if (!entry) {
      return;
    }

    const lane = this.lanes.get(entry.laneKey);

    if (!lane) {
      this.tasks.delete(taskId);
      return;
    }

    if (lane.runningTaskId === taskId) {
      lane.queue.shift();
      lane.runningTaskId = undefined;
      this.tasks.delete(taskId);
      return;
    }

    if (lane.queue[0]?.taskId === taskId) {
      lane.queue.shift();
      this.tasks.delete(taskId);
      return;
    }

    const index = lane.queue.findIndex((task) => task.taskId === taskId);

    if (index >= 0) {
      lane.queue.splice(index, 1);
      this.tasks.delete(taskId);
    }
  }

  private resolveLaneKey(task: SchedulerTask): string {
    if (task.mergeMode === "global" || task.serialMode === "global") {
      return "global";
    }

    return task.serialKey;
  }

  private getLane(laneKey: string): LaneState {
    const existing = this.lanes.get(laneKey);

    if (existing) {
      return existing;
    }

    const created: LaneState = { queue: [] };
    this.lanes.set(laneKey, created);
    return created;
  }
}

import { expect, test } from "bun:test";
import { TaskManager } from "./task-manager";

type RunRequest = {
  cwd: string;
  argv: string[];
  mergeMode: "by-cwd" | "global" | "off";
};

function request(input: RunRequest): RunRequest {
  return input;
}

test("mergeMode=by-cwd merges queued task by cwd and argv", () => {
  const manager = new TaskManager();

  const first = manager.createOrAttach(request({ cwd: "/work/a", argv: ["bun", "run", "dev"], mergeMode: "by-cwd" }));
  const second = manager.createOrAttach(request({ cwd: "/work/a", argv: ["bun", "run", "dev"], mergeMode: "by-cwd" }));

  expect(second.merged).toBe(true);
  expect(second.taskId).toBe(first.taskId);
  expect(second.subscriberId).not.toBe(first.subscriberId);

  expect(manager.listTasks()).toEqual([
    {
      taskId: first.taskId,
      argv: ["bun", "run", "dev"],
      mergeMode: "by-cwd",
      status: "queued",
      requestedCwds: ["/work/a"],
      canonicalExecutionCwd: "/work/a",
      subscriberCount: 2,
    },
  ]);
});

test("mergeMode=off never merges identical requests", () => {
  const manager = new TaskManager();

  const first = manager.createOrAttach(request({ cwd: "/work/a", argv: ["bun", "run"], mergeMode: "off" }));
  const second = manager.createOrAttach(request({ cwd: "/work/a", argv: ["bun", "run"], mergeMode: "off" }));

  expect(second.merged).toBe(false);
  expect(second.taskId).not.toBe(first.taskId);
  expect(manager.listTasks().map((task) => task.taskId)).toEqual([first.taskId, second.taskId]);
});

test("mergeMode=by-cwd does not merge when cwd differs", () => {
  const manager = new TaskManager();

  const first = manager.createOrAttach(request({ cwd: "/work/a", argv: ["bun", "run"], mergeMode: "by-cwd" }));
  const second = manager.createOrAttach(request({ cwd: "/work/b", argv: ["bun", "run"], mergeMode: "by-cwd" }));

  expect(second.merged).toBe(false);
  expect(second.taskId).not.toBe(first.taskId);
  expect(manager.listTasks().map((task) => task.canonicalExecutionCwd)).toEqual(["/work/a", "/work/b"]);
});

test("mergeMode=global merges by argv and keeps the first canonical execution cwd", () => {
  const manager = new TaskManager();

  const first = manager.createOrAttach(request({ cwd: "/work/a", argv: ["bun", "run"], mergeMode: "global" }));
  const second = manager.createOrAttach(request({ cwd: "/work/b", argv: ["bun", "run"], mergeMode: "global" }));

  expect(second.merged).toBe(true);
  expect(second.taskId).toBe(first.taskId);
  expect(manager.listTasks()).toEqual([
    {
      taskId: first.taskId,
      argv: ["bun", "run"],
      mergeMode: "global",
      status: "queued",
      requestedCwds: ["/work/a", "/work/b"],
      canonicalExecutionCwd: "/work/a",
      subscriberCount: 2,
    },
  ]);
});

test("mergeMode=by-cwd also merges onto a running task", () => {
  const manager = new TaskManager();

  const first = manager.createOrAttach(request({ cwd: "/work/a", argv: ["bun", "run"], mergeMode: "by-cwd" }));
  expect(manager.markTaskRunning(first.taskId)).toBe(true);

  const second = manager.createOrAttach(request({ cwd: "/work/a", argv: ["bun", "run"], mergeMode: "by-cwd" }));

  expect(second.merged).toBe(true);
  expect(second.taskId).toBe(first.taskId);
  expect(manager.listActiveTasks()).toEqual([
    {
      taskId: first.taskId,
      argv: ["bun", "run"],
      mergeMode: "by-cwd",
      status: "running",
      requestedCwds: ["/work/a"],
      canonicalExecutionCwd: "/work/a",
      subscriberCount: 2,
    },
  ]);
});

test("detaching the last subscriber auto-cancels a queued task", () => {
  const manager = new TaskManager({
    finishedTaskTtlMs: 500,
    now: () => 1_000,
  });

  const created = manager.createOrAttach(request({ cwd: "/work/a", argv: ["bun", "run"], mergeMode: "by-cwd" }));

  expect(manager.detachSubscriber(created.taskId, created.subscriberId)).toBe(true);
  expect(manager.listTasks()).toEqual([
    {
      taskId: created.taskId,
      argv: ["bun", "run"],
      mergeMode: "by-cwd",
      status: "canceled",
      requestedCwds: ["/work/a"],
      canonicalExecutionCwd: "/work/a",
      subscriberCount: 0,
      cancelReason: "auto",
      finishedAt: 1_000,
      expiresAt: 1_500,
    },
  ]);
});

test("detaching the last subscriber auto-cancels a running task", () => {
  const manager = new TaskManager({
    finishedTaskTtlMs: 500,
    now: () => 1_000,
  });

  const created = manager.createOrAttach(request({ cwd: "/work/a", argv: ["bun", "run"], mergeMode: "by-cwd" }));
  expect(manager.markTaskRunning(created.taskId)).toBe(true);
  expect(manager.detachSubscriber(created.taskId, created.subscriberId)).toBe(true);

  expect(manager.listTasks()).toEqual([
    {
      taskId: created.taskId,
      argv: ["bun", "run"],
      mergeMode: "by-cwd",
      status: "canceled",
      requestedCwds: ["/work/a"],
      canonicalExecutionCwd: "/work/a",
      subscriberCount: 0,
      cancelReason: "auto",
      finishedAt: 1_000,
      expiresAt: 1_500,
    },
  ]);
  expect(manager.listActiveTasks()).toEqual([]);
});

test("cancelTask marks the task as manually canceled", () => {
  const manager = new TaskManager({
    finishedTaskTtlMs: 500,
    now: () => 1_000,
  });

  const created = manager.createOrAttach(request({ cwd: "/work/a", argv: ["bun", "run"], mergeMode: "by-cwd" }));

  expect(manager.cancelTask(created.taskId)).toBe(true);
  expect(manager.listTasks()).toEqual([
    {
      taskId: created.taskId,
      argv: ["bun", "run"],
      mergeMode: "by-cwd",
      status: "canceled",
      requestedCwds: ["/work/a"],
      canonicalExecutionCwd: "/work/a",
      subscriberCount: 1,
      cancelReason: "manual",
      finishedAt: 1_000,
      expiresAt: 1_500,
    },
  ]);
});

test("invalid lifecycle transitions are rejected", () => {
  const manager = new TaskManager();

  const created = manager.createOrAttach(request({ cwd: "/work/a", argv: ["bun", "run"], mergeMode: "by-cwd" }));

  expect(manager.markTaskRunning(created.taskId)).toBe(true);
  expect(manager.markTaskRunning(created.taskId)).toBe(false);
  expect(manager.markTaskFinished(created.taskId)).toBe(true);
  expect(manager.markTaskFinished(created.taskId)).toBe(false);
  expect(manager.cancelTask(created.taskId)).toBe(false);
});

test("markTaskFinished rejects queued tasks", () => {
  const manager = new TaskManager();

  const created = manager.createOrAttach(request({ cwd: "/work/a", argv: ["bun", "run"], mergeMode: "by-cwd" }));

  expect(manager.markTaskFinished(created.taskId)).toBe(false);
  expect(manager.listTasks()).toEqual([
    {
      taskId: created.taskId,
      argv: ["bun", "run"],
      mergeMode: "by-cwd",
      status: "queued",
      requestedCwds: ["/work/a"],
      canonicalExecutionCwd: "/work/a",
      subscriberCount: 1,
    },
  ]);
});

test("new request after a task finishes creates a fresh task", () => {
  const manager = new TaskManager();

  const first = manager.createOrAttach(request({ cwd: "/work/a", argv: ["bun", "run"], mergeMode: "by-cwd" }));
  expect(manager.markTaskRunning(first.taskId)).toBe(true);
  expect(manager.markTaskFinished(first.taskId)).toBe(true);

  const second = manager.createOrAttach(request({ cwd: "/work/a", argv: ["bun", "run"], mergeMode: "by-cwd" }));

  expect(second.merged).toBe(false);
  expect(second.taskId).not.toBe(first.taskId);
});

test("new request after a task is canceled creates a fresh task", () => {
  const manager = new TaskManager();

  const first = manager.createOrAttach(request({ cwd: "/work/a", argv: ["bun", "run"], mergeMode: "by-cwd" }));
  expect(manager.cancelTask(first.taskId)).toBe(true);

  const second = manager.createOrAttach(request({ cwd: "/work/a", argv: ["bun", "run"], mergeMode: "by-cwd" }));

  expect(second.merged).toBe(false);
  expect(second.taskId).not.toBe(first.taskId);
});

test("listActiveTasks returns only queued and running tasks", () => {
  const manager = new TaskManager();

  const queued = manager.createOrAttach(request({ cwd: "/work/queued", argv: ["bun", "queued"], mergeMode: "off" }));
  const running = manager.createOrAttach(request({ cwd: "/work/running", argv: ["bun", "running"], mergeMode: "off" }));
  const finished = manager.createOrAttach(request({ cwd: "/work/finished", argv: ["bun", "finished"], mergeMode: "off" }));
  const canceled = manager.createOrAttach(request({ cwd: "/work/canceled", argv: ["bun", "canceled"], mergeMode: "off" }));

  expect(manager.markTaskRunning(running.taskId)).toBe(true);
  expect(manager.markTaskRunning(finished.taskId)).toBe(true);
  expect(manager.markTaskFinished(finished.taskId)).toBe(true);
  expect(manager.cancelTask(canceled.taskId)).toBe(true);

  expect(manager.listActiveTasks()).toEqual([
    {
      taskId: queued.taskId,
      argv: ["bun", "queued"],
      mergeMode: "off",
      status: "queued",
      requestedCwds: ["/work/queued"],
      canonicalExecutionCwd: "/work/queued",
      subscriberCount: 1,
    },
    {
      taskId: running.taskId,
      argv: ["bun", "running"],
      mergeMode: "off",
      status: "running",
      requestedCwds: ["/work/running"],
      canonicalExecutionCwd: "/work/running",
      subscriberCount: 1,
    },
  ]);
});

test("recently finished tasks remain visible until the TTL expires", () => {
  let now = 1_000;
  const manager = new TaskManager({
    finishedTaskTtlMs: 500,
    now: () => now,
  });

  const created = manager.createOrAttach(request({ cwd: "/work/a", argv: ["bun", "run"], mergeMode: "by-cwd" }));

  expect(manager.markTaskRunning(created.taskId)).toBe(true);
  expect(manager.markTaskFinished(created.taskId)).toBe(true);
  expect(manager.listTasks()).toEqual([
    {
      taskId: created.taskId,
      argv: ["bun", "run"],
      mergeMode: "by-cwd",
      status: "finished",
      requestedCwds: ["/work/a"],
      canonicalExecutionCwd: "/work/a",
      subscriberCount: 1,
      finishedAt: 1_000,
      expiresAt: 1_500,
    },
  ]);

  now = 1_499;
  expect(manager.listTasks()).toHaveLength(1);

  now = 1_500;
  expect(manager.listTasks()).toEqual([]);
});

test("recently canceled tasks also expire after the TTL", () => {
  let now = 2_000;
  const manager = new TaskManager({
    finishedTaskTtlMs: 500,
    now: () => now,
  });

  const manual = manager.createOrAttach(request({ cwd: "/work/manual", argv: ["bun", "manual"], mergeMode: "by-cwd" }));
  const auto = manager.createOrAttach(request({ cwd: "/work/auto", argv: ["bun", "auto"], mergeMode: "by-cwd" }));

  expect(manager.cancelTask(manual.taskId)).toBe(true);
  expect(manager.markTaskRunning(auto.taskId)).toBe(true);
  expect(manager.detachSubscriber(auto.taskId, auto.subscriberId)).toBe(true);
  expect(manager.listTasks()).toEqual([
    {
      taskId: manual.taskId,
      argv: ["bun", "manual"],
      mergeMode: "by-cwd",
      status: "canceled",
      requestedCwds: ["/work/manual"],
      canonicalExecutionCwd: "/work/manual",
      subscriberCount: 1,
      cancelReason: "manual",
      finishedAt: 2_000,
      expiresAt: 2_500,
    },
    {
      taskId: auto.taskId,
      argv: ["bun", "auto"],
      mergeMode: "by-cwd",
      status: "canceled",
      requestedCwds: ["/work/auto"],
      canonicalExecutionCwd: "/work/auto",
      subscriberCount: 0,
      cancelReason: "auto",
      finishedAt: 2_000,
      expiresAt: 2_500,
    },
  ]);
  expect(manager.listActiveTasks()).toEqual([]);

  now = 2_499;
  expect(manager.listTasks()).toHaveLength(2);

  now = 2_500;
  expect(manager.listTasks()).toEqual([]);
});

test("retained terminal snapshots stay stable when subscribers detach after finish or cancel", () => {
  const manager = new TaskManager({
    finishedTaskTtlMs: 500,
    now: () => 3_000,
  });

  const finishedFirst = manager.createOrAttach(request({ cwd: "/work/finished-a", argv: ["bun", "done"], mergeMode: "global" }));
  const finishedSecond = manager.createOrAttach(request({ cwd: "/work/finished-b", argv: ["bun", "done"], mergeMode: "global" }));
  expect(manager.markTaskRunning(finishedFirst.taskId)).toBe(true);
  expect(manager.markTaskFinished(finishedFirst.taskId)).toBe(true);

  const canceledFirst = manager.createOrAttach(request({ cwd: "/work/canceled-a", argv: ["bun", "stop"], mergeMode: "global" }));
  const canceledSecond = manager.createOrAttach(request({ cwd: "/work/canceled-b", argv: ["bun", "stop"], mergeMode: "global" }));
  expect(manager.cancelTask(canceledFirst.taskId)).toBe(true);

  const beforeDetach = manager.listTasks();

  expect(manager.detachSubscriber(finishedFirst.taskId, finishedSecond.subscriberId)).toBe(true);
  expect(manager.detachSubscriber(canceledFirst.taskId, canceledSecond.subscriberId)).toBe(true);
  expect(manager.listTasks()).toEqual(beforeDetach);
});

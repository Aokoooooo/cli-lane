import { expect, test } from "bun:test";
import { TaskManager } from "../src/task-manager";

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

test("detaching the last subscriber auto-cancels a queued task", () => {
  const manager = new TaskManager();

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
    },
  ]);
});

test("cancelTask marks the task as manually canceled", () => {
  const manager = new TaskManager();

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

import { expect, test } from "bun:test";
import { Scheduler } from "../src/scheduler";

type TaskInput = {
  taskId: string;
  serialMode: "global" | "by-cwd";
  mergeMode: "by-cwd" | "global" | "off";
  serialKey: string;
};

function task(input: TaskInput): TaskInput {
  return input;
}

test("serialMode=global keeps all tasks in one FIFO lane", () => {
  const scheduler = new Scheduler();

  scheduler.enqueue(task({ taskId: "task-1", serialMode: "global", mergeMode: "off", serialKey: "/work/a" }));
  scheduler.enqueue(task({ taskId: "task-2", serialMode: "global", mergeMode: "off", serialKey: "/work/b" }));

  expect(scheduler.nextRunnable("global")?.taskId).toBe("task-1");
  expect(scheduler.nextRunnable("/work/a")).toBeUndefined();
  expect(scheduler.nextRunnable("/work/b")).toBeUndefined();

  scheduler.markRunning("task-1");

  expect(scheduler.nextRunnable("global")).toBeUndefined();

  scheduler.markFinished("task-1");

  expect(scheduler.nextRunnable("global")?.taskId).toBe("task-2");
});

test("serialMode=by-cwd allows different cwd lanes to be runnable at the same time", () => {
  const scheduler = new Scheduler();

  scheduler.enqueue(task({ taskId: "task-a1", serialMode: "by-cwd", mergeMode: "off", serialKey: "/a" }));
  scheduler.enqueue(task({ taskId: "task-b1", serialMode: "by-cwd", mergeMode: "off", serialKey: "/b" }));

  expect(scheduler.nextRunnable("/a")?.taskId).toBe("task-a1");
  expect(scheduler.nextRunnable("/b")?.taskId).toBe("task-b1");
});

test("mergeMode=global forces tasks into the global lane", () => {
  const scheduler = new Scheduler();

  scheduler.enqueue(task({ taskId: "task-1", serialMode: "by-cwd", mergeMode: "global", serialKey: "/work/a" }));
  scheduler.enqueue(task({ taskId: "task-2", serialMode: "by-cwd", mergeMode: "global", serialKey: "/work/b" }));

  expect(scheduler.nextRunnable("global")?.taskId).toBe("task-1");
  expect(scheduler.nextRunnable("/work/a")).toBeUndefined();
  expect(scheduler.nextRunnable("/work/b")).toBeUndefined();

  scheduler.markRunning("task-1");
  expect(scheduler.nextRunnable("global")).toBeUndefined();

  scheduler.markFinished("task-1");
  expect(scheduler.nextRunnable("global")?.taskId).toBe("task-2");
});

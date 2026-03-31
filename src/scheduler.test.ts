import { expect, test } from 'bun:test'
import { Scheduler } from './scheduler'

type TaskInput = {
  taskId: string
  serialMode: 'global' | 'by-cwd'
  mergeMode: 'by-cwd' | 'global' | 'off'
  serialKey: string
}

function task(input: TaskInput): TaskInput {
  return input
}

test('serialMode=global keeps all tasks in one FIFO lane', () => {
  const scheduler = new Scheduler()

  scheduler.enqueue(
    task({
      taskId: 'task-1',
      serialMode: 'global',
      mergeMode: 'off',
      serialKey: '/work/a',
    }),
  )
  scheduler.enqueue(
    task({
      taskId: 'task-2',
      serialMode: 'global',
      mergeMode: 'off',
      serialKey: '/work/b',
    }),
  )

  expect(
    scheduler.nextRunnableFor(
      task({
        taskId: 'probe',
        serialMode: 'global',
        mergeMode: 'off',
        serialKey: '/work/c',
      }),
    )?.taskId,
  ).toBe('task-1')
  expect(
    scheduler.nextRunnableFor(
      task({
        taskId: 'probe',
        serialMode: 'global',
        mergeMode: 'off',
        serialKey: '/work/a',
      }),
    )?.taskId,
  ).toBe('task-1')
  expect(
    scheduler.nextRunnableFor(
      task({
        taskId: 'probe',
        serialMode: 'global',
        mergeMode: 'off',
        serialKey: '/work/b',
      }),
    )?.taskId,
  ).toBe('task-1')

  expect(scheduler.markRunning('task-1')).toBe(true)
  expect(scheduler.markRunning('task-1')).toBe(false)

  expect(
    scheduler.nextRunnableFor(
      task({
        taskId: 'probe',
        serialMode: 'global',
        mergeMode: 'off',
        serialKey: '/work/c',
      }),
    ),
  ).toBeUndefined()

  expect(scheduler.markFinished('task-1')).toBe(true)
  expect(scheduler.markFinished('task-1')).toBe(false)

  expect(
    scheduler.nextRunnableFor(
      task({
        taskId: 'probe',
        serialMode: 'global',
        mergeMode: 'off',
        serialKey: '/work/c',
      }),
    )?.taskId,
  ).toBe('task-2')
})

test('serialMode=by-cwd allows different cwd lanes to be runnable at the same time', () => {
  const scheduler = new Scheduler()

  scheduler.enqueue(
    task({
      taskId: 'task-a1',
      serialMode: 'by-cwd',
      mergeMode: 'off',
      serialKey: '/a',
    }),
  )
  scheduler.enqueue(
    task({
      taskId: 'task-a2',
      serialMode: 'by-cwd',
      mergeMode: 'off',
      serialKey: '/a',
    }),
  )
  scheduler.enqueue(
    task({
      taskId: 'task-b1',
      serialMode: 'by-cwd',
      mergeMode: 'off',
      serialKey: '/b',
    }),
  )

  expect(
    scheduler.nextRunnableFor(
      task({
        taskId: 'probe-a',
        serialMode: 'by-cwd',
        mergeMode: 'off',
        serialKey: '/a',
      }),
    )?.taskId,
  ).toBe('task-a1')
  expect(
    scheduler.nextRunnableFor(
      task({
        taskId: 'probe-b',
        serialMode: 'by-cwd',
        mergeMode: 'off',
        serialKey: '/b',
      }),
    )?.taskId,
  ).toBe('task-b1')

  expect(scheduler.markRunning('task-a1')).toBe(true)
  expect(
    scheduler.nextRunnableFor(
      task({
        taskId: 'probe-a',
        serialMode: 'by-cwd',
        mergeMode: 'off',
        serialKey: '/a',
      }),
    ),
  ).toBeUndefined()
  expect(
    scheduler.nextRunnableFor(
      task({
        taskId: 'probe-b',
        serialMode: 'by-cwd',
        mergeMode: 'off',
        serialKey: '/b',
      }),
    )?.taskId,
  ).toBe('task-b1')

  expect(scheduler.markFinished('task-a1')).toBe(true)
  expect(
    scheduler.nextRunnableFor(
      task({
        taskId: 'probe-a',
        serialMode: 'by-cwd',
        mergeMode: 'off',
        serialKey: '/a',
      }),
    )?.taskId,
  ).toBe('task-a2')

  expect(scheduler.markFinished('missing-task')).toBe(false)
})

test('mergeMode=global forces tasks into the global lane', () => {
  const scheduler = new Scheduler()

  scheduler.enqueue(
    task({
      taskId: 'task-1',
      serialMode: 'by-cwd',
      mergeMode: 'global',
      serialKey: '/work/a',
    }),
  )
  scheduler.enqueue(
    task({
      taskId: 'task-2',
      serialMode: 'by-cwd',
      mergeMode: 'global',
      serialKey: '/work/b',
    }),
  )

  expect(
    scheduler.nextRunnableFor(
      task({
        taskId: 'probe-a',
        serialMode: 'by-cwd',
        mergeMode: 'global',
        serialKey: '/work/a',
      }),
    )?.taskId,
  ).toBe('task-1')
  expect(
    scheduler.nextRunnableFor(
      task({
        taskId: 'probe-b',
        serialMode: 'by-cwd',
        mergeMode: 'global',
        serialKey: '/work/b',
      }),
    )?.taskId,
  ).toBe('task-1')

  expect(scheduler.markRunning('task-1')).toBe(true)
  expect(
    scheduler.nextRunnableFor(
      task({
        taskId: 'probe-c',
        serialMode: 'global',
        mergeMode: 'off',
        serialKey: '/work/c',
      }),
    ),
  ).toBeUndefined()
  expect(
    scheduler.nextRunnableFor(
      task({
        taskId: 'probe-a',
        serialMode: 'by-cwd',
        mergeMode: 'global',
        serialKey: '/work/a',
      }),
    ),
  ).toBeUndefined()
  expect(
    scheduler.nextRunnableFor(
      task({
        taskId: 'probe-b',
        serialMode: 'by-cwd',
        mergeMode: 'global',
        serialKey: '/work/b',
      }),
    ),
  ).toBeUndefined()

  expect(scheduler.markFinished('task-1')).toBe(true)
  expect(
    scheduler.nextRunnableFor(
      task({
        taskId: 'probe-d',
        serialMode: 'by-cwd',
        mergeMode: 'global',
        serialKey: '/work/d',
      }),
    )?.taskId,
  ).toBe('task-2')
})

test('enqueue rejects duplicate task ids', () => {
  const scheduler = new Scheduler()

  expect(
    scheduler.enqueue(
      task({
        taskId: 'task-1',
        serialMode: 'by-cwd',
        mergeMode: 'off',
        serialKey: '/a',
      }),
    ),
  ).toBe(true)
  expect(
    scheduler.enqueue(
      task({
        taskId: 'task-1',
        serialMode: 'by-cwd',
        mergeMode: 'off',
        serialKey: '/b',
      }),
    ),
  ).toBe(false)

  expect(
    scheduler.nextRunnableFor(
      task({
        taskId: 'probe',
        serialMode: 'by-cwd',
        mergeMode: 'off',
        serialKey: '/a',
      }),
    )?.taskId,
  ).toBe('task-1')
  expect(
    scheduler.nextRunnableFor(
      task({
        taskId: 'probe',
        serialMode: 'by-cwd',
        mergeMode: 'off',
        serialKey: '/b',
      }),
    ),
  ).toBeUndefined()
})

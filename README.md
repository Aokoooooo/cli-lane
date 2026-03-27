# cli-lane

`cli-lane` is a Bun-based CLI for local task coordination. It runs commands through a coordinator, supports queued execution, shared output for merged requests, and explicit detach semantics.

## Build

Install dependencies first:

```bash
bun install
```

Then build the single binary:

```bash
bun run build
```

That produces a single binary at `./cli-lane`.

## Usage

Run a command:

```bash
cli-lane run -- bun --version
```

Specify a working directory:

```bash
cli-lane run --cwd /path/to/repo -- bun test
```

List active tasks:

```bash
cli-lane ps
```

Request cancellation for a task:

```bash
cli-lane cancel <task-id>
```

## Modes

`cli-lane` separates serial mode from merge mode.

Serial mode controls the lane that a task waits in:

- `global`: only one task runs at a time across the whole coordinator
- `by-cwd`: tasks serialize per working directory

Merge mode controls whether identical requests share one underlying execution:

- `by-cwd` is the default
- `global` merges by command arguments across directories
- `off` disables merging

Example:

```bash
cli-lane run --serial-mode by-cwd --merge-mode by-cwd -- bun test
```

By default, `cli-lane` stores runtime state under the system temp directory in a cwd-specific subdirectory. Set `CLI_LANE_RUNTIME_DIR` to override that location explicitly.

## Cancellation

`Ctrl+C` detaches the current subscriber. It does not always cancel the underlying task.

If other subscribers are still attached, the task keeps running and you will see a notice that it is still active for the remaining subscribers.

## Development

```bash
bun test
bun run build
./cli-lane run -- bun --version
```

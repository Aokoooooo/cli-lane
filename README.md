# cli-lane

`cli-lane` is a CLI for local task coordination. It runs commands through a coordinator, supports queued execution, shared output for merged requests, and explicit detach semantics.

## Installation

No prerequisites required - the binary is automatically downloaded during installation.

### Via npm

```bash
npm install -g cli-lane
```

### Via Bun

```bash
bun install -g cli-lane
```

### Via npx (no installation)

```bash
npx cli-lane run -- bun --version
```

## Supported Platforms

- macOS (Intel & Apple Silicon)
- Linux (x64 & arm64)

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

Merging only applies to queued tasks. If a matching task is already running,
`cli-lane` creates a fresh queued task instead of attaching the new request to
the in-flight execution.

Example:

```bash
cli-lane run --serial-mode by-cwd --merge-mode by-cwd -- bun test
```

By default, `cli-lane` stores runtime state under the system temp directory in a cwd-specific subdirectory. Set `CLI_LANE_RUNTIME_DIR` to override that location explicitly.

## Cancellation

`Ctrl+C` detaches the current subscriber. It does not always cancel the underlying task.

If other subscribers are still attached, the task keeps running and you will see a notice that it is still active for the remaining subscribers.

## Development

Requirements:
- [Bun](https://bun.sh/) runtime (for development only)

```bash
bun install
bun test
bun run build
```

### Building Release Binaries

Build binaries for all supported platforms:

```bash
bun run build:all
```

This creates platform-specific binaries in the `release/` directory:
- `cli-lane-darwin-x64`
- `cli-lane-darwin-arm64`
- `cli-lane-linux-x64`
- `cli-lane-linux-arm64`

These binaries should be uploaded to GitHub Releases for distribution.

## Release Process

1. Update version in `package.json`
2. Build all binaries: `bun run build:all`
3. Create a GitHub Release with the binaries attached
4. Publish to npm: `npm publish --access public`

The npm package will automatically download the correct binary during installation.

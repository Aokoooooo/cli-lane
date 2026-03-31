#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { arch, platform } from 'node:process'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const PLATFORM_MAP = {
  darwin: 'darwin',
  linux: 'linux',
}

const ARCH_MAP = {
  x64: 'x64',
  arm64: 'arm64',
  aarch64: 'arm64',
}

function getBinaryName() {
  const plat = PLATFORM_MAP[platform]
  const cpu = ARCH_MAP[arch]

  if (!plat || !cpu) {
    console.error(`Unsupported platform: ${platform}-${arch}`)
    console.error(
      'Supported platforms: darwin-x64, darwin-arm64, linux-x64, linux-arm64',
    )
    process.exit(1)
  }

  return `cli-lane-${plat}-${cpu}`
}

const binaryName = getBinaryName()
const binaryPath = join(__dirname, binaryName)

if (!existsSync(binaryPath)) {
  console.error(`Binary not found: ${binaryPath}`)
  console.error('Please try reinstalling the package: npm install -g cli-lane')
  process.exit(1)
}

const child = spawn(binaryPath, process.argv.slice(2), {
  stdio: 'inherit',
  detached: false,
})

child.on('exit', (code) => {
  process.exit(code ?? 0)
})

child.on('error', (err) => {
  console.error(`Failed to run cli-lane: ${err.message}`)
  process.exit(1)
})

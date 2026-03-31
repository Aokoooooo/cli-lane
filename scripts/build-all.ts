#!/usr/bin/env bun

/**
 * Build binaries for all supported platforms
 */

import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { $ } from 'bun'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = join(__dirname, '..')
const RELEASE_DIR = join(PROJECT_ROOT, 'release')

const PLATFORMS = [
  { platform: 'darwin', arch: 'x64', target: 'bun-darwin-x64' },
  { platform: 'darwin', arch: 'arm64', target: 'bun-darwin-arm64' },
  { platform: 'linux', arch: 'x64', target: 'bun-linux-x64' },
  { platform: 'linux', arch: 'arm64', target: 'bun-linux-arm64' },
]

async function buildForTarget(platform: string, arch: string, target: string) {
  const binaryName = `cli-lane-${platform}-${arch}`
  const outputPath = join(RELEASE_DIR, binaryName)

  console.log(`\nBuilding ${binaryName}...`)

  try {
    await $`bun build --compile ./src/index.ts --outfile ${outputPath} --target ${target}`
    console.log(`✓ Built: ${outputPath}`)
    return { success: true, path: outputPath }
  } catch (error) {
    console.error(`✗ Failed to build ${binaryName}:`, error)
    return { success: false, error }
  }
}

async function main() {
  console.log('Building cli-lane binaries for all platforms...')
  console.log(`Output directory: ${RELEASE_DIR}`)

  await mkdir(RELEASE_DIR, { recursive: true })

  const results = []

  for (const { platform, arch, target } of PLATFORMS) {
    const result = await buildForTarget(platform, arch, target)
    results.push({ platform, arch, ...result })
  }

  console.log(`\n${'='.repeat(50)}`)
  console.log('Build Summary:')
  console.log('='.repeat(50))

  let successCount = 0
  let failCount = 0

  for (const result of results) {
    const status = result.success ? '✓' : '✗'
    console.log(`${status} cli-lane-${result.platform}-${result.arch}`)
    if (result.success) {
      successCount++
    } else {
      failCount++
    }
  }

  console.log(`\n${'='.repeat(50)}`)
  console.log(`Total: ${successCount} success, ${failCount} failed`)
  console.log(`Release files in: ${RELEASE_DIR}`)

  if (failCount > 0) {
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

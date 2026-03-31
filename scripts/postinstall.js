#!/usr/bin/env node

import { createWriteStream } from 'node:fs'
import { chmod, mkdir, readFile, rename, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = join(__dirname, '..')
const BIN_DIR = join(PROJECT_ROOT, 'bin')
const PACKAGE_NAME = 'cli-lane'
const GITHUB_REPO = 'Aokoooooo/cli-lane'

const PLATFORM_MAP = {
  darwin: 'darwin',
  linux: 'linux',
  win32: null,
}

const ARCH_MAP = {
  x64: 'x64',
  arm64: 'arm64',
  aarch64: 'arm64',
}

function getPlatformInfo() {
  const platform = PLATFORM_MAP[process.platform]
  const arch = ARCH_MAP[process.arch]

  if (!platform) {
    console.error(`Unsupported platform: ${process.platform}`)
    process.exit(1)
  }

  if (!arch) {
    console.error(`Unsupported architecture: ${process.arch}`)
    process.exit(1)
  }

  return { platform, arch }
}

function getBinaryName(platform, arch) {
  return `${PACKAGE_NAME}-${platform}-${arch}`
}

function getDownloadUrl(version, binaryName) {
  return `https://github.com/${GITHUB_REPO}/releases/download/v${version}/${binaryName}`
}

async function downloadFile(url, destPath) {
  console.log(`Downloading from ${url}...`)

  const response = await fetch(url)

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(
        `Binary not found at ${url}. Please ensure the release exists.`,
      )
    }
    throw new Error(
      `Failed to download: ${response.status} ${response.statusText}`,
    )
  }

  const tempPath = `${destPath}.tmp`
  const fileStream = createWriteStream(tempPath)
  await pipeline(Readable.fromWeb(response.body), fileStream)
  await rename(tempPath, destPath)

  console.log(`Downloaded to ${destPath}`)
}

async function ensureDir(dir) {
  await mkdir(dir, { recursive: true })
}

async function fileExists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function main() {
  const srcDir = join(PROJECT_ROOT, 'src')
  if (await fileExists(srcDir)) {
    console.log('Development mode detected, skipping binary download')
    return
  }

  const packageJsonPath = join(PROJECT_ROOT, 'package.json')
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf-8'))
  const version = packageJson.version

  const { platform, arch } = getPlatformInfo()
  const binaryName = getBinaryName(platform, arch)
  const binaryPath = join(BIN_DIR, binaryName)

  if (await fileExists(binaryPath)) {
    console.log(`Binary already exists: ${binaryPath}`)
    return
  }

  await ensureDir(BIN_DIR)

  const downloadUrl = getDownloadUrl(version, binaryName)

  try {
    await downloadFile(downloadUrl, binaryPath)
    await chmod(binaryPath, 0o755)
    console.log(
      `✓ cli-lane ${version} installed successfully for ${platform}-${arch}`,
    )
  } catch (error) {
    console.error(`Failed to install cli-lane: ${error.message}`)
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

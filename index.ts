#!/usr/bin/env bun
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { $ } from "bun"

const REMOTE_HEAD_REF_REGEX = /^ref:\s+refs\/heads\/([^\s]+)\s+HEAD/m

// honor standard no_color to disable ansi output
const noColor = "NO_COLOR" in process.env
const colors = {
  cyan: noColor ? "" : "\x1b[36m",
  green: noColor ? "" : "\x1b[32m",
  red: noColor ? "" : "\x1b[31m",
  reset: noColor ? "" : "\x1b[0m",
}

function parseGitOutput(output: string) {
  let additions = 0
  let deletions = 0
  let filesWithAdditions = 0
  let filesWithDeletions = 0

  if (!output.trim())
    return { additions, deletions, filesWithAdditions, filesWithDeletions }

  for (const line of output.trim().split("\n")) {
    // git diff --numstat uses tabs as delimiters
    const tabIndex = line.indexOf("\t")
    if (tabIndex === -1) continue

    const secondTabIndex = line.indexOf("\t", tabIndex + 1)
    if (secondTabIndex === -1) continue

    const added = Number.parseInt(line.substring(0, tabIndex), 10) || 0
    const deleted =
      Number.parseInt(line.substring(tabIndex + 1, secondTabIndex), 10) || 0

    additions += added
    deletions += deleted

    if (added > 0) filesWithAdditions++
    if (deleted > 0) filesWithDeletions++
  }

  return { additions, deletions, filesWithAdditions, filesWithDeletions }
}

function createBars(additions: number, deletions: number) {
  const total = additions + deletions
  const barWidth = 20

  if (total === 0) return { addBar: "", delBar: "" }

  const addBarLength = ((additions * barWidth) / total) | 0
  const delBarLength = ((deletions * barWidth) / total) | 0

  return {
    addBar: "+".repeat(addBarLength),
    delBar: "-".repeat(delBarLength),
  }
}

function displayStats(
  additions: number,
  deletions: number,
  filesWithAdditions: number,
  filesWithDeletions: number,
) {
  const { green: g, red: r, cyan: c, reset: _ } = colors
  const { addBar, delBar } = createBars(additions, deletions)

  console.log(
    `${g}+${additions}${_} ${r}-${deletions}${_} ${c}Σ${additions + deletions}${_} | ` +
      `${g}+${filesWithAdditions}${_} ${r}-${filesWithDeletions}${_} files\n` +
      `${g}${addBar}${_}${r}${delBar}${_}`,
  )
}

export const hasGit = async (): Promise<boolean> => {
  try {
    return (await $`git rev-parse --is-inside-work-tree`.quiet()).exitCode === 0
  } catch {
    return false
  }
}

// detect the default remote branch dynamically
async function getDefaultBranch(): Promise<string> {
  try {
    // 1) check local cached symbolic ref for origin/HEAD
    const localHead = await $`git symbolic-ref --short refs/remotes/origin/HEAD`
      .nothrow()
      .quiet()
    if (localHead.exitCode === 0) {
      const headRef = localHead.text().trim() // e.g. origin/main
      if (headRef) return headRef
    }

    // 2) common defaults present locally (remote-tracking refs)
    for (const name of ["main", "master", "trunk", "default", "develop"]) {
      const res =
        await $`git show-ref --verify --quiet refs/remotes/origin/${name}`
          .nothrow()
          .quiet()
      if (res.exitCode === 0) return `origin/${name}`
    }

    // 3) try current branch's upstream if configured
    const upstream =
      await $`git rev-parse --abbrev-ref --symbolic-full-name @{upstream}`
        .nothrow()
        .quiet()
    if (upstream.exitCode === 0) {
      const upstreamRef = upstream.text().trim()
      if (upstreamRef) return upstreamRef
    }

    // 4) one remote query as a last resort
    const lsRemote = await $`git ls-remote --symref origin HEAD`
      .nothrow()
      .quiet()
    if (lsRemote.exitCode === 0) {
      const text = lsRemote.text()
      const match = REMOTE_HEAD_REF_REGEX.exec(text)
      if (match?.[1]) return `origin/${match[1]}`
    }

    // 5) give up gracefully
    return "origin/main"
  } catch {
    return "origin/main"
  }
}

async function getUpstreamBranch(): Promise<string> {
  const upstream =
    await $`git rev-parse --abbrev-ref --symbolic-full-name @{upstream}`
      .nothrow()
      .quiet()

  if (upstream.exitCode === 0) {
    const upstreamRef = upstream.text().trim()
    if (upstreamRef) return upstreamRef
  }

  return getDefaultBranch()
}

async function getUntrackedPaths(): Promise<string[]> {
  const output = await $`git ls-files --others --exclude-standard -z`
    .quiet()
    .text()

  return output.split("\0").filter(Boolean)
}

async function getDiffOutput(
  compareRef: string,
  includeUntracked: boolean,
): Promise<string> {
  if (!includeUntracked) {
    return await $`git diff --numstat ${compareRef}`.quiet().text()
  }

  const untrackedPaths = await getUntrackedPaths()
  if (untrackedPaths.length === 0) {
    return await $`git diff --numstat ${compareRef}`.quiet().text()
  }

  const tmpDir = await mkdtemp(join(tmpdir(), "gdtt-index-"))
  const tmpIndex = join(tmpDir, "index")
  const pathspecFile = join(tmpDir, "pathspecs")

  try {
    const realIndex = await $`git rev-parse --git-path index`.quiet().text()
    await copyFile(realIndex.trim(), tmpIndex)
    await writeFile(pathspecFile, `${untrackedPaths.join("\0")}\0`)

    await $`env GIT_INDEX_FILE=${tmpIndex} git add -N --pathspec-from-file=${pathspecFile} --pathspec-file-nul`.quiet()

    return await $`env GIT_INDEX_FILE=${tmpIndex} git diff --numstat ${compareRef}`
      .quiet()
      .text()
  } finally {
    await rm(tmpDir, { force: true, recursive: true })
  }
}

function showHelp() {
  console.log(`usage: gdtt [options]

options:
  -u, --upstream                 compare against upstream (unpushed changes)
  -b, --base <branch>            compare against specific branch
  --committed-only               exclude uncommitted and untracked changes
  --no-untracked                 exclude untracked files
  --exclude-untracked            alias for --no-untracked
  -h, --help                     show this help

default: compares against origin/main (or origin/master), including untracked files`)
  process.exit(0)
}

function parseArgs() {
  const args = process.argv.slice(2)
  let base: string | null = null
  let upstream = false
  let committedOnly = false
  let excludeUntracked = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]

    switch (arg) {
      case "-h":
      case "--help":
        showHelp()
        break
      case "-u":
      case "--upstream":
        upstream = true
        break
      case "--committed-only":
        committedOnly = true
        break
      case "--no-untracked":
      case "--exclude-untracked":
        excludeUntracked = true
        break
      case "-b":
      case "--base":
        if (i + 1 >= args.length) {
          console.error("Error: -b/--base requires a branch name")
          process.exit(1)
        }
        base = args[++i]
        break
      default:
        console.error(`Error: unknown option '${arg}'`)
        process.exit(1)
    }
  }

  return { base, committedOnly, excludeUntracked, upstream }
}

async function gdtt() {
  if (!(await hasGit())) {
    console.error(`Error: not a git repository (${process.cwd()})`)
    process.exit(1)
  }

  const { base, upstream, committedOnly, excludeUntracked } = parseArgs()

  try {
    let compareRef: string

    if (upstream) {
      compareRef = await getUpstreamBranch()
    } else if (base) {
      compareRef = base
    } else {
      compareRef = await getDefaultBranch()
    }

    // use HEAD for committed-only, otherwise include working directory
    const output = committedOnly
      ? await $`git diff --numstat ${compareRef} HEAD`.quiet().text()
      : await getDiffOutput(compareRef, !excludeUntracked)

    // fast check for no changes - avoid expensive parsing
    if (!output.trim()) {
      console.log(`${colors.cyan}no changes!${colors.reset}`)
      return
    }

    // only parse and display if there are changes
    const stats = parseGitOutput(output)
    displayStats(
      stats.additions,
      stats.deletions,
      stats.filesWithAdditions,
      stats.filesWithDeletions,
    )
  } catch (error) {
    if (error instanceof Error) {
      console.error(`Error: ${error.message}`)
    } else {
      console.error("Error running git diff")
    }
    process.exit(1)
  }
}

await gdtt()

#!/usr/bin/env bun
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

function showHelp() {
  console.log(`usage: gdtt [options]

options:
  -u, --upstream       compare against upstream (unpushed changes)
  -b, --base <branch>  compare against specific branch
  --committed-only     exclude uncommitted changes
  -h, --help           show this help

default: compares against origin/main (or origin/master)`)
  process.exit(0)
}

function parseArgs() {
  const args = process.argv.slice(2)
  let base: string | null = null
  let upstream = false
  let committedOnly = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]

    if (arg === "-h" || arg === "--help") {
      showHelp()
    }

    if (arg === "-u" || arg === "--upstream") {
      upstream = true
      continue
    }

    if (arg === "--committed-only") {
      committedOnly = true
      continue
    }

    if (arg === "-b" || arg === "--base") {
      if (i + 1 >= args.length) {
        console.error("Error: -b/--base requires a branch name")
        process.exit(1)
      }
      base = args[++i]
      continue
    }

    console.error(`Error: unknown option '${arg}'`)
    process.exit(1)
  }

  return { base, committedOnly, upstream }
}

async function gdtt() {
  if (!(await hasGit())) {
    console.error(`Error: not a git repository (${process.cwd()})`)
    process.exit(1)
  }

  const { base, upstream, committedOnly } = parseArgs()

  try {
    let compareRef: string

    if (upstream) {
      compareRef = "@{upstream}"
    } else if (base) {
      compareRef = base
    } else {
      compareRef = await getDefaultBranch()
    }

    // use HEAD for committed-only, otherwise include working directory
    const output = committedOnly
      ? await $`git diff --numstat ${compareRef} HEAD`.quiet().text()
      : await $`git diff --numstat ${compareRef}`.quiet().text()

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

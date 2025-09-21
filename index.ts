#!/usr/bin/env bun

import { $ } from "bun"

const colors = {
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  reset: "\x1b[0m",
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
  const total = additions + deletions
  const { addBar, delBar } = createBars(additions, deletions)

  console.log(
    `${colors.green}+${additions}${colors.reset} ${colors.red}-${deletions}${colors.reset} ${colors.cyan}Σ${total}${colors.reset} | ${colors.green}+${filesWithAdditions}${colors.reset} ${colors.red}-${filesWithDeletions}${colors.reset} files\n` +
      `${colors.green}${addBar}${colors.reset}${colors.red}${delBar}${colors.reset}`,
  )
}

export const hasGit = async (): Promise<boolean> => {
  try {
    return (await $`git rev-parse --is-inside-work-tree`.quiet()).exitCode === 0
  } catch {
    return false
  }
}

async function gdtt() {
  if (!(await hasGit())) {
    console.error(`Error: not a git repository (${process.cwd()})`)
    process.exit(1)
  }

  try {
    const output = await $`git diff --numstat @{upstream}`.quiet().text()

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

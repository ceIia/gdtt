import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { $, spawn } from "bun"
import { hasGit } from "./index.ts"

let testDir: string
let originalCwd: string

// regex for parsing gdtt output
const outputRegex = /\+(\d+)\s+-(\d+)\s+Σ(\d+)\s+\|\s+\+(\d+)\s+-(\d+)\s+files/

// helper to create a git repo with initial commit
async function initGitRepo(dir: string) {
  await $`git -C ${dir} -c init.defaultBranch=main init`.quiet()
  await $`git -C ${dir} config user.name "Test User"`.quiet()
  await $`git -C ${dir} config user.email "test@example.com"`.quiet()
  await $`echo "# test" > ${dir}/README.md`.quiet()
  await $`git -C ${dir} add .`.quiet()
  await $`git -C ${dir} commit -m "initial commit"`.quiet()
}

// helper to create a bare remote and connect it
async function setupRemote(dir: string) {
  const remoteDir = join(tmpdir(), `gdtt-remote-${Date.now()}`)
  await $`git init --bare ${remoteDir}`.quiet()
  await $`git -C ${dir} remote add origin ${remoteDir}`.quiet()
  await $`git -C ${dir} push -u origin HEAD`.quiet()
  return remoteDir
}

// helper to run gdtt in a specific directory
async function runGdtt(
  dir: string,
  args: string[] = [],
  env: Record<string, string> = {},
) {
  const proc = spawn(["bun", join(originalCwd, "dist/index.js"), ...args], {
    cwd: dir,
    env: { ...process.env, NO_COLOR: "1", ...env },
    stderr: "pipe",
    stdout: "pipe",
  })

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const exitCode = await proc.exited
  return { exitCode, stderr, stdout }
}

// colors are disabled in tests via NO_COLOR=1

// helper to parse gdtt output
function parseOutput(stdout: string) {
  const match = stdout.match(outputRegex)
  if (!match) return null
  return {
    additions: Number.parseInt(match[1], 10),
    deletions: Number.parseInt(match[2], 10),
    filesAdded: Number.parseInt(match[4], 10),
    filesDeleted: Number.parseInt(match[5], 10),
    total: Number.parseInt(match[3], 10),
  }
}

beforeEach(async () => {
  originalCwd = process.cwd()
  testDir = await mkdtemp(join(tmpdir(), "gdtt-test-"))
})

afterEach(async () => {
  process.chdir(originalCwd)
  if (testDir) {
    await rm(testDir, { force: true, recursive: true }).catch(() => {
      // ignore cleanup errors
    })
  }
})

describe("hasGit", () => {
  test("detects git repository", async () => {
    await initGitRepo(testDir)
    process.chdir(testDir)
    expect(await hasGit()).toBe(true)
  })

  test("detects non-git directory", async () => {
    process.chdir(testDir)
    expect(await hasGit()).toBe(false)
  })
})

describe("gdtt default behavior", () => {
  test("shows no changes when branch is up to date with origin/main", async () => {
    await initGitRepo(testDir)
    await setupRemote(testDir)

    const result = await runGdtt(testDir)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("no changes!")
  })

  test("shows uncommitted changes", async () => {
    await initGitRepo(testDir)
    await setupRemote(testDir)

    // make uncommitted changes
    await $`echo "new line" >> ${testDir}/README.md`.quiet()

    const result = await runGdtt(testDir)
    expect(result.exitCode).toBe(0)

    const stats = parseOutput(result.stdout)
    expect(stats).not.toBeNull()
    expect(stats!.additions).toBeGreaterThan(0)
  })

  test("shows committed but unpushed changes", async () => {
    await initGitRepo(testDir)
    await setupRemote(testDir)

    // make and commit changes
    await $`echo "new line" >> ${testDir}/README.md`.quiet()
    await $`git -C ${testDir} add .`.quiet()
    await $`git -C ${testDir} commit -m "add new line"`.quiet()

    const result = await runGdtt(testDir)
    expect(result.exitCode).toBe(0)

    const stats = parseOutput(result.stdout)
    expect(stats).not.toBeNull()
    expect(stats!.additions).toBeGreaterThan(0)
  })

  test("shows both committed and uncommitted changes", async () => {
    await initGitRepo(testDir)
    await setupRemote(testDir)

    // make committed changes
    await $`echo "committed" >> ${testDir}/file1.txt`.quiet()
    await $`git -C ${testDir} add .`.quiet()
    await $`git -C ${testDir} commit -m "add file1"`.quiet()

    // make uncommitted changes
    await $`echo "uncommitted" >> ${testDir}/file2.txt`.quiet()

    const result = await runGdtt(testDir)
    expect(result.exitCode).toBe(0)

    const stats = parseOutput(result.stdout)
    expect(stats).not.toBeNull()
    expect(stats!.additions).toBeGreaterThan(0)
  })
})

describe("gdtt --committed-only flag", () => {
  test("excludes uncommitted changes", async () => {
    await initGitRepo(testDir)
    await setupRemote(testDir)

    // make uncommitted changes
    await $`echo "new line" >> ${testDir}/README.md`.quiet()

    const result = await runGdtt(testDir, ["--committed-only"])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("no changes!")
  })

  test("shows only committed changes", async () => {
    await initGitRepo(testDir)
    await setupRemote(testDir)

    // make committed changes
    await $`echo "committed" >> ${testDir}/README.md`.quiet()
    await $`git -C ${testDir} add .`.quiet()
    await $`git -C ${testDir} commit -m "add line"`.quiet()

    // make uncommitted changes
    await $`echo "uncommitted" >> ${testDir}/README.md`.quiet()

    const result = await runGdtt(testDir, ["--committed-only"])
    expect(result.exitCode).toBe(0)

    const stats = parseOutput(result.stdout)
    expect(stats).not.toBeNull()
    // should only count the committed line, not uncommitted
    expect(stats!.additions).toBe(1)
  })
})

describe("gdtt -u/--upstream flag", () => {
  test("shows unpushed changes", async () => {
    await initGitRepo(testDir)
    await setupRemote(testDir)

    // make and commit changes
    await $`echo "new line" >> ${testDir}/README.md`.quiet()
    await $`git -C ${testDir} add .`.quiet()
    await $`git -C ${testDir} commit -m "add line"`.quiet()

    const result = await runGdtt(testDir, ["-u"])
    expect(result.exitCode).toBe(0)

    const stats = parseOutput(result.stdout)
    expect(stats).not.toBeNull()
    expect(stats!.additions).toBeGreaterThan(0)
  })

  test("shows no changes when everything is pushed", async () => {
    await initGitRepo(testDir)
    await setupRemote(testDir)

    // make, commit, and push changes
    await $`echo "new line" >> ${testDir}/README.md`.quiet()
    await $`git -C ${testDir} add .`.quiet()
    await $`git -C ${testDir} commit -m "add line"`.quiet()
    await $`git -C ${testDir} push`.quiet()

    const result = await runGdtt(testDir, ["-u"])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("no changes!")
  })
})

describe("gdtt -b/--base flag", () => {
  test("compares against specific branch", async () => {
    await initGitRepo(testDir)
    await setupRemote(testDir)

    // create a feature branch
    await $`git -C ${testDir} checkout -b feature`.quiet()
    await $`echo "feature work" >> ${testDir}/feature.txt`.quiet()
    await $`git -C ${testDir} add .`.quiet()
    await $`git -C ${testDir} commit -m "add feature"`.quiet()

    // compare against main
    const result = await runGdtt(testDir, ["-b", "main"])
    expect(result.exitCode).toBe(0)

    const stats = parseOutput(result.stdout)
    expect(stats).not.toBeNull()
    expect(stats!.additions).toBeGreaterThan(0)
  })

  test("requires branch name argument", async () => {
    await initGitRepo(testDir)

    const result = await runGdtt(testDir, ["-b"])
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("-b/--base requires a branch name")
  })
})

describe("gdtt help", () => {
  test("shows help with -h flag", async () => {
    await initGitRepo(testDir)

    const result = await runGdtt(testDir, ["-h"])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("usage: gdtt")
    expect(result.stdout).toContain("--upstream")
    expect(result.stdout).toContain("--base")
    expect(result.stdout).toContain("--committed-only")
  })

  test("shows help with --help flag", async () => {
    await initGitRepo(testDir)

    const result = await runGdtt(testDir, ["--help"])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("usage: gdtt")
  })
})

describe("gdtt error handling", () => {
  test("errors when not in a git repository", async () => {
    const result = await runGdtt(testDir)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("not a git repository")
  })

  test("errors on unknown flag", async () => {
    await initGitRepo(testDir)

    const result = await runGdtt(testDir, ["--unknown-flag"])
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("unknown option")
  })
})

describe("gdtt no_color support", () => {
  test("produces plain output in tests (NO_COLOR=1)", async () => {
    await initGitRepo(testDir)
    await setupRemote(testDir)

    // introduce a change to ensure output path with stats
    await $`echo "change" >> ${testDir}/README.md`.quiet()

    const result = await runGdtt(testDir)
    expect(result.stdout).toMatch(outputRegex)
  })
})

describe("gdtt with deletions", () => {
  test("counts line deletions", async () => {
    await initGitRepo(testDir)
    await setupRemote(testDir)

    // add a file with multiple lines
    await $`echo "line 1\nline 2\nline 3\nline 4\nline 5" > ${testDir}/file.txt`.quiet()
    await $`git -C ${testDir} add .`.quiet()
    await $`git -C ${testDir} commit -m "add file"`.quiet()
    await $`git -C ${testDir} push`.quiet()

    // delete some lines
    await $`echo "line 1\nline 2" > ${testDir}/file.txt`.quiet()

    const result = await runGdtt(testDir)
    expect(result.exitCode).toBe(0)

    const stats = parseOutput(result.stdout)
    expect(stats).not.toBeNull()
    expect(stats!.deletions).toBeGreaterThan(0)
  })

  test("counts file deletions", async () => {
    await initGitRepo(testDir)
    await setupRemote(testDir)

    // add multiple files
    await $`echo "file 1" > ${testDir}/file1.txt`.quiet()
    await $`echo "file 2" > ${testDir}/file2.txt`.quiet()
    await $`git -C ${testDir} add .`.quiet()
    await $`git -C ${testDir} commit -m "add files"`.quiet()
    await $`git -C ${testDir} push`.quiet()

    // delete a file
    await $`rm ${testDir}/file1.txt`.quiet()

    const result = await runGdtt(testDir)
    expect(result.exitCode).toBe(0)

    const stats = parseOutput(result.stdout)
    expect(stats).not.toBeNull()
    expect(stats!.filesDeleted).toBeGreaterThan(0)
  })
})

describe("gdtt with master branch", () => {
  test("detects origin/master when origin/main doesn't exist", async () => {
    // initialize with master as default branch
    await $`git -C ${testDir} -c init.defaultBranch=master init`.quiet()
    await $`git -C ${testDir} config user.name "Test User"`.quiet()
    await $`git -C ${testDir} config user.email "test@example.com"`.quiet()
    await $`echo "# test" > ${testDir}/README.md`.quiet()
    await $`git -C ${testDir} add .`.quiet()
    await $`git -C ${testDir} commit -m "initial commit"`.quiet()

    const remoteDir = join(tmpdir(), `gdtt-remote-${Date.now()}`)
    await $`git init --bare ${remoteDir}`.quiet()
    await $`git -C ${testDir} remote add origin ${remoteDir}`.quiet()
    await $`git -C ${testDir} push -u origin master`.quiet()
    // ensure remote-tracking refs exist locally for origin/master
    await $`git -C ${testDir} fetch origin`.quiet()

    // make changes
    await $`echo "new line" >> ${testDir}/README.md`.quiet()

    const result = await runGdtt(testDir)

    // debug output if test fails
    if (result.exitCode !== 0) {
      console.log("stderr:", result.stderr)
      console.log("stdout:", result.stdout)
    }

    expect(result.exitCode).toBe(0)

    const stats = parseOutput(result.stdout)
    expect(stats).not.toBeNull()
    expect(stats!.additions).toBeGreaterThan(0)

    // cleanup
    await rm(remoteDir, { force: true, recursive: true }).catch(() => {
      // ignore cleanup errors
    })
  })
})

# gdtt

fast git diff stats

## install

```bash
bunx gdtt@latest
```

## usage

```bash
gdtt                      # compare against origin/main (full PR diff)
gdtt -u                   # compare against upstream (unpushed changes)
gdtt -b develop           # compare against specific branch
gdtt --committed-only     # exclude uncommitted and untracked changes
gdtt --no-untracked       # exclude untracked files
```

**default behavior**: shows total diff including uncommitted, unpushed, and untracked changes

## output

```
+84 -297 Σ381 | +4 -4 files
++++---------------
```

- `+84 -297`: lines added/removed
- `Σ381`: total lines changed
- `+4 -4 files`: files with changes
- visual bar: green=additions, red=deletions

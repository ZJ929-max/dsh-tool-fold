#!/usr/bin/env node
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * scripts/release.mjs — 按 docs/VERSIONING.md 发版
 *
 *   node scripts/release.mjs            升候选：0.0.1-re1 → 0.0.1-re2；0.0.1 → 0.0.2-re1
 *   node scripts/release.mjs --final    去掉 -reN（要求 Unreleased 非空）
 *   node scripts/release.mjs --dry-run  只看结果
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = new Set(process.argv.slice(2))
const dryRun = args.has('--dry-run')
const final = args.has('--final')

const pkgPath = join(root, 'package.json')
const changelogPath = join(root, 'CHANGELOG.md')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const changelog = readFileSync(changelogPath, 'utf8')
const current = String(pkg.version ?? '')

const match = /^(\d+)\.(\d+)\.(\d+)(?:-re(\d+))?$/.exec(current)
if (!match) {
  console.error('✗ version 不符合 0.0.N[-reX]：' + current)
  process.exit(1)
}
const [, major, minor, checkpoint, candidate] = match

let next
if (final) {
  if (candidate === undefined) {
    console.error('✗ 当前已经是正式号 ' + current + '，没有 -reN 可去。')
    process.exit(1)
  }
  next = `${major}.${minor}.${checkpoint}`
  if (!/^## Unreleased\n+\S/m.test(changelog)) {
    console.error('✗ “## Unreleased” 是空的：没有要发的改动就不要封版。')
    process.exit(1)
  }
} else if (candidate !== undefined) {
  next = `${major}.${minor}.${checkpoint}-re${Number(candidate) + 1}`
} else {
  next = `${major}.${minor}.${Number(checkpoint) + 1}-re1`
}

console.log(`版本：${current} → ${next}${final ? '（checkpoint 收尾）' : '（候选，不承诺兼容）'}`)
if (dryRun) {
  console.log('dry-run：不写文件。')
  process.exit(0)
}

pkg.version = next
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
if (final) writeFileSync(changelogPath, changelog.replace(/^## Unreleased$/m, `## ${next}`), 'utf8')

let commit = '(未提交)'
try {
  execFileSync('git', ['add', '-A'], { cwd: root })
  execFileSync('git', ['-c', 'user.name=ZJ929-max', '-c', 'user.email=zij109@outlook.com', 'commit', '-m', `release ${next}`], { cwd: root })
  commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
} catch {
  console.log('（自动提交失败，版本文件已改好，请手动提交后取 commit）')
}

console.log('\n整合包钉点（plugin-pack/patches/10-lazy-tools.yml）：')
console.log(`# ${pkg.name} ${next}`)
console.log(`# https://github.com/ZJ929-max/dsh-tool-fold/blob/${commit}/cordis.patch.yml`)
console.log(`target ${pkg.name} → git+https://github.com/ZJ929-max/dsh-tool-fold.git#${commit}`)

#!/usr/bin/env node
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * scripts/release.mjs — 按 docs/VERSIONING.md 的规则封版
 *
 *   node scripts/release.mjs           原型规则：只升 patch
 *   node scripts/release.mjs --minor   契约变更（需在 CHANGELOG 写明）
 *   node scripts/release.mjs --dry-run 只看结果
 *
 * 做三件事：Unreleased → 新版本号；同步 package.json；打印整合包的钉点行。
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = new Set(process.argv.slice(2))
const dryRun = args.has('--dry-run')
const minor = args.has('--minor')

const pkgPath = join(root, 'package.json')
const changelogPath = join(root, 'CHANGELOG.md')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const changelog = readFileSync(changelogPath, 'utf8')

if (!/^## Unreleased$/m.test(changelog)) {
  console.error('✗ CHANGELOG.md 里没有 "## Unreleased" 小节；先把这次改动写进去再封版。')
  process.exit(1)
}
const unreleasedBody = changelog.split(/^## Unreleased$/m)[1]?.split(/^## /m)[0] ?? ''
if (unreleasedBody.trim() === '') {
  console.error('✗ "## Unreleased" 是空的；没有要发的改动就不要升版本。')
  process.exit(1)
}

const [major, currentMinor, currentPatch] = pkg.version.split('.').map(Number)
if (![major, currentMinor, currentPatch].every(Number.isFinite)) {
  console.error('✗ package.json 的 version 不是 x.y.z：' + pkg.version)
  process.exit(1)
}
const next = minor
  ? `${major}.${currentMinor + 1}.0`
  : `${major}.${currentMinor}.${currentPatch + 1}`

console.log(`版本：${pkg.version} → ${next}${minor ? '（minor：请确认 CHANGELOG 写明了契约变更）' : '（prototype：仅 patch）'}`)
if (dryRun) {
  console.log('dry-run：不写文件。')
  process.exit(0)
}

pkg.version = next
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
writeFileSync(changelogPath, changelog.replace(/^## Unreleased$/m, `## ${next}`), 'utf8')

let commit = '(未提交)'
try {
  execFileSync('git', ['add', '-A'], { cwd: root })
  execFileSync('git', ['-c', 'user.name=ZJ929-max', '-c', 'user.email=zij109@outlook.com', 'commit', '-m', `release ${next}`], { cwd: root })
  commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
} catch {
  console.log('（自动提交失败，版本文件已改好，请手动提交后取 commit）')
}

console.log('\n整合包钉点（plugin-pack/patches/10-tool-fold.yml）：')
console.log(`# dsh-tool-fold ${next}`)
console.log(`# https://github.com/ZJ929-max/dsh-tool-fold/blob/${commit}/cordis.patch.yml`)
console.log(`target dsh-tool-fold → git+https://github.com/ZJ929-max/dsh-tool-fold.git#${commit}`)

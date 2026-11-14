import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { basename } from 'node:path'
import { loadKnowledge, knowledgeRoot } from '../knowledge/load.js'
import { digest, mergeDraftKnowledge } from './lib/merge-draft-knowledge.mjs'

const sourcePath = process.argv[2]
if (!sourcePath) throw new Error('Usage: node scripts/merge-knowledge.mjs /path/to/knowledge-draft.json')
const raw = await readFile(sourcePath, 'utf8')
const draft = JSON.parse(raw)
const hash = digest(raw)
const root = knowledgeRoot()
const archivePath = `knowledge/imports/full-knowledge-${hash.slice(0, 12)}.json`
const reportPath = new URL(`imports/full-knowledge-${hash.slice(0, 12)}.report.json`, root)
const current = await loadKnowledge({ root })
if (current.errors.length) throw new Error(current.errors.join('\n'))
let previousReport
try { previousReport = JSON.parse(await readFile(reportPath, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
if (previousReport?.source.sha256 === hash) {
  console.log('This exact draft has already been merged. No files changed.')
} else {
  const result = mergeDraftKnowledge(current, draft, { sourceName: basename(sourcePath), sourceHash: hash, archivePath })
  // Validate the complete result before writing any modules. Unchanged modules
  // and existing fact objects are preserved; the archive is not a runtime module.
  for (let i = 0; i < result.modules.length; i++) {
    const path = result.index.modules[i]
    const content = JSON.stringify(result.modules[i], null, 2) + '\n'
    if (JSON.stringify(current.modules[current.index.modules.indexOf(path)]) !== JSON.stringify(result.modules[i])) await writeFile(new URL(path, root), content)
  }
  if (JSON.stringify(current.index) !== JSON.stringify(result.index)) await writeFile(new URL('index.json', root), JSON.stringify(result.index, null, 2) + '\n')
  await mkdir(new URL('imports/', root), { recursive: true })
  await writeFile(new URL(archivePath.replace('knowledge/', ''), root), raw)
  await writeFile(reportPath, JSON.stringify(result.report, null, 2) + '\n')
  console.log(JSON.stringify(result.report.summary, null, 2))
  console.log(`Merge report: ${reportPath.pathname}`)
}

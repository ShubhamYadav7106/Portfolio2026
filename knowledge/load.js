import { readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve, sep } from 'node:path'
import { validateKnowledge, todayUTC } from './validation.js'

// The server opts into caching; other callers retain the existing loader API.
export function createCachedKnowledgeLoader() {
  const directory = fileURLToPath(new URL('./', import.meta.url))
  const indexFile = resolve(directory, 'index.json')
  let entry = null
  const signature = async files => JSON.stringify(await Promise.all(files.map(async file => {
    const info = await stat(file, { bigint: true })
    return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].map(String)
  })))
  return async () => {
    const day = todayUTC()
    const files = entry?.files ?? [indexFile]
    let before
    try { before = await signature(files) } catch (error) { entry = null; throw error }
    if (entry?.result && entry.files === files && entry.day === day && entry.signature === before) return structuredClone(entry.result)
    // Never fall back to old approvals after a changed, missing or invalid file.
    entry = null
    const result = await loadKnowledge({ today: day })
    if (result.errors.length) return result
    const nextFiles = [indexFile, ...result.index.modules.map(path => resolve(directory, path))]
    const after = await signature(nextFiles)
    const stable = todayUTC() === day && files.length === nextFiles.length && files.every((file, index) => file === nextFiles[index]) && before === after
    // Newly discovered module paths need a complete before/after observation
    // on the next load. Cached data is private so callers cannot mutate it.
    entry = { day, files: nextFiles, signature: after, result: stable ? structuredClone(result) : null }
    return result
  }
}

export async function loadKnowledge({ root = new URL('./', import.meta.url), today } = {}) {
  const directory = fileURLToPath(root)
  const index = JSON.parse(await readFile(resolve(directory, 'index.json'), 'utf8'))
  if (!Array.isArray(index.modules)) throw new Error('Knowledge index must list modules')
  const modules = await Promise.all(index.modules.map(async path => {
    if (typeof path !== 'string' || !/^(?:[a-z0-9-]+\/)*[a-z0-9-]+\.json$/.test(path)) throw new Error('Invalid knowledge module path')
    const file = resolve(directory, path)
    if (!file.startsWith(directory + (directory.endsWith(sep) ? '' : sep))) throw new Error('Knowledge module must stay in its directory')
    return JSON.parse(await readFile(file, 'utf8'))
  }))
  return { index, modules, ...validateKnowledge(index, modules, { today }) }
}

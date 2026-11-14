import { loadKnowledge } from '../knowledge/load.js'
import { isEligibleFact } from '../knowledge/validation.js'

try {
  const result = await loadKnowledge()
  if (process.argv.includes('--export-public')) {
    if (result.errors.length) throw new Error('Knowledge validation failed; export refused')
    const selected = result.modules.map((module, index) => ({ path: result.index.modules[index], module: {
      schemaVersion: module.schemaVersion, id: module.id, title: module.title, category: module.category, presentation: [],
      facts: module.facts.filter(fact => isEligibleFact(fact)).map(fact => ({
        ...fact,
        sources: [{ type: 'owner', reference: 'Approved public runtime snapshot; detailed provenance retained in private storage.' }],
        verification: { ...fact.verification, approvalReference: 'Owner-approved public runtime snapshot.' },
      })),
    } })).filter(entry => entry.module.facts.length)
    // Export only the runtime schema, never review notes, imports or private facts.
    process.stdout.write(JSON.stringify({ index: { schemaVersion: 2, assistantName: result.index.assistantName, modules: selected.map(entry => entry.path) }, modules: selected.map(entry => entry.module) }))
  } else {
    for (const error of result.errors) console.error(`ERROR: ${error}`)
    for (const warning of result.warnings) console.warn(`WARNING: ${warning}`)
    const pending = result.facts.filter(fact => fact.status === 'pending_review').length
    const verified = result.facts.filter(fact => fact.status === 'verified').length
    const eligible = result.facts.filter(fact => isEligibleFact(fact)).length
    console.log(`Knowledge: ${result.modules.length} modules, ${result.facts.length} facts, ${verified} verified, ${pending} pending review, ${eligible} eligible for Recruiter Mode.`)
    if (result.errors.length) process.exitCode = 1
    else console.log('Knowledge validation passed. Validation does not approve or verify personal facts.')
  }
} catch (error) {
  console.error(`Knowledge validation failed: ${error.message}`)
  process.exitCode = 1
}

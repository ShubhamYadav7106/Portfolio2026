import { loadKnowledge } from '../knowledge/load.js'
import { isEligibleFact } from '../knowledge/validation.js'

try {
  const result = await loadKnowledge()
  for (const error of result.errors) console.error(`ERROR: ${error}`)
  for (const warning of result.warnings) console.warn(`WARNING: ${warning}`)
  const pending = result.facts.filter(fact => fact.status === 'pending_review').length
  const verified = result.facts.filter(fact => fact.status === 'verified').length
  const eligible = result.facts.filter(fact => isEligibleFact(fact)).length
  console.log(`Knowledge: ${result.modules.length} modules, ${result.facts.length} facts, ${verified} verified, ${pending} pending review, ${eligible} eligible for Recruiter Mode.`)
  if (result.errors.length) process.exitCode = 1
  else console.log('Knowledge validation passed. Validation does not approve or verify personal facts.')
} catch (error) {
  console.error(`Knowledge validation failed: ${error.message}`)
  process.exitCode = 1
}

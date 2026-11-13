import index from '../../../knowledge/index.json'
import { validateKnowledge } from '../../../knowledge/validation.js'

// The index is the editable source of module membership. New domain JSON files
// are discovered at build time; the frozen snapshot is never used for answers.
const documents = import.meta.glob([
  '../../../knowledge/*.json',
  '../../../knowledge/experience/*.json',
  '../../../knowledge/projects/*.json',
  '!../../../knowledge/personal-knowledge.json',
  '!../../../knowledge/schema.json',
  '!../../../knowledge/index.json',
], { eager: true, import: 'default' })
const modules = index.modules.map(path => documents[`../../../knowledge/${path}`])
const result = validateKnowledge(index, modules)
// Invalid data fails closed in the browser. The build validation gives editors
// the detailed errors without showing implementation details to visitors.
export const knowledgeFacts = result.errors.length ? [] : result.facts

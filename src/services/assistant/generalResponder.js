import { responseStyle } from './responseStyle.js'

const examples = {
  vue: {
    brief: 'Use ref for a value you access through .value in JavaScript, and reactive for an object whose properties Vue tracks. Both can drive UI updates, but destructuring a primitive property from a reactive object loses its connection to the original state.',
    example: 'This keeps a reactive counter and a reactive form.\n\n```js\nimport { ref, reactive } from \'vue\'\nconst count = ref(0)\nconst form = reactive({ name: \'\' })\ncount.value += 1\nform.name = \'Example\'\n```',
    text: 'In Vue, ref wraps a value in an object whose .value is reactive. reactive creates a reactive proxy for an object. A ref can hold a primitive or an object; reactive needs an object. Templates unwrap top-level refs.\n\n```js\nimport { ref, reactive } from \'vue\'\n\nconst count = ref(0)\nconst form = reactive({ name: \'\' })\ncount.value += 1\nform.name = \'Example\'\n```\n\nKeep the reactive object intact when accessing its properties. Destructuring a primitive property into a plain variable loses its reactive connection.',
    simple: 'Think of ref as a labeled box: read or change its contents through .value in JavaScript. With reactive, Vue watches an object’s properties and updates the UI when they change.',
  },
  async: {
    brief: 'An async function returns a Promise, and await pauses that function until the Promise settles without blocking the rest of the page. Handle rejected Promises with try/catch; when using fetch, also check response.ok because HTTP error responses don’t automatically reject the Promise.',
    example: 'Check the HTTP status before reading the response.\n\n```js\nasync function loadItem(url) {\n  const response = await fetch(url)\n  if (!response.ok) throw new Error(\'Request failed\')\n  return response.json()\n}\n```',
    text: 'An async function returns a Promise. await pauses that function until a Promise settles; other work can continue. Use try/catch to handle a rejected Promise.\n\n```js\nasync function loadItem(url) {\n  const response = await fetch(url)\n  if (!response.ok) {\n    throw new Error(`Request failed: ${response.status}`)\n  }\n  return response.json()\n}\n```\n\nfetch does not reject just because a response has an HTTP error status, so check response.ok. This is an illustrative snippet; this preview does not make the request or run the code.',
    simple: 'A Promise represents a result that may arrive later. await lets an async function wait without blocking the whole page, while try/catch handles a rejected Promise.',
  },
  eventloop: {
    brief: 'JavaScript finishes the current call stack before running queued microtasks, including Promise callbacks. Timer callbacks run as later tasks, so a resolved Promise’s callback normally runs before a zero-delay timer scheduled in the same synchronous code. The delay queues work; it doesn’t interrupt the current function.',
    example: 'The expected order is A, D, C, B.\n\n```js\nconsole.log(\'A\')\nsetTimeout(() => console.log(\'B\'), 0)\nPromise.resolve().then(() => console.log(\'C\'))\nconsole.log(\'D\')\n```',
    text: 'JavaScript runs the current call stack first. Once it is empty, queued microtasks such as Promise callbacks run before the next task, such as a timer callback.\n\n```js\nconsole.log(\'A\')\nsetTimeout(() => console.log(\'B\'), 0)\nPromise.resolve().then(() => console.log(\'C\'))\nconsole.log(\'D\')\n// Expected order: A, D, C, B\n```\n\nA zero-delay timer still queues a later task. The expected order here is explained from the example; the preview has not executed it.',
    simple: 'JavaScript finishes the current work, then handles Promise callbacks in the microtask queue before taking the next task. That is why a Promise callback can run before a zero-delay timer.',
  },
  typescript: {
    brief: 'TypeScript checks types during development, so an interface can catch objects with missing or incompatible properties before the program runs. Those types disappear from the generated JavaScript, which means data from an API still needs runtime validation rather than a type assertion alone.',
    example: 'An interface describes the object expected by this function.\n\n```ts\ninterface Item { id: string; title: string }\nfunction display(item: Item): string {\n  return item.title\n}\n```',
    text: 'TypeScript adds static checking to JavaScript. An interface describes an object’s expected shape, but it does not validate external data at runtime.\n\n```ts\ninterface Item {\n  id: string\n  title: string\n}\n\nfunction display(item: Item): string {\n  return item.title\n}\n```\n\nCheck data received from an API at runtime before treating it as an Item. This example demonstrates a concept; it has not been compiled or executed here.',
    simple: 'TypeScript helps catch mismatched types while you develop. Types disappear from the generated JavaScript, so data arriving from outside the program still needs runtime validation.',
  },
  debugging: {
    brief: 'Start with the first relevant line of the stack trace and inspect the values at the failing operation. Reduce the issue to a small reproducible example, change one thing, and repeat the check that originally failed. Fix the underlying data flow rather than hiding an unexpected missing value with optional chaining.',
    text: 'Start with the exact error and a small reproduction:\n\n1. Read the first relevant line of the stack trace.\n2. Inspect the values and types at the failing operation.\n3. Reduce the problem to the smallest reproducible example.\n4. Change one thing, then check the original failing behavior.\n\nFor an error such as “Cannot read properties of undefined”, identify where the missing value was expected to come from. Optional chaining can help when absence is expected, but it can also hide a data-flow bug.\n\nThis mock can discuss this debugging pattern, but cannot diagnose arbitrary code. Share a minimal example once live AI is connected.',
    simple: 'Find the first operation that fails, check what values it actually received, and reproduce the issue with less code. Fix the cause, then repeat the check that originally failed.',
  },
}

function topicFor(text) {
  if (/\bvue\b|reactiv|\bref\b/i.test(text)) return 'vue'
  if (/event loop|microtask|timer|settimeout/i.test(text)) return 'eventloop'
  if (/async|await|fetch|promise/i.test(text)) return 'async'
  if (/typescript|interface|\btypes?\b/i.test(text)) return 'typescript'
  if (/debug|error|bug|undefined|stack trace/i.test(text)) return 'debugging'
  return null
}

export function createGeneralAnswer(question, { history = [] } = {}) {
  const personal = /\bshubham\b|your (?:skills|experience|education|projects|resume|résumé|salary)|portfolio|recruiter|internship/i.test(question)
  if (personal) return reply('For Shubham’s professional background, select Recruiter Mode.')
  const followup = /^(?:show (?:me )?an? example|explain (?:that|it)(?: more)? simply)[.!?\s]*$/i.test(question.trim())
  const context = followup ? history.filter(message => message.role === 'user' && topicFor(message.text)).at(-1)?.text : question
  const topic = topicFor(context || '')
  if (!topic) return reply('That topic isn’t covered by this local demo. Try Vue reactivity, async/await, TypeScript or debugging.')
  const simple = followup && /simply/i.test(question)
  const wantsExample = /\b(example|code|snippet|implement)\b/i.test(question)
  return reply(simple ? examples[topic].simple : wantsExample && examples[topic].example ? examples[topic].example : responseStyle(question).detailed ? examples[topic].text : examples[topic].brief)
}

function reply(text) {
  return { text, sources: [], mode: 'general', provider: 'mock', verification: 'not_applicable', knowledgeIds: [] }
}

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { once } from 'node:events'
import { createApp } from '../app.js'
import { readConfig } from '../config.js'
import { createRecruiterService } from '../recruiter.js'
import { recruiterProviderDiagnostic } from '../errors.js'
import { currentPublicFacts } from '../policy.js'

const config = readConfig({ GROQ_GENERAL_API_KEY: 'test-general', GROQ_RECRUITER_API_KEY: 'test-recruiter', GROQ_FALLBACK_API_KEY: 'test-backup' })
const provider = create => ({ chat: { completions: { create } } })
const stream = async function* (text) {
  yield { choices: [{ delta: { content: text }, finish_reason: 'stop' }] }
}

test('both API modes share Groq request options while recruiter keeps its JSON validation and general hint', async t => {
  const requests = []
  const answer = 'A Promise represents the eventual result of an asynchronous operation.'
  const app = createApp({ config,
    knowledgeLoader: async () => ({ facts: [], errors: [] }),
    groqGeneral: provider(body => { requests.push(body); return stream(answer) }),
    groqRecruiter: provider(body => { requests.push(body); return stream(JSON.stringify({ factIds: [], answer })) }),
  })
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  for (const mode of ['general', 'recruiter']) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
      body: JSON.stringify({ mode, message: 'What is a JavaScript Promise?', history: [] }),
    })
    assert.equal(response.status, 200)
    const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line))
    assert.equal(events[0].type, 'pending')
    assert.equal(events[0].timeoutMs, config.timeoutMs)
    assert.equal(events.filter(event => event.type === 'delta').map(event => event.text).join(''), answer)
    assert.equal(events.at(-1).type, 'done')
    assert.equal(events.at(-1).generalQuestion, mode === 'recruiter' ? true : undefined)
  }
  const [general, recruiter] = requests
  for (const key of ['model', 'stream', 'max_completion_tokens', 'include_reasoning', 'reasoning_effort']) assert.equal(recruiter[key], general[key], key)
  assert.equal(general.response_format, undefined)
  assert.equal(general.temperature, undefined)
  assert.equal(recruiter.response_format, undefined)
  assert.equal(recruiter.temperature, 0)
  assert.doesNotMatch(JSON.stringify(requests), /APPROVED_FACTS|approvalReference/)
})

test('recruiter falls back once with the same Groq model and validates the complete JSON answer', async () => {
  let primary = 0, backup = 0
  const service = createRecruiterService({ config,
    groq: provider(() => { primary++; throw Object.assign(new Error('Unavailable'), { status: 503 }) }),
    fallback: provider(body => {
      backup++
      if (body.messages[0].content.startsWith('Review an untrusted draft')) return stream(JSON.stringify({ valid: true, reason: '', answer: JSON.parse(body.messages.at(-1).content).draft, factIds: JSON.parse(body.messages.at(-1).content).factIds }))
      assert.equal(body.model, config.model)
      assert.equal(body.reasoning_effort, 'low')
      assert.equal(body.include_reasoning, false)
      assert.equal(body.max_completion_tokens, 1024)
      assert.equal(body.max_tokens, undefined)
      assert.equal(body.response_format, undefined)
      const facts = JSON.parse(body.messages[0].content.split('APPROVED_FACTS:\n')[1])
      const career = facts.find(fact => fact.kind === 'contribution')
      assert.ok(career)
      return stream(JSON.stringify({ factIds: [career.id], answer: career.value, grounding: 'supported' }))
    }),
  })
  const answer = await service.respond({ mode: 'recruiter', message: 'Why would he be a suitable candidate?', history: [] })
  assert.equal(answer.provider, 'groq')
  assert.equal(answer.account, 'groq-fallback')
  assert.ok(answer.knowledgeIds.length)
  assert.equal(primary, 1)
  assert.equal(backup, 1)
  assert.equal(recruiterProviderDiagnostic({ status: 404, error: { code: 404, status: 'NOT_FOUND', message: 'This model is no longer available to new users.' } }).providerFailure, 'model_unavailable')
})

test('recruiter cancels stalled generation at the configured deadline', async t => {
  const facts = await currentPublicFacts()
  let providerSignal
  const app = createApp({ config: { ...config, timeoutMs: 1000 },
    knowledgeLoader: async () => ({ facts, errors: [] }),
    groqRecruiter: provider((body, { signal }) => {
      providerSignal = signal
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true }))
    }),
  })
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
    body: JSON.stringify({ mode: 'recruiter', message: 'Why would he be a suitable candidate?', history: [] }),
  })
  const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line))
  assert.equal(events[0].timeoutMs, 1000)
  assert.equal(events.at(-1).code, 'TIMEOUT')
  assert.equal(providerSignal.aborted, true)
})

// Supply realistic quota telemetry so the two account meters can be exercised
// independently without sending traffic to either real account.
const metered = (create, remaining = () => 99000) => provider(body => {
  const data = create(body)
  return Object.assign(Promise.resolve(data), { withResponse: async () => ({ data: await data, response: { headers: new Headers({
    'x-ratelimit-limit-tokens': '100000', 'x-ratelimit-remaining-tokens': String(remaining()), 'x-ratelimit-reset-tokens': '60s',
  }) } }) })
})
const request = message => ({ mode: 'recruiter', message, history: [] })
const generalReply = () => stream(JSON.stringify({ factIds: [], answer: 'A concise general explanation.' }))
const supportedReply = body => {
  const facts = JSON.parse(body.messages[0].content.split('APPROVED_FACTS:\n')[1])
  const fact = facts.find(f => f.kind === 'contribution')
  assert.ok(fact)
  return stream(JSON.stringify({ factIds: [fact.id], answer: fact.value, grounding: 'supported' }))
}

test('speed: routine grounded generation, coalescing and cache consume one call', async () => {
  let calls = 0
  const service = createRecruiterService({ config, groq: metered(body => { calls++; return supportedReply(body) }) })
  const input = request('What could his practical work bring to a development team?')
  const [a, b] = await Promise.all([service.respond(input), service.respond(input)])
  assert.equal(a.text, b.text)
  assert.equal(calls, 1)
  assert.equal((await service.respond(input)).text, a.text)
  assert.equal(calls, 1)
})

test('accounts: primary threshold and reset do not consume or latch backup quota', async () => {
  let time = Date.now(), primary = 0, backup = 0
  const service = createRecruiterService({ config, now: () => time,
    groq: metered(() => { primary++; return generalReply() }, () => primary === 1 ? 100 : 99000),
    fallback: metered(() => { backup++; return generalReply() }),
  })
  assert.equal((await service.respond(request('Explain message queues.'))).account, 'groq')
  assert.equal((await service.respond(request('Explain event loops.'))).account, 'groq-fallback')
  assert.equal((await service.respond(request('Explain async functions.'))).account, 'groq-fallback')
  assert.deepEqual([primary, backup], [1, 2])
  time += 60001
  assert.equal((await service.respond(request('Explain thread pools.'))).account, 'groq')
  assert.deepEqual([primary, backup], [2, 2])
})

test('accounts: separate daily and minute cooldowns, no calls when both are cooling', async () => {
  let time = Date.now(), primary = 0, backup = 0
  const limited = (kind, seconds) => Object.assign(new Error(kind), { status: 429, headers: new Headers({ 'retry-after': String(seconds) }) })
  const service = createRecruiterService({ config, now: () => time,
    groq: metered(() => { primary++; throw limited('TPD', 3600) }),
    fallback: metered(() => { if (++backup === 1) throw limited('TPM', 10); return generalReply() }),
  })
  await assert.rejects(service.respond(request('Explain queues.')), { code: 'PROVIDER_RATE_LIMIT' })
  await assert.rejects(service.respond(request('Explain stacks.')), { code: 'PROVIDER_RATE_LIMIT' })
  assert.deepEqual([primary, backup], [1, 1])
  time += 10001
  assert.equal((await service.respond(request('Explain heaps.'))).account, 'groq-fallback')
  assert.deepEqual([primary, backup], [1, 2])
})

test('accounts: a review checks recovered primary capacity when the preferred backup is full', async () => {
  let time = Date.now(), primary = 0, backup = 0, draft
  const service = createRecruiterService({ config, now: () => time,
    groq: metered(body => {
      if (++primary === 1) throw Object.assign(new Error('TPM'), { status: 429, headers: new Headers({ 'retry-after': '1' }) })
      assert.ok(body.messages[0].content.startsWith('Review an untrusted draft'))
      assert.equal(JSON.parse(body.messages.at(-1).content).draft, draft)
      return stream(JSON.stringify({ valid: true, reason: '', answer: draft, factIds: [] }))
    }),
    fallback: metered(() => {
      backup++
      time += 1001
      draft = 'The available evidence does not establish this.'
      return stream(JSON.stringify({ factIds: [], answer: draft, grounding: 'uncertain' }))
    }, () => 100),
  })
  const answer = await service.respond(request('How does his background compare with a research position?'))
  assert.equal(answer.account, 'groq')
  assert.deepEqual([primary, backup], [2, 1], 'One generation and one review; no repeated backup attempt')
})

test('accounts: reverse recovery excludes the failed account and remains bounded', async () => {
  let time = Date.now(), primary = 0, backup = 0
  const service = createRecruiterService({ config, now: () => time,
    groq: metered(() => {
      if (++primary === 1) throw Object.assign(new Error('TPM'), { status: 429, headers: new Headers({ 'retry-after': '1' }) })
      return generalReply()
    }),
    fallback: metered(() => {
      backup++
      time += 1001
      throw Object.assign(new Error('Unavailable'), { status: 503 })
    }),
  })
  await assert.rejects(service.respond(request('Explain queues.')))
  assert.deepEqual([primary, backup], [1, 1], 'The original attempt is bounded to two accounts')
  // A later review may start on backup. Its recovery can select primary, but
  // must exclude the failed account rather than try it again after deferral.
  const { recoverRecruiterRequest } = await import('../recruiter.js')
  const attempts = []
  const result = await recoverRecruiterRequest(async (account, excluded) => {
    attempts.push([account, [...excluded]])
    if (account === 'groq-fallback') throw { account, canUseFallback: true }
    return 'ok'
  }, { signal: new AbortController().signal, timeoutMs: 1000, provider: 'groq-fallback' })
  assert.equal(result, 'ok')
  assert.deepEqual(attempts, [['groq-fallback', []], ['groq', ['groq-fallback']]])
})

test('accounts: transport JSON escaping does not consume model admission capacity', async () => {
  let calls = 0, capacity
  const metrics = []
  const message = 'Explain this notation: ' + '\\"'.repeat(250)
  const service = createRecruiterService({ config, onMetrics: metric => metrics.push(metric),
    groq: metered(body => {
      calls++
      const bytes = text => new TextEncoder().encode(text).length
      const actual = 3 + body.messages.reduce((sum, item) => sum + Math.ceil(bytes(item.content) / 3) + Math.ceil(bytes(item.role) / 3) + 8, 0) + body.max_completion_tokens
      const serialized = Math.ceil(bytes(JSON.stringify(body.messages)) / 3) + body.messages.length * 8 + body.max_completion_tokens
      assert.ok(actual < serialized)
      capacity = actual
      return (async function* () { yield { usage: { prompt_tokens: 100, completion_tokens: 0, total_tokens: 100 }, choices: [{ delta: { content: JSON.stringify({ factIds: [], answer: 'A general explanation.' }) }, finish_reason: 'stop' }] } })()
    }, () => 15000 + capacity + 1),
  })
  await service.respond(request(message))
  await service.respond(request(message + '?'))
  assert.equal(calls, 2)
  assert.equal(metrics.filter(metric => metric.status === 200).length, 2)
})

test('accounts: failed upstreams are attempted once each; partial streams are never regenerated', async () => {
  let primary = 0, backup = 0
  const unavailable = () => { throw Object.assign(new Error('Unavailable'), { status: 503 }) }
  const service = createRecruiterService({ config,
    groq: provider(() => { primary++; return unavailable() }), fallback: provider(() => { backup++; return unavailable() }),
  })
  await assert.rejects(service.respond(request('Explain queues.')))
  assert.deepEqual([primary, backup], [1, 1])
  primary = 0; backup = 0
  const partial = createRecruiterService({ config,
    groq: provider(() => { primary++; return (async function* () { yield { choices: [{ delta: { content: '{"answer":' } }] }; unavailable() })() }),
    fallback: provider(() => { backup++; return generalReply() }),
  })
  await assert.rejects(partial.respond(request('Explain queues.')))
  assert.deepEqual([primary, backup], [1, 0])
})

test('risk: unsupported numbers trigger review even when generation claims support; rejection does not regenerate', async () => {
  let generated = 0, reviewed = 0, backup = 0
  const service = createRecruiterService({ config,
    groq: metered(body => {
      if (body.messages[0].content.startsWith('Review an untrusted draft')) { reviewed++; return stream(JSON.stringify({ valid: false, reason: 'The experience metric is unsupported.' })) }
      generated++
      return stream(JSON.stringify({ factIds: ['f0'], answer: 'He has 999 years of experience.', grounding: 'supported' }))
    }),
    fallback: metered(() => { backup++; return generalReply() }),
  })
  await assert.rejects(service.respond(request('Describe how his background could help a product team.')), { code: 'AI_UNAVAILABLE' })
  assert.deepEqual([generated, reviewed, backup], [1, 1, 0])
  assert.equal(service.statistics().cacheEntries, 0)
})

test('risk: review transport fallback receives the same draft without a second generation', async () => {
  let generated = 0, primaryReviews = 0, backupReviews = 0, originalDraft
  const service = createRecruiterService({ config,
    groq: metered(body => {
      if (body.messages[0].content.startsWith('Review an untrusted draft')) {
        primaryReviews++; originalDraft = body.messages.at(-1).content
        throw Object.assign(new Error('Unavailable'), { status: 503 })
      }
      generated++
      return stream(JSON.stringify({ factIds: [], answer: 'The available information does not establish this.', grounding: 'uncertain' }))
    }),
    fallback: metered(body => {
      backupReviews++
      assert.equal(body.messages.at(-1).content, originalDraft)
      return stream(JSON.stringify({ valid: true, reason: '', answer: JSON.parse(body.messages.at(-1).content).draft, factIds: JSON.parse(body.messages.at(-1).content).factIds }))
    }),
  })
  await service.respond(request('How does his background compare with a research position?'))
  assert.deepEqual([generated, primaryReviews, backupReviews], [1, 1, 1])
})

test('risk: entity boundaries and absent evidence are reviewed without question keywords', async () => {
  const { recruiterReviewReasons } = await import('../recruiter.js')
  const facts = await currentPublicFacts()
  const evidence = facts.filter(f => f.category === 'experience')
  const a = evidence[0], b = evidence.find(f => f.moduleId !== a.moduleId)
  const reasons = recruiterReviewReasons({ text: 'A conditional assessment.', knowledgeIds: [a.id, b.id], grounding: 'supported' }, facts)
  assert.ok(reasons.includes('cross_entity_synthesis'))
  assert.ok(recruiterReviewReasons({ text: 'Missing.', knowledgeIds: [], grounding: 'missing' }, evidence).includes('possibly_omitted_evidence'))
  assert.deepEqual(recruiterReviewReasons({ text: 'Missing.', knowledgeIds: [], grounding: 'missing' }, facts.filter(f => f.category === 'profile')), [])
})

test('risk: corrections and citation repairs are validated within the review call', async () => {
  let generated = 0, reviewed = 0
  const service = createRecruiterService({ config, groq: metered(body => {
    if (body.messages[0].content.startsWith('Review an untrusted draft')) {
      reviewed++
      const facts = JSON.parse(body.messages[0].content.split('APPROVED_FACTS:\n')[1])
      const fact = facts.find(f => f.kind === 'contribution')
      return stream(JSON.stringify({ valid: true, reason: 'Replaced unsupported claim with documented work.', answer: fact.value, factIds: [fact.id] }))
    }
    generated++
    return stream(JSON.stringify({ factIds: [], answer: 'He has 999 years of experience.', grounding: 'uncertain' }))
  }) })
  const answer = await service.respond(request('How might his experience help on an engineering team?'))
  assert.doesNotMatch(answer.text, /999/)
  assert.ok(answer.knowledgeIds.length)
  assert.deepEqual([generated, reviewed], [1, 1])
  const invalid = createRecruiterService({ config, groq: metered(body => body.messages[0].content.startsWith('Review an untrusted draft')
    ? stream(JSON.stringify({ valid: true, reason: '', answer: 'Invented.', factIds: ['f999'] }))
    : stream(JSON.stringify({ factIds: [], answer: 'Uncertain.', grounding: 'uncertain' }))) })
  await assert.rejects(invalid.respond(request('How does his background relate to engineering?')), { code: 'AI_UNAVAILABLE' })
})

test('risk: review cannot expose internal citations in visible prose', async () => {
  const service = createRecruiterService({ config, groq: metered(body => body.messages[0].content.startsWith('Review an untrusted draft')
    ? stream(JSON.stringify({ valid: true, reason: '', answer: 'A claim f0.', factIds: ['f0'] }))
    : stream(JSON.stringify({ factIds: ['f0'], answer: 'A claim (f0).', grounding: 'supported' }))) })
  await assert.rejects(service.respond(request('How could his background help a product team?')), { code: 'INVALID_AI_RESPONSE' })
  assert.equal(service.statistics().providerCalls, 2)
})

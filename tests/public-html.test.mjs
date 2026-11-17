import assert from 'node:assert/strict'
import test from 'node:test'
import portfolio from '../src/portfolio.js'
import { renderPublicPortfolio } from '../scripts/public-html.mjs'

test('public rendering escapes text and attributes and rejects executable links', () => {
  const data = structuredClone(portfolio)
  data.greeting.name = '<script>alert("name")</script>'
  data.greeting.resumeLink = 'https://example.com/" onclick="alert(1)'
  data.socialMediaLinks.github = 'javascript:alert(1)'
  data.works[0].links = [{ url: 'data:text/html,<script>alert(1)</script>', label: 'Unsafe link' }]
  const html = renderPublicPortfolio(data)
  assert.ok(html.includes('&lt;script&gt;alert(&quot;name&quot;)&lt;/script&gt;'))
  assert.ok(html.includes('href="https://example.com/&quot; onclick=&quot;alert(1)"'))
  assert.doesNotMatch(html, /<script|javascript:|data:text\/html|Unsafe link/)
})

test('unknown fields and chatbot data are never serialized into public HTML', () => {
  const data = structuredClone(portfolio)
  const secret = 'SYNTHETIC_PRIVATE_VALUE_MUST_NOT_RENDER'
  data.privateKnowledge = { secret }
  data.chat = { messages: [secret] }
  data.greeting.privateNotes = secret
  data.about.reviewNotes = secret
  data.education.privateNotes = secret
  data.experiences[0].internalNotes = secret
  data.works[0].privateNotes = secret
  assert.ok(!renderPublicPortfolio(data).includes(secret))
})

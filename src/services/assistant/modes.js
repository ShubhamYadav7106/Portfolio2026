export const DEFAULT_MODE = 'recruiter'

export const MODES = Object.freeze({
  recruiter: {
    id: 'recruiter', label: 'Recruiter Mode',
    eyebrow: 'About Shubham',
    heading: ['The work,', 'and the person behind it'],
    description: 'Explore Shubham’s skills, projects and experience. Ask a question or start here.',
    review: 'Answers use verified, public facts within their review period.',
    placeholder: 'Ask about Shubham…',
    suggestions: [
      { label: 'What does Shubham work with?', detail: 'Skills & technologies', question: 'What are Shubham’s main technical skills?' },
      { label: 'Tell me about his experience', detail: 'Roles & contributions', question: 'What experience does Shubham have?' },
      { label: 'Which projects should I explore?', detail: 'A closer look at the work', question: 'What projects has Shubham worked on?' },
      { label: 'How can I get in touch?', detail: 'Contact & résumé', question: 'How can I contact Shubham and view his résumé?' },
    ],
    followups: [{ label: 'Explore projects', question: 'What projects has Shubham worked on?' }, { label: 'Get in touch ↗', question: 'How can I contact Shubham?' }],
  },
  general: {
    id: 'general', label: 'General AI Mode',
    eyebrow: 'Programming & general questions',
    heading: ['Think it through,', 'one question at a time'],
    description: 'Ask programming or general questions. Explore clear explanations and code examples.',
    review: 'AI responses can be mistaken. Code examples aren’t executed here.',
    placeholder: 'Ask a programming question…',
    suggestions: [
      { label: 'How does Vue reactivity work?', detail: 'ref, reactive & state', question: 'Explain ref and reactive in Vue.' },
      { label: 'Make async JavaScript clearer', detail: 'Promises & async/await', question: 'How does async and await work?' },
      { label: 'Explain the JavaScript event loop', detail: 'Tasks & microtasks', question: 'Explain the JavaScript event loop.' },
      { label: 'Help me debug a problem', detail: 'A practical starting point', question: 'How should I debug a JavaScript error?' },
    ],
    followups: [{ label: 'Show an example', question: 'Show an example.' }, { label: 'Explain it simply', question: 'Explain that more simply.' }],
  },
})

export const isMode = mode => Object.hasOwn(MODES, mode)
export function parseModeCommand(text) {
  const match = /^\/mode\s+(recruiter|general)\s*$/i.exec(text.trim())
  return match ? match[1].toLowerCase() : null
}

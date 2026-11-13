// Recognize complete code fences only. Both text and code are rendered through
// Vue interpolation; this parser never creates HTML or executes snippets.
export function splitMessageContent(text) {
  const blocks = []
  const pattern = /```([\w+-]*)\n([\s\S]*?)```/g
  let cursor = 0
  for (const match of text.matchAll(pattern)) {
    if (match.index > cursor) blocks.push({ type: 'text', text: text.slice(cursor, match.index) })
    blocks.push({ type: 'code', language: match[1], text: match[2].replace(/\n$/, '') })
    cursor = match.index + match[0].length
  }
  if (cursor < text.length) blocks.push({ type: 'text', text: text.slice(cursor) })
  return blocks
}

// Markdown is parsed into data and rendered as Vue nodes, never as HTML.
// Keeping a small allowlist means raw/model-generated HTML stays literal text.
export function safeMessageLink(value) {
  try {
    if (/^mailto:[\w.+-]+@[\w.-]+\.[a-z]{2,}$/i.test(value)) return value
    const url = new URL(value)
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null
  } catch { return null }
}

export function inlineMessageMarkdown(text, depth = 0) {
  if (depth > 3) return [{ type: 'text', text }]
  const tokens = []
  const pattern = /`([^`\n]+)`|\*\*([^\n]+?)\*\*|__([^\n]+?)__|\[([^\]\n]+)\]\(([^\s)]+)\)|https?:\/\/[^\s<>]+/g
  let cursor = 0
  for (const match of text.matchAll(pattern)) {
    if (match.index > cursor) tokens.push({ type: 'text', text: text.slice(cursor, match.index) })
    if (match[1]) tokens.push({ type: 'inline-code', text: match[1] })
    else if (match[2] || match[3]) tokens.push({ type: 'strong', children: inlineMessageMarkdown(match[2] || match[3], depth + 1) })
    else {
      let target = match[5] || match[0]
      let suffix = ''
      if (!match[5]) {
        target = target.replace(/[.,;!?]+$/, '')
        while (target.endsWith(')') && (target.match(/\)/g) || []).length > (target.match(/\(/g) || []).length) target = target.slice(0, -1)
        suffix = match[0].slice(target.length)
      }
      const href = safeMessageLink(target)
      tokens.push(href ? { type: 'link', href, children: [{ type: 'text', text: match[4] || target }] } : { type: 'text', text: match[0] })
      if (suffix) tokens.push({ type: 'text', text: suffix })
    }
    cursor = match.index + match[0].length
  }
  if (cursor < text.length) tokens.push({ type: 'text', text: text.slice(cursor) })
  return tokens
}

export function recruiterMarkdown(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const blocks = []
  const category = /^(Languages|Programming languages|Frontend(?: & styling)?|Backend(?: & APIs)?|Databases(?: & data services)?|Development tools(?: & platforms)?|Testing(?: & debugging)?|AI tools(?: & practices)?|Other skills):\s*(.*)$/i
  const categoryLine = line => line.trim().replace(/^\*\*([^*]+):\*\*\s*/, '$1: ').replace(/^\*\*([^*]+)\*\*:\s*/, '$1: ')
  const categorized = lines.filter(line => category.test(categoryLine(line))).length > 1
  for (let index = 0; index < lines.length;) {
    const line = lines[index]
    if (!line.trim()) { index++; continue }
    const fence = /^\s*```([\w+#.-]*)\s*$/.exec(line)
    if (fence) {
      const code = []
      index++
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) code.push(lines[index++])
      if (index < lines.length) index++
      blocks.push({ type: 'code', language: fence[1], text: code.join('\n') })
      continue
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.+?)(?:\s+#+)?$/.exec(line)
    if (heading) { blocks.push({ type: 'heading', level: Math.min(6, heading[1].length + 2), tokens: inlineMessageMarkdown(heading[2]) }); index++; continue }
    const skills = categorized && category.exec(categoryLine(line))
    if (skills) {
      blocks.push({ type: 'heading', level: 4, tokens: inlineMessageMarkdown(skills[1]) })
      if (skills[2].trim()) blocks.push({ type: 'list', ordered: false, skills: true, items: skills[2].replace(/\.$/, '').split(/,\s*|\s+and\s+/).filter(Boolean).map(item => inlineMessageMarkdown(item)) })
      index++; continue
    }
    const listItem = /^\s*(?:([-+*])\s+|(\d+)[.)]\s+)(.+)$/.exec(line)
    if (listItem) {
      const ordered = Boolean(listItem[2])
      const items = []
      const start = ordered ? Number(listItem[2]) : undefined
      while (index < lines.length) {
        const item = /^\s*(?:([-+*])\s+|(\d+)[.)]\s+)(.+)$/.exec(lines[index])
        if (!item || Boolean(item[2]) !== ordered) break
        items.push(inlineMessageMarkdown(item[3])); index++
      }
      blocks.push({ type: 'list', ordered, start, items }); continue
    }
    const paragraph = [line]
    index++
    while (index < lines.length && lines[index].trim() && !/^\s*(?:```|#{1,6}\s|[-+*]\s|\d+[.)]\s)/.test(lines[index]) && !(categorized && category.test(categoryLine(lines[index])))) paragraph.push(lines[index++])
    blocks.push({ type: 'paragraph', tokens: inlineMessageMarkdown(paragraph.join('\n')) })
  }
  return blocks
}

export function highlightMessageCode(text, language = '') {
  if (!/^(?:js|javascript|jsx|ts|typescript|tsx|json|py|python|sql|bash|sh|css|html|xml)$/i.test(language)) return [{ type: 'plain', text }]
  const pattern = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|\b(const|let|var|function|return|async|await|if|else|for|while|class|new|import|from|export|default|throw|try|catch|def|elif|in|not|and|or|None|True|False|true|false|null|SELECT|FROM|WHERE|INSERT|INTO|UPDATE|CREATE|TABLE)\b|\b\d+(?:\.\d+)?\b/g
  const tokens = []
  let cursor = 0
  for (const match of text.matchAll(pattern)) {
    if (match.index > cursor) tokens.push({ type: 'plain', text: text.slice(cursor, match.index) })
    tokens.push({ type: match[1] ? 'string' : match[2] ? 'comment' : match[3] ? 'keyword' : 'number', text: match[0] })
    cursor = match.index + match[0].length
  }
  if (cursor < text.length) tokens.push({ type: 'plain', text: text.slice(cursor) })
  return tokens
}

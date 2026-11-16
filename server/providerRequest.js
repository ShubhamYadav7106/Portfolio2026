export function canonicalTimeZone(value) {
  if (typeof value !== 'string' || !value || value.length > 100) return null
  try { return new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions().timeZone } catch { return null }
}

const zoneText = value => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
const supportedZones = (Intl.supportedValuesOf?.('timeZone') || []).map(zone => ({ zone, city: ` ${zoneText(zone.split('/').at(-1))} ` }))

function requestedZones(input) {
  const zones = new Set(['UTC'])
  if (input.timeZone) zones.add(input.timeZone)
  // Resolve city names from the runtime's timezone catalogue, not a location map.
  const addCities = value => {
    const text = ` ${zoneText(value)} `
    for (const { zone, city } of supportedZones) {
      if (zones.size >= 8) break
      if (text.includes(city)) zones.add(canonicalTimeZone(zone))
    }
  }
  addCities(input.message || '')
  // Explicit IANA identifiers and runtime-supported long aliases are also valid.
  // Short abbreviations are ambiguous and must not silently select a region.
  const tokens = String(input.message || '').match(/[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*/g) || []
  for (const token of new Set(tokens)) {
    if (zones.size >= 8) break
    if (token.length <= 3) continue
    const zone = canonicalTimeZone(token)
    if (zone) zones.add(zone)
  }
  for (const offset of String(input.message || '').match(/(?:UTC|GMT)?[+-]\d{2}:\d{2}/gi) || []) {
    if (zones.size >= 8) break
    const zone = canonicalTimeZone(offset.replace(/^(?:UTC|GMT)/i, ''))
    if (zone) zones.add(zone)
  }
  for (const previous of [...(input.history || [])].reverse()) {
    if (zones.size >= 8) break
    if (previous.role === 'user') addCities(previous.content ?? previous.text ?? '')
  }
  return [...zones].filter(Boolean)
}

function clockMessage(input) {
  const instant = new Date()
  const requested = requestedZones(input)
  const convert = date => requested.map(timeZone => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset',
    }).formatToParts(date).filter(part => part.type !== 'literal').map(part => [part.type, part.value]))
    const name = new Intl.DateTimeFormat('en', { timeZone, timeZoneName: 'longGeneric' }).formatToParts(date).find(part => part.type === 'timeZoneName')?.value
    return { timeZone, name, date: `${parts.year}-${parts.month}-${parts.day}`, weekday: parts.weekday, time: `${parts.hour}:${parts.minute}:${parts.second}`, utcOffset: parts.timeZoneName }
  })
  const supplied = [...new Set(String(input.message || '').match(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})\b/gi) || [])]
    .filter(value => {
      const calendar = new Date(value.slice(0, 10) + 'T00:00:00Z')
      return Number.isFinite(Date.parse(value)) && Number.isFinite(calendar.getTime()) && calendar.toISOString().slice(0, 10) === value.slice(0, 10)
    }).slice(0, 3)
  const conversions = supplied.map(value => ({ supplied: value, zones: convert(new Date(value)) }))
  return { role: 'system', content: 'Fresh server clock, authoritative for the current instant and overriding historical assistant dates/times. Use these server-converted values for current date/time questions, label the timezone, and treat them as accurate as of this request, not a continuously running clock. The browser timezone is a display preference, not proof of the visitor\'s location. If absent, report UTC explicitly rather than inventing a local timezone. Do not infer the visitor\'s timezone from portfolio facts. Ask for an IANA timezone/city when a requested location or abbreviation is ambiguous or has no supplied conversion; never guess an offset or current time. Current offsets apply only to this instant; for supplied ISO instants use their separate server conversions, which include date-specific daylight-saving rules. Do not reuse current offsets for other dates or guess missing conversion inputs. Personal dates remain grounded in approved knowledge.\nSERVER_CLOCK: ' + JSON.stringify({ utc: instant.toISOString(), browserTimeZone: input.timeZone || null, zones: convert(instant), ...(conversions.length ? { conversions } : {}) }) }
}

// Temporal conversation must not reuse an older generated clock answer. This
// affects cache freshness only, never routing, FAQ answers or generated wording.
export function needsFreshClock(input) {
  const text = [input.message, ...(input.history || []).map(item => item.content ?? item.text ?? '')].join(' ')
  const normalized = ` ${zoneText(text)} `
  return /\b(?:date|time(?:zone)?|today|tonight|tomorrow|yesterday|now|current(?:ly)?|weekday|days?|months?|years?|calendar|clock|hours?|minutes?|seconds?|utc|gmt|dst|aaj|abhi|kal|din|samay|tarikh)\b|समय|तारीख|आज|अभी|कल|दिन|[+-]\d{2}:\d{2}/iu.test(text)
    || supportedZones.some(({ city }) => normalized.includes(city))
}

// Both modes and both Recruiter accounts share the same request-time clock.
export function providerRequest({ model, messages, maxTokens, json = false, input = {} }) {
  return {
    model, messages: [messages[0], clockMessage(input), ...messages.slice(1)], stream: true,
    max_completion_tokens: maxTokens,
    ...(json ? { temperature: 0, response_format: { type: 'json_object' } } : {}),
    ...(model.startsWith('openai/gpt-oss-') ? { include_reasoning: false, reasoning_effort: 'low' } : {}),
  }
}

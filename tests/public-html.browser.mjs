// Public fallback and startup checks using installed Chrome and its CDP.
// Run `npm run build` first. CHROME_PATH can select another Chrome installation.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { preview } from 'vite'
import { once } from 'node:events'
import portfolio from '../src/portfolio.js'

const chromePath = process.env.CHROME_PATH || (process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  : '/usr/bin/google-chrome')
assert.ok(existsSync(chromePath), 'Install Chrome or set CHROME_PATH to run browser checks.')
const profile = await mkdtemp(join(tmpdir(), 'ask-shubham-chrome-'))
const artifacts = await mkdtemp(join(tmpdir(), 'ask-shubham-preview-'))
let browser
let site
let socket
let commandId = 0
const pending = new Map()
const exceptions = []
const requests = []
let checks = 0

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(read, description, timeout = 10000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await read()
    if (value) return value
    await pause(50)
  }
  throw new Error(`Timed out: ${description}`)
}

function cdp(method, params = {}) {
  const id = ++commandId
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timed out: ${method}`)) }, 10000)
    pending.set(id, { resolve, reject, timeout })
    socket.send(JSON.stringify({ id, method, params }))
  })
}

async function evaluate(expression) {
  const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
  return result.result.value
}

async function click(selector) {
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
  await pause(60)
}

async function key(key, modifiers = 0) {
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key, modifiers })
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key, modifiers })
  await pause(60)
}

async function screenshot(name) {
  await pause(300)
  const { data } = await cdp('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(artifacts, name), Buffer.from(data, 'base64'))
}

function passed(description) {
  checks++
  console.log(`✓ ${description}`)
}

const fixtureRequests = []
async function interceptChat({ requestId, request }) {
  const headers = [
    { name: 'Content-Type', value: 'application/x-ndjson' },
    { name: 'Access-Control-Allow-Origin', value: '*' },
    { name: 'Access-Control-Allow-Methods', value: 'POST, OPTIONS' },
    { name: 'Access-Control-Allow-Headers', value: 'Content-Type, Accept' },
  ]
  if (request.method === 'OPTIONS') {
    await cdp('Fetch.fulfillRequest', { requestId, responseCode: 204, responseHeaders: headers })
    return
  }
  const input = JSON.parse(request.postData)
  fixtureRequests.push(input)
  const text = `Synthetic ${input.mode} browser check response.`
  const frames = [
    { type: 'start', provider: 'groq', mode: input.mode },
    { type: 'delta', text },
    { type: 'done', provider: 'groq', mode: input.mode, verification: input.mode === 'general' ? 'not_applicable' : 'not_available' },
  ]
  await cdp('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: headers, body: Buffer.from(frames.map(frame => JSON.stringify(frame)).join('\n') + '\n').toString('base64') })
}

try {
  console.log('Chat responses are synthetic CDP fixtures; no Worker or private knowledge is accessed.')
  site = await preview({ preview: { host: '127.0.0.1', port: 0, open: false }, logLevel: 'error' })
  const port = site.httpServer.address().port
  browser = spawn(chromePath, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-extensions', '--disable-sync', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' })
  let launchError
  browser.on('error', error => { launchError = error })
  const debugPort = await until(async () => {
    if (launchError) throw launchError
    if (browser.exitCode !== null) throw new Error(`Chrome exited with code ${browser.exitCode}`)
    try { return (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0] } catch { return null }
  }, 'Chrome launch', 15000)
  const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()
  socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data)
    if (message.id && pending.has(message.id)) {
      const request = pending.get(message.id)
      clearTimeout(request.timeout)
      pending.delete(message.id)
      if (message.error) request.reject(new Error(message.error.message))
      else request.resolve(message.result)
    }
    if (message.method === 'Fetch.requestPaused') void interceptChat(message.params).catch(error => exceptions.push({ text: error.message }))
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails)
    if (message.method === 'Network.requestWillBeSent') requests.push(message.params.request.url)
  })
  await cdp('Page.enable')
  await cdp('Runtime.enable')
  await cdp('Network.enable')
  await cdp('Fetch.enable', { patterns: [{ urlPattern: 'https://*.workers.dev/api/chat*', requestStage: 'Request' }] })
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })

  const publicText = [
    portfolio.greeting.name, portfolio.greeting.message, portfolio.education.field,
    ...portfolio.about.autobiography, ...portfolio.about.techStack,
    ...portfolio.experiences.flatMap(item => [item.position, item.company.name, item.duration, ...item.content.flatMap(section => section.bulletPoints)]),
    ...portfolio.works.flatMap(item => [item.projectName, item.description, item.techStack]),
  ]
  const rawHtml = await (await fetch(`http://127.0.0.1:${port}`)).text()
  assert.equal(await (await fetch(`http://127.0.0.1:${port}`, { headers: { 'User-Agent': 'OAI-SearchBot' } })).text(), rawHtml)
  passed('Users and crawlers receive identical production HTML')

  await cdp('Emulation.setScriptExecutionDisabled', { value: true })
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}` })
  await until(() => evaluate('document.readyState === "complete"'), 'HTML without JavaScript')
  const fallbackText = await evaluate('document.getElementById("portfolio-fallback").innerText')
  for (const text of publicText) assert.ok(fallbackText.includes(text), `Missing public text: ${text}`)
  assert.equal(await evaluate('document.querySelectorAll("#work-section article").length'), 4)
  assert.equal(await evaluate('getComputedStyle(document.getElementById("portfolio-fallback")).display'), 'block')
  const fallbackLinks = await evaluate('[...document.querySelectorAll("#portfolio-fallback a")].map(link => link.getAttribute("href"))')
  for (const url of [portfolio.greeting.resumeLink, portfolio.archiveLink, ...Object.values(portfolio.socialMediaLinks).filter(Boolean), ...portfolio.experiences.map(item => item.company.link), ...portfolio.works.flatMap(item => (item.links ?? []).map(link => link.url).filter(Boolean)), `mailto:${portfolio.contact.externalLink.link.email}`]) {
    assert.ok(fallbackLinks.includes(url), `Missing public link: ${url}`)
  }
  await screenshot('portfolio-without-javascript.png')
  passed('JavaScript-disabled HTML visibly includes public biography, education, skills, experience, all four projects and professional links')

  await cdp('Emulation.setScriptExecutionDisabled', { value: false })
  await cdp('Network.setBlockedURLs', { urls: ['*.js'] })
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}` })
  await until(() => evaluate('document.readyState === "complete"'), 'HTML before Vue startup')
  assert.equal(await evaluate('document.documentElement.classList.contains("portfolio-js")'), true)
  assert.equal(await evaluate('getComputedStyle(document.getElementById("portfolio-fallback")).display'), 'none')
  assert.equal(await evaluate('document.getElementById("app").hasAttribute("data-v-app")'), false)
  passed('Fallback is hidden before Vue loads, preventing startup flashing even with blocked JavaScript modules')
  await cdp('Network.setBlockedURLs', { urls: [] })
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}` })
  await until(() => evaluate('document.getElementById("app").hasAttribute("data-v-app")'), 'app mount')
  assert.equal(await evaluate('document.getElementById("portfolio-fallback")'), null)
  assert.equal(await evaluate('Boolean(document.querySelector(".chat-launcher"))'), false)
  await until(() => evaluate('Boolean(document.querySelector(".chat-launcher"))'), 'launcher after splash')
  passed('Launcher waits for the existing splash screen')

  await evaluate('Promise.all([...document.querySelectorAll("#app img")].map(image => { image.loading = "eager"; return image.decode().catch(() => null) }))')
  assert.deepEqual(await evaluate('[...document.querySelectorAll("#app img")].filter(image => !image.complete || !image.naturalWidth).map(image => image.getAttribute("src"))'), [])
  passed('Portfolio portrait, about photos and project images load in the production build')

  await click('#navbar-default a[href="/#work-section"]')
  await until(() => evaluate('location.hash === "#work-section"'), 'work hash navigation')
  assert.equal(await evaluate('document.querySelectorAll("#work-section h3").length'), 3)
  await click('#work-section > div > button')
  assert.equal(await evaluate('document.querySelectorAll("#work-section h3").length'), 4)
  await click('#work-section > div > button')
  assert.equal(await evaluate('document.querySelectorAll("#work-section h3").length'), 3)
  await evaluate('window.scrollTo(0, 0)')
  passed('Existing hash navigation and Show More/Show Less behavior are preserved')

  await click('.chat-launcher')
  await until(() => evaluate('document.activeElement?.id === "ask-shubham-input"'), 'chat focus')
  await cdp('Input.insertText', { text: 'Synthetic recruiter browser check' })
  await key('Enter')
  await until(() => evaluate('document.querySelector(".chat-message--assistant")?.textContent.includes("Synthetic recruiter")'), 'recruiter response')
  await click('input[name="assistant-mode"][value="general"]')
  assert.equal(await evaluate('document.querySelectorAll(".chat-message").length'), 0)
  await evaluate('document.getElementById("ask-shubham-input").focus()')
  await cdp('Input.insertText', { text: 'Synthetic general browser check' })
  await key('Enter')
  await until(() => evaluate('document.querySelector(".chat-message--assistant")?.textContent.includes("Synthetic general")'), 'general response')
  await click('input[name="assistant-mode"][value="recruiter"]')
  assert.equal(await evaluate('document.querySelectorAll(".chat-message").length'), 2)
  assert.deepEqual(fixtureRequests.map(input => input.mode), ['recruiter', 'general'])
  passed('Chatbot opens, sends and renders responses in both modes, with isolated histories and synthetic transport fixtures')

  await key('Escape')
  await click('.theme-toggle')
  await until(() => evaluate('document.documentElement.classList.contains("dark")'), 'theme toggle')
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  await click('.chat-launcher')
  await until(() => evaluate('document.querySelector(".chat-panel")?.getAttribute("aria-modal") === "true"'), 'mobile chat')
  assert.equal(await evaluate('document.getElementById("app").inert'), true)
  await key('Escape')
  assert.equal(await evaluate('document.getElementById("app").inert'), false)
  assert.equal(await evaluate('document.body.style.overflow'), '')
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  await click('.chat-launcher')
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".chat-panel")).transitionDuration'), '0s')
  assert.equal(exceptions.length, 0, JSON.stringify(exceptions))
  passed('Theme switching, mobile modal cleanup and reduced-motion behavior remain functional without runtime exceptions')
  console.log(`\n${checks} browser checks passed. Screenshots: ${artifacts}`)
} finally {
  socket?.close()
  for (const request of pending.values()) clearTimeout(request.timeout)
  if (browser && browser.exitCode === null) {
    const stopped = new Promise(resolve => browser.once('exit', resolve))
    browser.kill('SIGTERM')
    await Promise.race([stopped, pause(3000)])
    if (browser.exitCode === null) browser.kill('SIGKILL')
  }
  if (site) await new Promise(resolve => site.httpServer.close(resolve))
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

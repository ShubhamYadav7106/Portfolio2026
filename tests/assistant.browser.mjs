// Local, dependency-free interaction checks using installed Chrome and its CDP.
// Run `npm run build` first. CHROME_PATH can select another Chrome installation.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { preview } from 'vite'
import { once } from 'node:events'
import { createApp } from '../server/app.js'
import { readConfig } from '../server/config.js'
import { browserFixtureGroq } from '../server/test/browser-fixture.js'

const chromePath = process.env.CHROME_PATH || (process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  : '/usr/bin/google-chrome')
assert.ok(existsSync(chromePath), 'Install Chrome or set CHROME_PATH to run browser checks.')
const profile = await mkdtemp(join(tmpdir(), 'ask-shubham-chrome-'))
const artifacts = await mkdtemp(join(tmpdir(), 'ask-shubham-preview-'))
let browser
let site
let apiServer
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

try {
  console.log('Browser tests use a labeled test-only Groq transport. No external AI requests are made.')
  // The production frontend is served from a local test origin chosen below.
  const testConfig = readConfig({ GROQ_API_KEY: 'test-only-placeholder' })
  testConfig.origins = []
  testConfig.rateLimitMax = 200
  const app = createApp({ config: testConfig, groq: browserFixtureGroq })
  apiServer = app.listen(0, '127.0.0.1')
  await once(apiServer, 'listening')
  const apiTarget = `http://127.0.0.1:${apiServer.address().port}`
  site = await preview({ preview: { host: '127.0.0.1', port: 0, open: false, proxy: { '/api': { target: apiTarget, changeOrigin: true } } }, logLevel: 'error' })
  const port = site.httpServer.address().port
  testConfig.origins.push(`http://127.0.0.1:${port}`)
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
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails)
    if (message.method === 'Network.requestWillBeSent') requests.push(message.params.request.url)
  })
  await cdp('Page.enable')
  await cdp('Runtime.enable')
  await cdp('Network.enable')
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}` })
  await until(() => evaluate('Boolean(document.querySelector("#app section"))'), 'app mount')
  assert.equal(await evaluate('Boolean(document.querySelector(".chat-launcher"))'), false)
  await until(() => evaluate('Boolean(document.querySelector(".chat-launcher"))'), 'launcher after splash')
  passed('Launcher waits for the existing splash screen')

  await evaluate('Promise.all([...document.querySelectorAll("#app img")].map(image => { image.loading = "eager"; return image.decode().catch(() => null) }))')
  assert.deepEqual(await evaluate('[...document.querySelectorAll("#app img")].filter(image => !image.complete || !image.naturalWidth).map(image => image.getAttribute("src"))'), [])
  passed('Portfolio portrait, about photos and project images load in the production build')

  await click('.chat-launcher')
  await until(() => evaluate('document.activeElement?.id === "ask-shubham-input"'), 'desktop input focus')
  assert.equal(await evaluate('document.querySelectorAll(".suggestion").length'), 4)
  assert.equal(await evaluate('document.querySelector(".chat-panel").getAttribute("aria-modal")'), null)
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".chat-panel")).backgroundColor'), 'rgb(250, 249, 246)')
  assert.equal(await evaluate('document.getElementById("app").inert'), false)
  assert.equal(await evaluate('document.querySelector(".send-button").disabled'), true)
  assert.equal(await evaluate('document.querySelector("input[name=assistant-mode]:checked").value'), 'recruiter')
  assert.equal(await evaluate('document.querySelector(".chat-transcript").scrollTop'), 0)
  await screenshot('desktop-light.png')
  assert.equal(await evaluate('document.querySelector(".preview-bar")'), null)
  passed('Desktop opens with four recruiter suggestions, input focus, and a nonmodal light panel')

  await click('.suggestion')
  await until(() => evaluate('Boolean(document.querySelector(".chat-message--assistant")) && !document.querySelector(".loading-response")'), 'streamed answer')
  assert.match(await evaluate('document.querySelector(".chat-message--assistant").textContent'), /JavaScript.*TypeScript/s)
  assert.doesNotMatch(await evaluate('document.querySelector(".chat-message--assistant").textContent'), /GraphQL|Neuro TEN|undefined [1-9]/)
  assert.equal(await evaluate('document.querySelectorAll(".source-link, .review-note").length'), 0)
  assert.doesNotMatch(await evaluate('document.querySelector(".chat-message--assistant").textContent'), /Source:|Verified|Pending|from draft|factIds|approvalReference/)
  passed('Recruiter Mode gives conversational approved facts without internal labels or pending claims')

  await key('Escape')
  assert.equal(await evaluate('document.activeElement?.classList.contains("chat-launcher")'), true)
  await click('.chat-launcher')
  assert.equal(await evaluate('document.querySelectorAll(".chat-message").length'), 2)
  await click('[aria-label="Clear chat"]')
  assert.equal(await evaluate('document.querySelectorAll(".chat-message").length'), 0)
  await evaluate('document.getElementById("ask-shubham-input").focus()')
  await cdp('Input.insertText', { text: 'Explain why his skills suit frontend work.' })
  await key('Enter')
  await click('[aria-label="Stop response"]')
  assert.ok(await evaluate('Boolean(document.querySelector(".retry-button"))'))
  await click('.retry-button')
  await until(() => evaluate('Boolean(document.querySelector(".chat-message--assistant")) && !document.querySelector(".loading-response")'), 'retry answer')
  assert.equal(await evaluate('document.querySelectorAll(".chat-message--user").length'), 1)
  assert.match(await evaluate('document.querySelector(".chat-message--assistant").textContent'), /JavaScript.*TypeScript/s)
  assert.doesNotMatch(await evaluate('document.querySelector(".chat-message--assistant").textContent'), /500000/)
  passed('Escape restores focus; close preserves history; clear, send, stop, and retry work')

  await click('input[name="assistant-mode"][value="general"]')
  assert.equal(await evaluate('document.querySelectorAll(".chat-message").length'), 0)
  assert.equal(await evaluate('document.getElementById("ask-shubham-input").placeholder'), 'Ask a programming question…')
  await click('.suggestion')
  await until(() => evaluate('Boolean(document.querySelector(".chat-message--assistant")) && !document.querySelector(".loading-response")'), 'concise technical explanation')
  assert.match(await evaluate('document.querySelector(".chat-message--assistant").textContent'), /Use ref/)
  assert.equal(await evaluate('document.querySelectorAll(".chat-message--assistant code").length'), 0)
  await click('.followup-questions button:first-child')
  await until(() => evaluate('Boolean(document.querySelector(".chat-message--assistant code")) && !document.querySelector(".loading-response")'), 'requested technical code example')
  await screenshot('desktop-general.png')
  await click('.followup-questions button:nth-child(2)')
  await until(() => evaluate('document.querySelectorAll(".chat-message--assistant").length === 3 && !document.querySelector(".loading-response")'), 'contextual followup')
  assert.match(await evaluate('document.querySelectorAll(".chat-message--assistant")[2].textContent'), /labeled box/)
  await click('input[name="assistant-mode"][value="recruiter"]')
  assert.equal(await evaluate('document.querySelectorAll(".chat-message").length'), 2)
  assert.doesNotMatch(await evaluate('document.querySelector(".chat-transcript").textContent'), /labeled box/)
  await click('input[name="assistant-mode"][value="general"]')
  assert.equal(await evaluate('document.querySelectorAll(".chat-message").length'), 6)
  passed('Header selector switches isolated histories; General Mode renders code and contextual followups')

  await evaluate('document.getElementById("ask-shubham-input").focus()')
  await cdp('Input.insertText', { text: 'my technical draft' })
  await click('input[name="assistant-mode"][value="recruiter"]')
  assert.equal(await evaluate('document.getElementById("ask-shubham-input").value'), '')
  await click('input[name="assistant-mode"][value="general"]')
  assert.equal(await evaluate('document.getElementById("ask-shubham-input").value'), 'my technical draft')
  await click('[aria-label="Clear chat"]')
  assert.equal(await evaluate('document.querySelector("input[name=assistant-mode]:checked").value'), 'recruiter')
  await click('input[name="assistant-mode"][value="general"]')
  assert.equal(await evaluate('document.querySelectorAll(".chat-message").length'), 0)
  assert.equal(await evaluate('document.getElementById("ask-shubham-input").value'), '')
  await click('input[name="assistant-mode"][value="recruiter"]')
  await evaluate('document.getElementById("ask-shubham-input").focus()')
  await cdp('Input.insertText', { text: '/mode general' })
  await key('Enter')
  assert.equal(await evaluate('document.querySelector("input[name=assistant-mode]:checked").value'), 'general')
  assert.equal(await evaluate('document.querySelectorAll(".chat-message").length'), 0)
  passed('Drafts are isolated; clear resets both modes; slash commands also update the selector')

  await click('.suggestion')
  await click('input[name="assistant-mode"][value="recruiter"]')
  await pause(1000)
  assert.equal(await evaluate('document.querySelectorAll(".chat-message").length'), 0)
  await click('input[name="assistant-mode"][value="general"]')
  assert.equal(await evaluate('document.querySelectorAll(".chat-message--assistant").length'), 0)
  assert.ok(await evaluate('Boolean(document.querySelector(".retry-button"))'))
  passed('Switching during loading prevents a late reply from entering either conversation')

  await click('[aria-label="Clear chat"]')
  await evaluate('document.getElementById("ask-shubham-input").focus()')
  await cdp('Input.insertText', { text: '<img src=x onerror=alert(1)>' })
  await key('Enter')
  assert.equal(await evaluate('document.querySelectorAll(".chat-message--user img").length'), 0)
  await click('[aria-label="Clear chat"]')
  await pause(1000)
  assert.equal(await evaluate('document.querySelectorAll(".chat-message").length'), 0)
  passed('Markup stays text, and clearing during loading prevents a stale reply')

  await evaluate('document.documentElement.classList.add("dark")')
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".chat-panel")).backgroundColor'), 'rgb(24, 28, 28)')
  await screenshot('desktop-dark.png')
  passed('Dark mode applies to the teleported widget')

  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  await pause(150)
  assert.equal(await evaluate('document.querySelector(".chat-panel").getAttribute("aria-modal")'), 'true')
  assert.equal(await evaluate('document.getElementById("app").inert'), true)
  assert.equal(await evaluate('document.body.style.overflow'), 'hidden')
  assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true)
  await evaluate('document.querySelector(".chat-panel").focus()')
  await key('Tab', 8)
  assert.equal(await evaluate('document.activeElement.id'), 'ask-shubham-input')
  await key('Tab')
  assert.equal(await evaluate('document.activeElement.getAttribute("aria-label")'), 'Close chat')
  passed('Mobile sheet fits the viewport and locks the background')

  await screenshot('mobile-dark.png')
  await evaluate('document.documentElement.classList.remove("dark")')
  await screenshot('mobile-light.png')
  await evaluate('document.querySelector("input[name=assistant-mode][value=recruiter]").focus()')
  await key('ArrowRight')
  assert.equal(await evaluate('document.querySelector("input[name=assistant-mode]:checked").value'), 'general')
  await click('.suggestion')
  await until(() => evaluate('Boolean(document.querySelector(".chat-message--assistant")) && !document.querySelector(".loading-response")'), 'mobile concise technical answer')
  await click('.followup-questions button:first-child')
  await until(() => evaluate('Boolean(document.querySelector(".chat-message--assistant code"))'), 'mobile technical answer')
  await screenshot('mobile-general.png')
  assert.ok(await evaluate('document.querySelector(".mode-selector").getBoundingClientRect().right <= innerWidth'))
  await key('Escape')
  assert.equal(await evaluate('document.getElementById("app").inert'), false)
  assert.equal(await evaluate('document.body.style.overflow'), '')
  await click('#navbar button')
  await click('#navbar div.absolute a[href="/#work-section"]')
  await until(() => evaluate('location.hash === "#work-section"'), 'portfolio Work navigation')
  passed('Mobile selector supports keyboard arrows; closing releases locks and portfolio navigation works')

  await click('.chat-launcher')
  await cdp('Emulation.setDeviceMetricsOverride', { width: 320, height: 568, deviceScaleFactor: 1, mobile: true })
  await pause(150)
  assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true)
  assert.ok(await evaluate('document.querySelector(".chat-panel").getBoundingClientRect().width <= window.innerWidth'))
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 360, deviceScaleFactor: 1, mobile: true })
  await pause(150)
  assert.ok(await evaluate('document.querySelector(".composer").getBoundingClientRect().bottom <= window.innerHeight'))
  passed('Narrow phones and a reduced-height viewport keep the composer accessible')

  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".chat-panel")).transitionDuration'), '0s')
  await key('Escape')
  await click('.chat-launcher')
  await click('[aria-label="Clear chat"]')
  await click('input[name="assistant-mode"][value="general"]')
  await click('.suggestion')
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".loading-dots i")).animationName'), 'none')
  assert.ok(requests.some(url => /\/api\/chat/.test(url)))
  assert.equal(requests.filter(url => /api\.groq\.com|cloudflare|violet/i.test(url)).length, 0)
  assert.equal(exceptions.length, 0, JSON.stringify(exceptions))
  passed('Reduced motion is respected; chat uses the local API with no direct provider calls or runtime exceptions')

  await click('[aria-label="Clear chat"]')
  await evaluate('document.getElementById("ask-shubham-input").focus()')
  await cdp('Input.insertText', { text: 'uski shcooling batao' })
  await key('Enter')
  await until(() => evaluate('Boolean(document.querySelector(".chat-message--assistant")) && !document.querySelector(".loading-response")'), 'Hinglish typo answer')
  assert.match(await evaluate('document.querySelector(".chat-message--assistant").textContent'), /SVMIC.*79\.6.*87\.6/s)
  passed('Real chat transport answers a Hinglish question with a typo from approved facts')

  for (const [width, height, label] of [[360, 800, 'phone'], [768, 1024, 'tablet portrait'], [1024, 768, 'tablet landscape'], [1440, 1000, 'desktop']]) {
    await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 640 })
    for (const theme of ['light', 'dark']) {
      await evaluate(`document.documentElement.classList.toggle('dark', ${theme === 'dark'})`)
      await pause(100)
      assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true)
      assert.equal(await evaluate('document.querySelector(".chat-panel").getBoundingClientRect().right <= innerWidth'), true)
      assert.equal(await evaluate('document.querySelector(".composer").getBoundingClientRect().bottom <= innerHeight'), true)
      assert.equal(await evaluate('document.getElementById("app").inert'), width < 640)
      assert.equal(await evaluate('getComputedStyle(document.querySelector(".chat-panel")).backgroundColor'), theme === 'dark' ? 'rgb(24, 28, 28)' : 'rgb(250, 249, 246)')
      const contrast = await evaluate(`(() => {
        const style = getComputedStyle(document.querySelector('.ask-shubham'));
        const luminance = hex => { let value = hex.trim().replace('#', ''); if (value.length === 3) value = [...value].map(c => c + c).join(''); const rgb = [0,2,4].map(offset => parseInt(value.slice(offset, offset + 2), 16) / 255).map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4); return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2] };
        const color = name => style.getPropertyValue(name).trim();
        const ratio = (a,b) => { const first = luminance(a), second = luminance(b); return (Math.max(first,second) + 0.05) / (Math.min(first,second) + 0.05) };
        return [['text','--ask-text','--ask-bg'],['muted','--ask-muted','--ask-soft'],['link','--ask-link','--ask-bg'],['user','--ask-text','--ask-soft'],['send','#ffffff','--ask-accent']].map(([name,a,b]) => ({ name, ratio: ratio(a.startsWith('--') ? color(a) : a,color(b)) }));
      })()`)
      assert.ok(contrast.every(item => item.ratio >= 4.5), JSON.stringify({ theme, contrast }))
      for (const mode of ['general', 'recruiter']) {
        await click(`input[name="assistant-mode"][value="${mode}"]`)
        assert.ok(await evaluate('document.querySelector(".mode-selector").getBoundingClientRect().right <= innerWidth'))
      }
      await screenshot(`${label.replaceAll(' ', '-')}-${theme}-audit.png`)
    }
    passed(`${label} keeps both modes accessible in light and dark themes`)
  }
  const { nodes } = await cdp('Accessibility.getFullAXTree')
  const dialog = nodes.find(node => node.role?.value === 'dialog' && node.name?.value === 'Ask Shubham AI')
  assert.ok(dialog)
  const accessible = new Map(nodes.map(node => [node.nodeId, node]))
  const descendants = []
  function visit(id) { const node = accessible.get(id); if (!node) return; descendants.push(node); for (const child of node.childIds || []) visit(child) }
  visit(dialog.nodeId)
  assert.deepEqual(descendants.filter(node => !node.ignored && ['button', 'radio', 'textbox', 'link'].includes(node.role?.value) && !node.name?.value?.trim()).map(node => node.role.value), [])
  assert.ok(descendants.some(node => node.role?.value === 'textbox' && /Ask about Shubham/.test(node.name?.value)))
  assert.ok(descendants.some(node => node.role?.value === 'radio' && node.name?.value === 'Recruiter Mode'))
  assert.equal(exceptions.length, 0, JSON.stringify(exceptions))
  passed('Chrome accessibility tree exposes a named dialog, labeled input and named interactive controls')
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  await pause(100)
  await evaluate('document.querySelector(".chat-panel button:not([disabled])").focus()')
  await key('Tab', 8)
  assert.equal(await evaluate('document.activeElement.id'), 'ask-shubham-input')
  await key('Escape')
  assert.equal(await evaluate('document.getElementById("app").inert'), false)
  assert.equal(await evaluate('document.activeElement.classList.contains("chat-launcher")'), true)
  passed('Text colors meet 4.5:1 contrast checks; mobile reverse focus wrapping and close restoration work')
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
  if (apiServer) {
    const closed = new Promise(resolve => apiServer.close(resolve))
    apiServer.closeAllConnections()
    await closed
  }
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

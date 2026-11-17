import portfolio from '../src/portfolio.js'

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character])
const paragraph = text => `<p>${escapeHtml(text)}</p>`
const list = items => `<ul>${items.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
const link = (url, label) => /^(https?:\/\/|mailto:)/i.test(url ?? '')
  ? `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>` : ''

// Read only explicitly public presentation fields. Never serialize the full object
// or import server modules, environment values, or AI knowledge into this renderer.
export function renderPublicPortfolio(data) {
  const { greeting, about, education, experiences, works, socialMediaLinks, archiveLink, contact } = data
  const socialLabels = { github: 'GitHub', linkedin: 'LinkedIn', medium: 'Medium', stackoverflow: 'Stack Overflow', xtwitter: 'X' }
  const professionalLinks = Object.entries(socialLabels).map(([key, label]) => link(socialMediaLinks[key], label)).filter(Boolean)
  professionalLinks.push(link(greeting.resumeLink, 'Resume'), link(archiveLink, 'Project archive'))
  const contactDetails = contact.externalLink
  const email = contactDetails.link.email
  const contactLink = email ? link(`mailto:${email}`, email) : link(contactDetails.link.other, contactDetails.shortTitle)

  return `<main id="portfolio-fallback">
    <header id="landing-page"><h1>${escapeHtml(greeting.name)}</h1>${paragraph(greeting.message)}${paragraph(`Based in ${greeting.basedLocation}`)}</header>
    <nav aria-label="Portfolio sections"><a href="#about-section">About</a> <a href="#education-section">Education</a> <a href="#experience-section">Experience</a> <a href="#work-section">Work</a> <a href="#contact-section">Contact</a></nav>
    <section id="about-section"><h2>About Me</h2>${about.autobiography.map(paragraph).join('')}<h3>Skills</h3>${list(about.techStack)}</section>
    <section id="education-section"><h2>Education</h2>${paragraph(`Background in ${education.field}.`)}</section>
    <section id="experience-section"><h2>Experience</h2>${experiences.map(experience => `<article>
      <h3>${escapeHtml(experience.position)} at ${link(experience.company.link, experience.company.name) || escapeHtml(experience.company.name)}</h3>
      ${paragraph(experience.duration)}${experience.content.map(section => `${section.sectionHeader ? `<h4>${escapeHtml(Array.isArray(section.sectionHeader) ? section.sectionHeader.join(' ') : section.sectionHeader)}</h4>` : ''}${list(section.bulletPoints)}`).join('')}
      ${paragraph(experience.hashtags.join(', '))}</article>`).join('')}</section>
    <section id="work-section"><h2>Projects</h2>${works.map(project => `<article>
      <h3>${escapeHtml(project.projectName)}</h3>${paragraph(project.yearCompleted)}${paragraph(project.description)}${paragraph(project.techStack)}
      ${(project.links ?? []).map(item => link(item.url, item.label || (item.type === 'git' ? 'Source code' : 'Live project'))).filter(Boolean).join(' ')}
    </article>`).join('')}</section>
    <section id="contact-section"><h2>${escapeHtml(contactDetails.shortTitle)}</h2>${contactDetails.note.map(paragraph).join('')}${contactLink}${contactDetails.responseTimeMessage ? paragraph(contactDetails.responseTimeMessage) : ''}${contact.formEmbedLink ? link(contact.formEmbedLink, 'Contact form') : ''}</section>
    <footer><h2>Professional Links</h2><nav aria-label="Professional links">${professionalLinks.filter(Boolean).join(' ')}</nav></footer>
  </main>`
}

export default function publicHtmlFallback() {
  return {
    name: 'public-html-fallback',
    apply: 'build',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        const outlet = '<div id="app"></div>'
        if (!html.includes(outlet)) throw new Error('Missing public portfolio HTML outlet')
        return {
          html: html.replace(outlet, () => `<div id="app">${renderPublicPortfolio(portfolio)}</div>`),
          tags: [
            // Execute before parsing the fallback, even when the module is slow.
            // Vue replaces only #app's contents; the existing app remains unchanged.
            { tag: 'script', injectTo: 'head-prepend', children: "document.documentElement.classList.add('portfolio-js')" },
            { tag: 'style', injectTo: 'head', children: `
              .portfolio-js #portfolio-fallback { display: none; }
              #portfolio-fallback { max-width: 72rem; min-height: 100vh; margin: auto; padding: 2rem; background: white; color: #0f172a; overflow-wrap: anywhere; user-select: text; }
              #portfolio-fallback :is(section, article, footer) { margin-block: 2rem; }
              #portfolio-fallback :is(h1, h2, h3, h4) { font-weight: bold; margin-block: 1rem; }
              #portfolio-fallback h1 { font-size: 2rem; }
              #portfolio-fallback h2 { font-size: 1.5rem; }
              #portfolio-fallback p { margin-block: 1rem; }
              #portfolio-fallback ul { padding-left: 1.5rem; list-style: disc; }
              #portfolio-fallback a { color: #1d4ed8; text-decoration: underline; }
              #portfolio-fallback nav { display: flex; flex-wrap: wrap; gap: 1rem; }
            ` },
          ],
        }
      },
    },
  }
}

/** `node docs/build-pdf.ts`: docs/REPORT.md -> docs/REPORT.pdf with headless Chrome. Set CHROME if it isn't found. */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { marked } from 'marked'

const chrome = [process.env.CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(p => p && existsSync(p))
if (!chrome) throw new Error('No Chrome or Edge found. Set CHROME to its path.')

const md = readFileSync('docs/REPORT.md', 'utf8')
const html = join(tmpdir(), 'no-referee-report.html')
writeFileSync(html, `<!doctype html><meta charset="utf-8"><title>No Referee</title>
<style>
  @page { size: A4; margin: 18mm 16mm }
  body { font: 10.5pt/1.5 "Segoe UI", Arial, sans-serif; color: #1a1a1a }
  h1 { font-size: 22pt; margin: 0 0 4pt } h2 { font-size: 15pt; margin-top: 20pt; border-bottom: 1px solid #ccc; break-after: avoid }
  h3 { font-size: 12pt; break-after: avoid }
  table { border-collapse: collapse; width: 100%; font-size: 9pt; margin: 8pt 0; break-inside: avoid }
  th, td { border: 1px solid #ccc; padding: 3pt 5pt; text-align: left; vertical-align: top } th { background: #f2f2f2 }
  pre { background: #f6f6f6; padding: 8pt; font-size: 7.6pt; line-height: 1.3; break-inside: avoid; white-space: pre }
  code { font-family: Consolas, monospace; font-size: 0.92em }
</style>
<body>${marked.parse(md)}`)

execFileSync(chrome, ['--headless', '--disable-gpu', '--no-pdf-header-footer',
  `--print-to-pdf=${resolve('docs/REPORT.pdf')}`, pathToFileURL(html).href], { stdio: 'inherit' })
console.log('wrote docs/REPORT.pdf')

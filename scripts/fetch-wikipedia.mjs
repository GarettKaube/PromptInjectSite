import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const outputDirectory = join(process.cwd(), 'public', 'external-content')
const articles = [
  { title: 'Apollo 11', fileName: 'apollo_11.txt' },
  { title: 'Wright Flyer', fileName: 'wright_flyer.txt' },
  { title: 'Great Red Spot', fileName: 'great_red_spot.txt' },
]
const articleText = new Map()

await mkdir(outputDirectory, { recursive: true })

for (const article of articles) {
  const params = new URLSearchParams({
    action: 'query',
    prop: 'extracts',
    exintro: '1',
    explaintext: '1',
    exsectionformat: 'wiki',
    titles: article.title,
    format: 'json',
    formatversion: '2',
  })
  const response = await fetch(`https://en.wikipedia.org/w/api.php?${params}`, {
    headers: { 'User-Agent': 'Prompt-Injection-Research/1.0' },
  })
  if (!response.ok) throw new Error(`Wikipedia API request failed for ${article.title}: ${response.status}`)

  const payload = await response.json()
  const page = payload.query?.pages?.[0]
  if (!page?.extract) throw new Error(`No full article text returned for ${article.title}`)
  articleText.set(article.title, page.extract)

  const pageUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(article.title.replaceAll(' ', '_'))}`
  const historyUrl = `${pageUrl}?action=history`
  const text = [
    `${article.title} — Wikipedia lead section`,
    `Plain-text lead section fetched ${new Date().toISOString()}.`,
    `Article: ${pageUrl}`,
    '',
    page.extract,
    '',
    'Attribution and license',
    `Source article and revision history: ${historyUrl}`,
    'Wikipedia text is licensed under CC BY-SA 4.0. This file contains the article lead rendered as plain text',
    'License: https://creativecommons.org/licenses/by-sa/4.0/',
  ].join('\n')

  await writeFile(join(outputDirectory, article.fileName), text, 'utf8')
  console.log(`Saved ${article.title}: ${page.extract.length.toLocaleString()} article characters`)
}

const comparisonText = [
  'Two Wikipedia article leads — comparison source',
  '',
  'SOURCE 1: Wright Flyer',
  'https://en.wikipedia.org/wiki/Wright_Flyer',
  '',
  articleText.get('Wright Flyer'),
  '',
  'SOURCE 2: Apollo 11',
  'https://en.wikipedia.org/wiki/Apollo_11',
  '',
  articleText.get('Apollo 11'),
  '',
  'Attribution and license',
  'Both article leads are from Wikipedia and are licensed under CC BY-SA 4.0.',
  'License: https://creativecommons.org/licenses/by-sa/4.0/',
].join('\n')
await writeFile(join(outputDirectory, 'apollo_wright_comparison.txt'), comparisonText, 'utf8')
console.log(`Saved cross-article source: ${comparisonText.length.toLocaleString()} characters`)

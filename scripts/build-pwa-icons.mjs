// Renders the PWA icons (public/pwa-192x192.png, pwa-512x512.png, apple-touch-icon.png) from the favicon artwork.
// The detector disc sits inside the central 70% on a full-bleed slate square, so the same files serve as "any" and "maskable".
// Usage: node scripts/build-pwa-icons.mjs
import { readFileSync } from 'node:fs'
import sharp from 'sharp'

const favicon = readFileSync('public/favicon.svg', 'utf8')
const inner = favicon.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '')

// Favicon artwork lives in a 32x32 box; scale 0.68 about the centre keeps the whole disc in the maskable safe zone.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
<rect width="32" height="32" fill="#0f172a"/>
<g transform="translate(16 16) scale(0.68) translate(-16 -16)">${inner}</g>
</svg>`

for (const [file, size] of [['pwa-192x192.png', 192], ['pwa-512x512.png', 512], ['apple-touch-icon.png', 180]]) {
  await sharp(Buffer.from(svg), { density: 384 }).resize(size, size).png({ compressionLevel: 9 }).toFile(`public/${file}`)
  console.log('wrote public/' + file)
}

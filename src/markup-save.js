import { degrees, rgb, StandardFonts } from '../node_modules/pdf-lib/dist/pdf-lib.esm.js'
import { normalizeRotation } from './state.js'

// Shared text metrics so the preview, the editor and the saved PDF agree.
export const DEFAULT_FONT_SIZE = 14
export const TEXT_LINE_HEIGHT = 1.2
export const TEXT_BASELINE = 0.95 // first baseline, as a fraction of font size below the top

const MARKUP_TYPES = ['text', 'rect', 'ellipse', 'line', 'draw']

export function isMarkup(a) {
  return MARKUP_TYPES.includes(a.type)
}

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '')
  const n = m ? parseInt(m[1], 16) : 0xe03131
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255)
}

// Visual top-left point (page already rotated) → pdf-lib unrotated media-box
// point. Matches visualRectToUnrotated() in pdf-engine.js.
export function pointToUnrotated(pdfPage, vx, vy) {
  const rotation = normalizeRotation(pdfPage.getRotation().angle)
  const { width: W, height: H } = pdfPage.getSize()
  if (rotation === 90) return { x: vy, y: vx }
  if (rotation === 180) return { x: W - vx, y: vy }
  if (rotation === 270) return { x: W - vy, y: H - vx }
  return { x: vx, y: H - vy }
}

// WinAnsi-only standard font: swap anything it cannot encode.
function safeText(s) {
  return s.replace(/[^\x20-\x7E\xA0-\xFF]/g, '?')
}

export async function embedMarkupFont(doc) {
  return doc.embedFont(StandardFonts.Helvetica)
}

export function drawMarkupOnPdfPage(pdfPage, annots, font) {
  const rotation = normalizeRotation(pdfPage.getRotation().angle)
  const rotate = degrees(rotation)
  for (const a of annots) {
    const color = hexToRgb(a.color)
    if (a.type === 'text') {
      a.text.split(/\r?\n/).forEach((line, i) => {
        if (!line) return
        const p = pointToUnrotated(
          pdfPage,
          a.x,
          a.y + a.fontSize * (TEXT_BASELINE + TEXT_LINE_HEIGHT * i),
        )
        pdfPage.drawText(safeText(line), { x: p.x, y: p.y, size: a.fontSize, font, color, rotate })
      })
    } else if (a.type === 'rect') {
      // Rotate the rectangle around its converted bottom-left corner, as stamps do.
      const bl = pointToUnrotated(pdfPage, a.x, a.y + a.height)
      pdfPage.drawRectangle({
        x: bl.x, y: bl.y, width: a.width, height: a.height, rotate,
        borderColor: color, borderWidth: a.strokeWidth,
      })
    } else if (a.type === 'ellipse') {
      const c = pointToUnrotated(pdfPage, a.x + a.width / 2, a.y + a.height / 2)
      pdfPage.drawEllipse({
        x: c.x, y: c.y, xScale: a.width / 2, yScale: a.height / 2, rotate,
        borderColor: color, borderWidth: a.strokeWidth,
      })
    } else if (a.type === 'line') {
      pdfPage.drawLine({
        start: pointToUnrotated(pdfPage, a.x1, a.y1),
        end: pointToUnrotated(pdfPage, a.x2, a.y2),
        thickness: a.strokeWidth, color, lineCap: 1,
      })
    } else if (a.type === 'draw') {
      for (let i = 1; i < a.points.length; i++) {
        pdfPage.drawLine({
          start: pointToUnrotated(pdfPage, a.points[i - 1].x, a.points[i - 1].y),
          end: pointToUnrotated(pdfPage, a.points[i].x, a.points[i].y),
          thickness: a.strokeWidth, color, lineCap: 1,
        })
      }
    }
  }
}

// Used when a page is flattened to an image for redaction.
export function drawMarkupOnCanvas(ctx, annots, scale) {
  for (const a of annots) {
    ctx.save()
    ctx.strokeStyle = a.color
    ctx.fillStyle = a.color
    ctx.lineWidth = (a.strokeWidth || 2) * scale
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    if (a.type === 'text') {
      ctx.font = `${a.fontSize * scale}px Helvetica, Arial, sans-serif`
      ctx.textBaseline = 'alphabetic'
      a.text.split(/\r?\n/).forEach((line, i) => {
        ctx.fillText(line, a.x * scale, (a.y + a.fontSize * (TEXT_BASELINE + TEXT_LINE_HEIGHT * i)) * scale)
      })
    } else if (a.type === 'rect') {
      ctx.strokeRect(a.x * scale, a.y * scale, a.width * scale, a.height * scale)
    } else if (a.type === 'ellipse') {
      ctx.beginPath()
      ctx.ellipse((a.x + a.width / 2) * scale, (a.y + a.height / 2) * scale, (a.width / 2) * scale, (a.height / 2) * scale, 0, 0, Math.PI * 2)
      ctx.stroke()
    } else if (a.type === 'line') {
      ctx.beginPath()
      ctx.moveTo(a.x1 * scale, a.y1 * scale)
      ctx.lineTo(a.x2 * scale, a.y2 * scale)
      ctx.stroke()
    } else if (a.type === 'draw') {
      ctx.beginPath()
      a.points.forEach((p, i) => (i ? ctx.lineTo(p.x * scale, p.y * scale) : ctx.moveTo(p.x * scale, p.y * scale)))
      ctx.stroke()
    }
    ctx.restore()
  }
}

export const ZOOM_STEPS = [50, 67, 75, 90, 100, 125, 150, 175, 200]
export const ZOOM_MIN = 50
export const ZOOM_MAX = 200

export function snapZoom(direction, current) {
  if (direction === 'in') {
    return ZOOM_STEPS.find((z) => z > current) ?? ZOOM_MAX
  }
  return [...ZOOM_STEPS].reverse().find((z) => z < current) ?? ZOOM_MIN
}

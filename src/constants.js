// Grid step in pixels. Matches the canvas background grid in styles.css.
// Everything (spawn position, drag, resize, sizes) snaps to this so structures
// always align to the grid.
export const GRID = 32

export const snap = (v) => Math.round(v / GRID) * GRID

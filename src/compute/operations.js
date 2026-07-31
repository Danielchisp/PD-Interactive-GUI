// Registry of signal operations. Each operation declares the domain it applies
// to and the domain it produces. The per-chart context menu is built from this
// list filtered by the card's domain, so adding an operation (bandpass, PSD,
// envelope, …) is just adding an entry here plus its worker handler.

export const OPERATIONS = [
  { id: 'fft', label: 'Compute FFT', glyph: 'ƒ', inDomain: 'time', outDomain: 'freq' },
]

export const opsFor = (domain) => OPERATIONS.filter((o) => o.inDomain === domain)

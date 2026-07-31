// Floating light/dark switch on the canvas.
export default function ThemeToggle({ theme, onToggle }) {
  const dark = theme === 'dark'
  return (
    <button
      className="theme-toggle"
      onClick={onToggle}
      title={dark ? 'Switch to light theme' : 'Switch to dark theme'}
      aria-label="Toggle theme"
    >
      <span className="theme-icon">{dark ? '☀' : '☾'}</span>
      <span className="theme-label">{dark ? 'Light' : 'Dark'}</span>
    </button>
  )
}

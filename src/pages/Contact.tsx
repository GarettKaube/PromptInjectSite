import { Link } from 'react-router-dom'
import type { Dispatch, SetStateAction } from 'react'

type Theme = 'light' | 'dark'

interface ContactProps {
  theme: Theme
  onToggleTheme: Dispatch<SetStateAction<Theme>>
}

export function Contact({ theme, onToggleTheme }: ContactProps) {
  return (
    <div className="app-root min-h-screen bg-[#10131b] text-[#eef0f6]" data-theme={theme} id="top">
      <div className="site-shell mx-auto max-w-[1440px] px-4 sm:px-6 lg:px-[38px]">
        <header className="topbar">
          <nav className="main-nav" aria-label="Main navigation">
            <Link to="/">Home</Link>
            <Link to="/direct">Direct injection</Link>
            <Link className="active" to="/contact">Contact</Link>
          </nav>
          <div className="topbar-right">
            <button className="theme-toggle" onClick={() => onToggleTheme(theme === 'light' ? 'dark' : 'light')} aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`} title={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}>
              {theme === 'light' ? '☾' : '☀'}
            </button>
          </div>
        </header>

        <section className="intro">
          <div>
            <h1>Contact</h1>
            <p className="intro-subtitle">Questions about the project or its research data?</p>
          </div>
        </section>

        <main className="contact-content">
          <section className="panel contact-panel">
            <header className="panel-header">
              <h2>Get in touch</h2>
            </header>
            <div className="panel-content">
              <p>For questions about this project, prompt injection examples, or data collection, contact the project team using the details below.</p>
              <div className="contact-detail"> <strong>Garett Kaube</strong>: garett.kaube@ucalgary.ca</div>
            </div>
          </section>
        </main>
      </div>
    </div>
  )
}

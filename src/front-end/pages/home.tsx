import { Link } from "react-router-dom"
import type { Dispatch, SetStateAction } from 'react'
import { Play, Info, RotateCcw, MessageCircleText, 
  SquarePen, Sparkle, Bot, Moon, Sun } from 'lucide-react';

type Theme = 'light' | 'dark'

interface HomeProps {
  theme: Theme
  onToggleTheme: Dispatch<SetStateAction<Theme>>
}

function AboutPanel() {
  return (
    <section className="about-panel panel" aria-labelledby="about-heading">
      <header className="about-panel-header">
        <h2 id="about-heading">About</h2>
      </header>
      <div className="about-panel-content">
        <p className="about-overview">This website is a research project at the University of Calgary for exploring how language models respond to prompt injection. Users can change an instruction or the material a model is asked to process, then observe whether the model follows the intended task or is redirected toward a malicious or otherwise unintended action. The examples and resulting model responses help build a dataset for studying prompt injection and model behavior.</p>
        <p className="about-data-note"><strong>Data collection:</strong> The following artifacts are collected when you send a prompt:
        <ul className="list-disc pl-5">
            <li>Prompt injection inputs</li>
            <li>Model responses</li>
            <li>Model responses</li>
            <li>Name of model</li>
            <li>Given tasks</li>
            <li>Original fixed prompt</li>
            <li>Model tool calls</li>
            <li>Time of model call</li>
            <li>OpenCode sessionId</li>
           
          </ul>
          No other data is collected.</p>
        
        
        <div className="about-methods">
          <section className="about-type-panel" aria-labelledby="direct-pi-heading">
            
            <h3 id="direct-pi-heading">Direct Prompt Injection</h3>
            <p>In a direct injection, the user edits the prompt that is sent to the model. The prompt includes the original task alongside an added instruction intended to override, conflict with, or redirect that task.</p>
            <p>Because the injected instruction is part of the prompt itself, this exercise shows how competing instructions in a single model input can affect the answer. Users can compare the model’s response with the task it was originally given.</p>
          </section>
          <section className="about-type-panel" aria-labelledby="indirect-pi-heading">

            <h3 id="indirect-pi-heading">Indirect Prompt Injection</h3>
            <p>In an indirect injection, the user edits source material that the model is asked to read or use. The added instruction is embedded in that material rather than supplied as the main task prompt.</p>
            <p>This exercise explores whether a model can distinguish the user’s request from instructions found in untrusted content, and whether those embedded instructions influence its response.</p>
          </section>
        </div>

        <section className="about-context-panel" aria-labelledby="agent-sandbox-heading">
          <h3 id="agent-sandbox-heading">The Model</h3>
          <p>The model is run as an agent inside a sandbox and can access files in that sandbox. This lets the project study how instructions may affect an agent that can use its available tools and file system. The sandbox is the agent’s working environment; it should not be treated as a source of trusted instructions.</p>
        </section>

        <section className="about-context-panel" aria-labelledby="agent-sandbox-heading">
          <h3 id="agent-sandbox-heading">The Model's Tools</h3>
          <p>When you send a prompt to the model, the model can call tools such as the Shell tool, to complete its given tasks. Some tools it has access to are:</p>
          <p className="about-data-note"><ul className="list-disc pl-5">
            <li>Shell (run commands such as <code className="bg-gray-800 px-1.5 py-0.5 rounded text-blue-400"> ls -la</code>)</li>
            <li>Python (Write and run Python scripts)</li>
            <li>Read</li>
            <li>Write</li>
          </ul></p>
        </section>

        <section className="about-context-panel about-goals-panel" aria-labelledby="attacker-goals-heading">
          <h3 id="attacker-goals-heading">Example attacker goals</h3>
          <p>An attacker may try to make the agent ignore its intended task or instructions and instead:</p>
          <ul className="list-disc pl-5">
            <li>Reveal a password stored in a file the agent can access.</li>
            <li>Change or fabricate an answer, summary, or calculation.</li>
            <li>Carry out an unrelated action using the agent’s available tools.</li>
          </ul>
          <p>These are examples of behaviors the project aims to observe and document.</p>
        </section>
      </div>
    </section>
  )
}


function ModeSelection() {
  return (
    <section className="mode_selection mode_selection_panel">
              <header className="mode_selection-header">
                <h1>Mode Selection</h1>
              </header>
              <div className="panel-content mode-selection-content">
                  <p className="mode-selection-copy">Choose an exercise to explore how prompt injection can influence a model’s response.</p>
                  <div className="large-nav-button-container">
                    <div>
                
                        <Link className="large-nav-button" to="/direct"><Play/>Direct Prompt Injection</Link>
                    </div>
                    <div>
                  
                        <button className="large-nav-button coming-soon-button" type="button" disabled><Play/>Indirect Prompt Injection (Soon)</button>
                    </div>
                  </div>
              </div>
    </section>
  )
}

export function Home({ theme, onToggleTheme }: HomeProps) {
  
  return (
        <div className="app-root home-page min-h-screen bg-[#10131b] text-[#eef0f6]" data-theme={theme} id="top2">
          <div className="site-shell mx-auto max-w-[1440px] px-4 sm:px-6 lg:px-[38px]">
            <header className="topbar">
              <nav className="main-nav" aria-label="Main navigation">
                <Link className="active" to="/">Home</Link>
                <Link to="/direct">Direct injection</Link>
                <Link to="/contact">Contact</Link>
              </nav>
              <div className="topbar-right"><button className="theme-toggle" onClick={() => onToggleTheme(theme === 'light' ? 'dark' : 'light')} aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`} title={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}>{theme === 'light' ? (<> <Moon size={14}/></>) : (<> <Sun size={14} color='#fff700'/></>)}</button></div>
            </header>
            <ModeSelection/>
            <AboutPanel/>
          </div>
        </div>
    )
}

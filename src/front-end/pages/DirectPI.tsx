import { useEffect, useState, type ChangeEvent, type Dispatch, type SetStateAction } from 'react'
import { Link } from 'react-router-dom'
import { invokeRequest, type InvokeResponse } from '../InvokeRequest'
import { ToolCallList } from '../ToolCallList'
import Markdown from 'react-markdown'
import { useInjectionPodSession } from '../InjectionPodSession'
import { AgentDirectoryPanel } from '../AgentDirectoryPanel'
import { Play, Info, RotateCcw, MessageCircleText, Check,
  SquarePen, Sparkle, Bot, Moon, Sun, ChevronDown } from 'lucide-react';
import * as Select from "@radix-ui/react-select";
import { sendPostgres } from '../SendPostgres.ts'
import type { DirectPIDataRecord } from '../../backend/postgres.ts'

type Theme = 'light' | 'dark'

interface DirectPIProps {
  theme: Theme
  onToggleTheme: Dispatch<SetStateAction<Theme>>
}

interface DirectTaskPair {
  id: string
  legitimateTask: string
  givenInput: string
}

type InjectionPosition = "top" | "middle" | "bottom";
type InjectionPositionProp = {
  position: string;
  setPosition: (position: string) => void;
  theme: Theme;
}

function InjectionPosition({ position, setPosition, theme }: InjectionPositionProp) {
  
  return (
      <div className="w-64">
        <label
          id="position-label"
          className="position-select-label"
        >
          Select Position
        </label>
        <div>
          <Select.Root value={position} onValueChange={setPosition}>
            <Select.Trigger
              aria-labelledby="position-label"
              className="position-select-box"
            >
              <Select.Value placeholder="Choose a position" />
              <Select.Icon className="position-select-chevron"><ChevronDown size={16}/></Select.Icon>
            </Select.Trigger>

            <Select.Portal>
              <Select.Content
                position="popper"
                sideOffset={5}
                className="position-select-box-content"
                data-theme={theme}
              >
                <Select.Viewport>
                  {[
                    { value: "bottom", label: "Bottom" },
                    { value: "middle", label: "Middle" },
                    { value: "top", label: "Top" }
                  ].map((item) => (
                    <Select.Item
                      key={item.value}
                      value={item.value}
                      className="position-select-item"
                    >
                      <Select.ItemIndicator className="position-select-indicator"><Check size={14} /></Select.ItemIndicator>
                      <Select.ItemText>{item.label}</Select.ItemText>
                    </Select.Item>
                  ))}
                </Select.Viewport>
              </Select.Content>
            </Select.Portal>
          </Select.Root>     
        </div>
        <div className="hint"><span className="hint-icon"><Info size={14}/></span><span>This is where your injected text will be placed in the original prompt.</span></div>
      </div>
      
  )
}



export function DirectPI({ theme, onToggleTheme }: DirectPIProps) {
  const injectionSession = useInjectionPodSession()
  const [taskPairs, setTaskPairs] = useState<DirectTaskPair[]>([])
  const [selectedPair, setSelectedPair] = useState<DirectTaskPair | null>(null)
  const [prompt, setPrompt] = useState('')
  const [injection, setInjection] = useState('')
  const [loadError, setLoadError] = useState(false)
  const [result, setResult] = useState<InvokeResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isRunning, setIsRunning] = useState(false)
  const [runningSyb, setrunningSyb] = useState(<Sparkle size={18}/>)

  const [position, setPosition] = useState("bottom");

  const [completeprompt, setCompletePrompt] = useState(prompt)

  useEffect(() => {
    let active = true
    async function loadTaskPairs() {
      try {
        const response = await fetch('/direct-prompts/index.json')
        if (!response.ok) throw new Error('Direct task library could not be loaded')
        const entries = await response.json() as DirectTaskPair[]
        if (!entries.length) throw new Error('Direct task library is empty')
        const randomPair = entries[Math.floor(Math.random() * entries.length)]
        if (active) {
          setTaskPairs(entries)
          setSelectedPair(randomPair)
          setCompletePrompt(randomPair.givenInput)
          setPrompt(randomPair.givenInput)
        }
      } catch (requestError) {
        if (active) {
          console.error(requestError)
          setLoadError(true)
        }
      }
    }
    void loadTaskPairs()
    return () => { active = false }
  }, [])

  async function runModel(complete_prompt: string): Promise<InvokeResponse | undefined > {
    if (!injectionSession.id || !injectionSession.ready) {
      setError(injectionSession.error || 'Your private model pod is still starting. Please wait a moment.')
      return
    }
    setIsRunning(true)
    setError(null)
    setResult(null)
    try {
      const result = await invokeRequest(complete_prompt, injectionSession.id)
      setResult(result)
      return result
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'The model request failed.')
    } finally {
      setIsRunning(false)
    }
  }

  async function runAndSave() {
    const promptToRun = concatInjTextPrompt(injection)
      setCompletePrompt(promptToRun)
      setrunningSyb(<Bot />)

      try {
        const response = await runModel(promptToRun)
        if (response) {
          await sendtoDB(promptToRun, response)
        }
        
      } catch (error) {
        setError(error instanceof Error ? error.message : 'Failed to place in DB.')
      }
  }


  async function sendtoDB(prompt_to_run: string, result: InvokeResponse) {
    if (result && selectedPair && prompt_to_run) {
      const record: DirectPIDataRecord = {
        sessionid: result.sessionId,
        time: new Date(),
        task: selectedPair.legitimateTask,
        uned_prompt: prompt,

        inj_prompt: [injection],
        complete_prompt: prompt_to_run,

        inj_position_str: [position],

        model: "qwen3:8b",
        model_output: result.text,
        model_tool_calls: result.toolCalls
      };
      try {
        await sendPostgres(record)
      }
      catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : 'Failed to place in DB.')
      }
    }
  }

  function resetPrompt() {
    if (selectedPair) {
      setPrompt(selectedPair.givenInput)
      setCompletePrompt(selectedPair.givenInput)
    }
    setResult(null)
    setError(null)
    setInjection('')
  }

  function sampleNewTask() {
    if (taskPairs.length === 0) return
    const alternatives = taskPairs.filter((pair) => pair.id !== selectedPair?.id)
    const choices = alternatives.length > 0 ? alternatives : taskPairs
    const nextPair = choices[Math.floor(Math.random() * choices.length)]
    setSelectedPair(nextPair)
    setPrompt(nextPair.givenInput)
    setCompletePrompt(nextPair.givenInput)
    setResult(null)
    setError(null)
    setInjection("")
  }

  function concatInjTextPrompt(inj: string, placement = position) {
    
    let res = ''
    if (placement === "bottom") {
      res = prompt.concat(inj)
    }
    if (placement === "top") {
      res = inj.concat(prompt)
    }
    if (placement === "middle") {
      const lines = prompt.split('\n')
      const midpoint = Math.ceil(lines.length / 2)
      res = [...lines.slice(0, midpoint), inj, ...lines.slice(midpoint)].join('\n')
    }
    return res
  }

  function changePosition(nextPosition: string) {
    setPosition(nextPosition)
    setCompletePrompt(concatInjTextPrompt(injection, nextPosition))
    setResult(null)
    setError(null)
  }

  

  const previewLineCount = completeprompt.split('\n').length
  const injectionLineCount = injection.split('\n').length

  return (
    <div className="app-root direct-page min-h-screen bg-[#10131b] text-[#eef0f6]" data-theme={theme} id="top">
      <div className="site-shell mx-auto max-w-[1440px] px-4 sm:px-6 lg:px-[38px]">
        <header className="topbar">
          <nav className="main-nav" aria-label="Main navigation">
            <Link to="/">Home</Link>
            <Link className="active" to="/direct">Direct injection</Link>
            <Link to="/contact">Contact</Link>
          </nav>
          <div className="topbar-right">
            <button className="theme-toggle" onClick={() => onToggleTheme(theme === 'light' ? 'dark' : 'light')} aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`} title={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}>
              {theme === 'light' ? (<> <Moon size={14}/></>) : (<> <Sun size={14} color='#fff700'/></>)}
            </button>
          </div>
        </header>

        <section className="intro">
          <div>
            <h1>Direct Prompt Injection</h1>
            <p className="intro-subtitle">Change the prompt itself and see how the model can be redirected to do unintended and/or harmful behaviour. Examples of unintended/harmful behaviour are: model purposely incorrectly do its given task, returning false information, revealing passwords it should not, or deleting a file it should not. </p>
          </div>
        </section>
        <AgentDirectoryPanel sessionId={injectionSession.id} ready={injectionSession.ready} />
        <main className="direct-workspace">
          <section className="panel direct-input-panel">
            <header className="panel-header">
              <h2><span className="step-number blue"><SquarePen size={18}/></span>Edit the prompt</h2>
            </header>
            <div className="panel-content">
              <p className="eyebrow">Legitimate task</p>
              <div className="task-copy direct-task-copy">{loadError ? 'The task library could not be loaded. Check public/direct-prompts/index.json.' : selectedPair?.legitimateTask || 'Loading a task…'}</div>
              <button className="run-button sample-task-button" type="button" onClick={sampleNewTask} disabled={taskPairs.length < 2}>
                 <RotateCcw size={14}/> New random task
              </button>
              <div className="hint"><span className="hint-icon"><Info size={14}/></span><span>Your changes go directly into the prompt sent to the model.</span></div>
              <div className="rule" />
              <div className="direct-editor-heading">
                <label className="eyebrow" htmlFor="direct-prompt">Given input</label>
              </div>
              <div className="direct-editor-wrap">
                <div className="line-numbers" aria-hidden="true">{Array.from({ length: previewLineCount }, (_, index) => <span key={index}>{index + 1}</span>)}</div>
                <textarea
                  id="direct-prompt"
                  className="source-editor direct-prompt-editor"
                  spellCheck={false}
                  readOnly
                  value={completeprompt}
                  onChange={(event: ChangeEvent<HTMLTextAreaElement>) => {
                    setCompletePrompt(event.target.value)
                    setResult(null)
                    setError(null)
                  }}
                  aria-label="Editable direct model prompt"
                />
              </div>
              <section className="panel direct-input-panel">
                <header className="panel-header">
                  <h2><span className="step-number blue"><SquarePen size={18}/></span>Your injection</h2>
                </header>
                <div className="panel-content">
                  <div>
                
                <div className="direct-editor-heading">
                  <label className="eyebrow" htmlFor="injectionarea">injection</label>
                </div>
                <div className="direct-editor-wrap">
                  <div className="line-numbers" aria-hidden="true">{Array.from({ length: injectionLineCount }, (_, index) => <span key={index}>{index + 1}</span>)}</div>
                  <textarea
                    id="injectionarea"
                    className="source-editor injection-editor"
                    spellCheck={false}
                    
                    value={injection}
                    onChange={(event: ChangeEvent<HTMLTextAreaElement>) => {
                      const nextInjection = event.target.value
                      setInjection(nextInjection)
                      setCompletePrompt(concatInjTextPrompt(nextInjection))
                    }}
                    aria-label="Editable direct model prompt"
                  />
                  </div>
                </div>
                <InjectionPosition theme={theme} position={position} setPosition={changePosition}/>
                </div>
              </section>
              <div className="editor-footer"><span>{previewLineCount} LINES</span><span>{completeprompt.length} CHARS</span></div>
              <div className="editor-actions">
                <button className="reset-button" onClick={resetPrompt} disabled={!selectedPair}><RotateCcw size={14}/> Reset input</button>
                <button className="run-button" onClick={async () => {
                    runAndSave();}
                  } 
                    disabled={isRunning || !selectedPair || !injectionSession.ready}><span><Play size={24} /></span>{isRunning ? 'Sending prompt…' : injectionSession.ready ? 'Send Prompt' : injectionSession.error ? 'Pod failed to start' : 'Starting private pod…'}</button>
                {injectionSession.error && <p className="direct-error" role="alert">{injectionSession.error}</p>}
              </div>
            </div>
          </section>

          <section className="panel direct-output-panel" aria-live="polite">
            <header className="panel-header">
              <h2><span className="step-number pink"><MessageCircleText size={18}/></span>Model response</h2>
            </header>
            <div className="panel-content">
              <p className="eyebrow">Output preview</p>
              <div className="output-box direct-output-box">
                {error ? (
                  <div className="direct-error" role="alert">{error}</div>
                ) : result ? (
                  <>
                    <div className="output-kicker success">
                      ✓ LIVE MODEL RESPONSE
                    </div>
                    <div className="direct-answer"><Markdown>{result.text || 'The model returned an empty response.'}</Markdown></div>
                  </>
                ) : (
                  <div className="output-empty"><div><span className="spark">{runningSyb}</span>{isRunning ? 'Waiting for OpenCode…' : 'Edit the prompt, then run the model'}<br />{!isRunning && 'to preview its response.'}</div></div>
                )}
              </div>
              {result && <ToolCallList calls={result.toolCalls} />}
              <div className="rule response-rule" />
              
              <div className="score-box"><span>MODEL RUN</span><strong>{result ? 'COMPLETE' : error ? 'FAILED' : isRunning ? 'RUNNING' : '—'}</strong></div>
              
              {result && <div className="metric"><span>Session</span><b>{result.sessionId.slice(0, 8)}…</b></div>}
        
            </div>
          </section>
        </main>
        
      </div>
    </div>
  )
}

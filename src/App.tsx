import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { DirectPI } from './pages/DirectPI'
import { Home } from './pages/home'
import { Contact } from './pages/Contact'
import { InjectionPodSessionProvider } from './InjectionPodSession'

type Theme = 'light' | 'dark'

function App() {
  const [theme, setTheme] = useState<Theme>(() => window.localStorage.getItem('prompt-injection-theme') === 'dark' ? 'dark' : 'light')

  useEffect(() => {
    window.localStorage.setItem('prompt-injection-theme', theme)
  }, [theme])

  return (
    <BrowserRouter>
      <InjectionPodSessionProvider>
        <Routes>
          <Route path="/" element={<Home theme={theme} onToggleTheme={setTheme} />} />
          <Route path="/direct" element={<DirectPI theme={theme} onToggleTheme={setTheme} />} />
          <Route path="/contact" element={<Contact theme={theme} onToggleTheme={setTheme} />} />
        </Routes>
      </InjectionPodSessionProvider>
    </BrowserRouter>
  )
}

export default App

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { finishStravaConnect } from './lib/strava.ts'

// If Strava just sent the user back after granting access, complete the connection.
void finishStravaConnect()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

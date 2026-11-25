import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { finishStravaConnect } from './lib/strava.ts'
import { startSync } from './lib/sync.ts'

// If Strava just sent the user back after granting access, complete the connection.
void finishStravaConnect()

// Keep profile, workouts and rides in step with the signed-in account.
startSync()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

import { SIM } from './ble/devices.ts'
import { href, useRoute } from './lib/router.ts'
import { HardwareCheck } from './pages/HardwareCheck.tsx'
import { HistoryPage } from './pages/HistoryPage.tsx'
import { Home } from './pages/Home.tsx'
import { ProfilePage } from './pages/ProfilePage.tsx'
import { RidePage } from './pages/RidePage.tsx'
import { SummaryPage } from './pages/SummaryPage.tsx'
import { WorkoutPage } from './pages/WorkoutPage.tsx'

const NAV: [route: string, label: string][] = [
  ['', 'Workouts'],
  ['history', 'Rides'],
  ['profile', 'Profile'],
  ['check', 'Hardware check'],
]

function Page({ route }: { route: string }) {
  const [head, ...rest] = route.split('/')
  const arg = decodeURIComponent(rest.join('/'))
  switch (head) {
    case 'workout':
      return <WorkoutPage id={arg} />
    case 'ride':
      return <RidePage />
    case 'summary':
      return <SummaryPage id={arg} />
    case 'history':
      return <HistoryPage />
    case 'profile':
      return <ProfilePage />
    case 'check':
      return <HardwareCheck />
    default:
      return <Home />
  }
}

export default function App() {
  const route = useRoute()
  const head = route.split('/')[0]
  const riding = head === 'ride'
  return (
    <div className={`mx-auto space-y-5 p-5 pb-16 ${riding ? 'max-w-7xl' : 'max-w-5xl'}`}>
      <nav className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
        <a href={href('')} className="mr-2 text-base font-semibold">
          Indoor Trainer
        </a>
        {NAV.map(([r, label]) => {
          const active = r === head || (r === '' && head === 'workout') || (r === 'history' && head === 'summary')
          return (
            <a
              key={r}
              href={href(r)}
              className={
                active
                  ? 'font-medium text-teal-700 dark:text-teal-400'
                  : 'text-stone-600 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100'
              }
            >
              {label}
            </a>
          )
        })}
        {SIM && (
          <span className="ml-auto rounded bg-amber-100 px-2 py-1 text-xs font-medium text-amber-900">
            Simulated devices: no real Bluetooth is used
          </span>
        )}
      </nav>
      <main>
        <Page route={route} />
      </main>
    </div>
  )
}

import { Card } from '../components/ui.tsx'
import { powerZoneTable } from '../domain/zones.ts'
import { profileStore, settingsStore, type ProfileForm } from '../lib/storage.ts'
import { useStore } from '../lib/store.ts'

const FIELDS: { key: keyof ProfileForm; label: string; unit: string; hint: string; min: number; max: number; required: boolean }[] = [
  { key: 'ftp', label: 'FTP', unit: 'W', hint: 'Power you can hold for about an hour. All targets scale with it.', min: 50, max: 600, required: true },
  { key: 'weightKg', label: 'Weight', unit: 'kg', hint: 'Used to turn power into speed and distance.', min: 30, max: 200, required: true },
  { key: 'maxHr', label: 'Max heart rate', unit: 'bpm', hint: 'Optional. Scales the heart rate line.', min: 100, max: 230, required: false },
  { key: 'thresholdHr', label: 'Threshold heart rate', unit: 'bpm', hint: 'Optional. Sets the heart rate zones.', min: 90, max: 220, required: false },
]

export function ProfilePage() {
  const profile = useStore(profileStore)
  const settings = useStore(settingsStore)

  const update = (key: keyof ProfileForm, raw: string) => {
    const n = raw === '' ? null : Number(raw)
    profileStore.set({ ...profile, [key]: n !== null && Number.isFinite(n) && n > 0 ? n : null })
  }

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-semibold">Profile</h1>
      <Card title="Your numbers">
        <div className="grid gap-4 sm:grid-cols-2">
          {FIELDS.map((f) => {
            const value = profile[f.key]
            const outOfRange = value !== null && (value < f.min || value > f.max)
            return (
              <label key={f.key} className="block text-sm">
                <span className="font-medium">
                  {f.label}
                  {f.required && <span className="text-red-600"> *</span>}
                </span>
                <span className="mt-1 flex items-center gap-2">
                  <input
                    type="number"
                    inputMode="decimal"
                    value={value ?? ''}
                    onChange={(e) => update(f.key, e.target.value)}
                    aria-label={f.label}
                    className="w-28 rounded border border-stone-300 bg-white px-2 py-1.5 dark:border-stone-700 dark:bg-stone-900"
                  />
                  <span className="text-stone-500">{f.unit}</span>
                </span>
                <span className={`mt-1 block text-xs ${outOfRange ? 'text-amber-700 dark:text-amber-400' : 'text-stone-500'}`}>
                  {outOfRange ? `That looks unusual: expected ${f.min} to ${f.max} ${f.unit}.` : f.hint}
                </span>
              </label>
            )
          })}
        </div>
        <p className="mt-4 text-xs text-stone-500">Saved in this browser as you type.</p>
      </Card>

      {profile.ftp && (
        <Card title="Power zones">
          <table className="w-full max-w-md text-left text-sm">
            <tbody>
              {powerZoneTable(profile.ftp).map((row) => (
                <tr key={row.zone.zone} className="border-t border-stone-200 first:border-t-0 dark:border-stone-800">
                  <td className="py-1.5">
                    <span className="mr-2 inline-block h-2.5 w-2.5 rounded-sm" style={{ background: row.zone.color }} />
                    Z{row.zone.zone} {row.zone.name}
                  </td>
                  <td className="text-right tabular-nums">
                    {row.toW === null ? `over ${row.fromW - 1} W` : `${row.fromW} to ${row.toW} W`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <Card title="Ride settings">
        <div className="space-y-3 text-sm">
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-1"
              checked={settings.sound}
              onChange={(e) => settingsStore.set({ ...settings, sound: e.target.checked })}
            />
            <span>
              <span className="font-medium">Beeps</span>
              <span className="block text-xs text-stone-500">Three short beeps before each step change, one long beep at the change.</span>
            </span>
          </label>
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-1"
              checked={settings.autoPause}
              onChange={(e) => settingsStore.set({ ...settings, autoPause: e.target.checked })}
            />
            <span>
              <span className="font-medium">Pause when I stop pedalling</span>
              <span className="block text-xs text-stone-500">
                The clock stops after 3 seconds without power and continues when you pedal again.
              </span>
            </span>
          </label>
        </div>
      </Card>
    </div>
  )
}

/**
 * Shelf for app preferences (#172): service URLs, paths, device.
 * Nothing editable until that issue lands.
 */
export function PreferencesSection() {
  return (
    <div className="flex flex-col gap-8">
      <div>
        <h2 className="text-xl font-semibold text-neutral-100">Preferences</h2>
        <p className="mt-1 text-sm text-neutral-400">
          Service addresses, folders, and device.
        </p>
      </div>
      <div className="rounded-2xl border border-dashed border-white/10 px-5 py-4">
        <p className="text-sm text-neutral-400">
          Service URLs, paths, and device live here — coming in #172.
        </p>
      </div>
    </div>
  );
}

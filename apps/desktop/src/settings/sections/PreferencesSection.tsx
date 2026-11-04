/**
 * App preferences: agent edits always apply on arrival onto a copy
 * (a new timeline, version, or track) and land in history, undoable
 * with one key. Service URLs, paths, and device live here next.
 */
export function PreferencesSection() {
  return (
    <div className="flex flex-col gap-8">
      <div className="rounded-2xl border border-dashed border-white/10 px-5 py-4">
        <p className="text-sm text-neutral-400">
          Service URLs, paths, and device live here — coming in #172.
        </p>
      </div>
    </div>
  );
}

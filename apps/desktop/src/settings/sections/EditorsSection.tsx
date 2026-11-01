/**
 * Shelf for the editing-app connection manager (#185): Resolve,
 * Kdenlive, and interchange as connectable instances.
 */
export function EditorsSection() {
  return (
    <div className="flex flex-col gap-8">
      <div>
        <h2 className="text-xl font-semibold text-neutral-100">Editors</h2>
        <p className="mt-1 text-sm text-neutral-400">
          Which editing app Chair hands the cut to.
        </p>
      </div>
      <div className="rounded-2xl border border-dashed border-white/10 px-5 py-4">
        <p className="text-sm text-neutral-400">
          Resolve, Kdenlive, and interchange connections live here.
        </p>
      </div>
    </div>
  );
}

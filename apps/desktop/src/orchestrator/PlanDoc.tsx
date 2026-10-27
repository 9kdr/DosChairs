import type { ReactNode } from "react";

const linkClass =
  "text-neutral-100 underline decoration-neutral-500 underline-offset-[0.18em] hover:decoration-neutral-100 focus-visible:rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-400";

function DocLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      onClick={(event) => event.preventDefault()}
      className={linkClass}
    >
      {children}
    </a>
  );
}

export function PlanDoc() {
  return (
    <article
      aria-label="Plan"
      className="flex min-h-0 flex-1 flex-col overflow-y-auto rounded-[28px] bg-[#1a1a1a] px-8 py-8 text-neutral-100 shadow-raised ring-1 ring-white/8 sm:px-10 sm:py-9"
    >
      <h1 className="max-w-prose text-2xl font-medium tracking-tight">
        Talking head rough-cut
      </h1>
      <p className="mt-2 max-w-prose text-sm text-neutral-400">Story and objective</p>

      <div className="mt-8 max-w-prose space-y-5 text-base leading-7">
        <p>
          One speaker, one room, cut so the argument lands before the viewer
          looks away. The story opens on a line you can repeat, spends the
          middle earning it, and ends on a pay-off that does not need a recap.
        </p>
        <p>
          Leave a rough cut Resolve can still grade. Keep the face on the
          A-roll, park extra shots on the{" "}
          <DocLink href="#b-roll-shelf">B-roll shelf</DocLink>, and hold the
          words for the <DocLink href="#caption-pass">caption pass</DocLink>.
          The source stays as it was shot.
        </p>
        <p>
          What the other sections inherit: the hook in the first breath, a
          setup that does not wander, and a close that matches the{" "}
          <DocLink href="#brief">brief</DocLink>. Edit, effects, and colour
          work inside this story.
        </p>
      </div>

      <nav aria-label="Related" className="mt-10 max-w-prose">
        <p className="text-sm text-neutral-400">Related</p>
        <ul className="mt-3 flex flex-col gap-2">
          <li>
            <DocLink href="#brief">Hook, setup, pay-off</DocLink>
          </li>
          <li>
            <DocLink href="#b-roll-shelf">B-roll shelf</DocLink>
          </li>
          <li>
            <DocLink href="#caption-pass">Caption pass — trailer</DocLink>
          </li>
        </ul>
      </nav>
    </article>
  );
}

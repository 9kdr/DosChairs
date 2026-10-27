import { cn } from "@/lib/utils";
import { EditorLogo } from "./EditorLogo";
import { editorById, formatEditedAt, type Project } from "./data";

type ProjectCardProps = {
  project: Project;
  /** True while this card is the hover/focus target in the grid. */
  emphasized?: boolean;
};

/** Visual project tile — click/hover hit targets live on the grid cell. */
export function ProjectCard({ project, emphasized = false }: ProjectCardProps) {
  const editor = editorById(project.editorId);

  return (
    <div
      className={cn("flex w-full flex-col gap-2 text-left", "rounded-xl")}
      data-emphasized={emphasized || undefined}
    >
      <div
        className={cn(
          "relative aspect-[16/10] overflow-hidden rounded-xl bg-neutral-800/80",
          "ring-1 ring-white/[0.06]",
        )}
      >
        <div
          aria-hidden="true"
          className="absolute inset-0 bg-[radial-gradient(120%_80%_at_50%_0%,rgb(255_255_255/0.06),transparent_55%)]"
        />
        <div
          aria-hidden="true"
          className="absolute inset-0 opacity-50"
          style={{
            backgroundImage: "linear-gradient(to bottom, transparent 55%, rgb(0 0 0 / 0.55))",
          }}
        />
      </div>

      <div className="min-w-0 px-0.5">
        <p className="truncate text-sm font-medium text-neutral-100">{project.name}</p>
        <p className="flex items-center gap-1.5 text-xs text-neutral-500">
          <EditorLogo id={editor.id} className="size-3.5" />
          <span className="sr-only">{editor.short}</span>
          <span aria-hidden="true">·</span>
          <time dateTime={project.editedAt}>{formatEditedAt(project.editedAt)}</time>
        </p>
      </div>
    </div>
  );
}

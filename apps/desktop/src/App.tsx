import { useState } from "react";
import { WindowChrome } from "@/components/window-chrome";
import { TooltipProvider } from "@/components/ui/tooltip";
import { HomeScreen } from "./home/HomeScreen";
import { findStoredProject } from "./home/projects";
import { ProjectShell } from "./ProjectShell";

type Screen = "home" | "project";

export function App() {
  const [screen, setScreen] = useState<Screen>("home");
  const [projectId, setProjectId] = useState<string | null>(null);

  const project = projectId !== null ? findStoredProject(projectId) : null;
  const projectOpen = screen === "project" && project !== null;

  return (
    <TooltipProvider delay={400}>
      <div className="chair-shell relative text-foreground">
        <WindowChrome />
        {projectOpen ? (
          <ProjectShell
            projectId={project.id}
            projectName={project.name}
            editorId={project.editorId}
            onHome={() => setScreen("home")}
          />
        ) : (
          <HomeScreen
            onOpenProject={(id) => {
              setProjectId(id);
              setScreen("project");
            }}
          />
        )}
      </div>
    </TooltipProvider>
  );
}

import { AssetShelf, ReferenceShelf } from "./AssetShelf";
import { PlanDoc } from "./PlanDoc";
import { RunningTasks } from "./RunningTasks";
import { TodoList } from "./TodoList";

export function OrchestratorBoard() {
  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(0,1.7fr)_minmax(18rem,0.95fr)] gap-4 p-4">
      <div className="flex min-h-0 min-w-0 flex-col gap-4">
        <PlanDoc />
        <TodoList className="shrink-0" />
      </div>
      <div className="flex min-h-0 min-w-0 flex-col gap-4 overflow-y-auto">
        <RunningTasks />
        <AssetShelf />
        <ReferenceShelf />
      </div>
    </div>
  );
}

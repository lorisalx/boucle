import { CaptureModal } from "./Capture.tsx";
import { Home } from "./Home.tsx";
import { Loops, LoopDetail } from "./Loops.tsx";
import { Meetings } from "./Meetings.tsx";
import { Projects } from "./Projects.tsx";
import { Settings } from "./Settings.tsx";
import { TicketDetail } from "./TicketDetail.tsx";
import { useHashRoute } from "./hooks.ts";

export function App() {
  const hash = useHashRoute();
  const ticketMatch = /^#\/ticket\/(.+)$/.exec(hash);
  const loopMatch = /^#\/loops\/(.+)$/.exec(hash);

  let view = <Home />;
  if (ticketMatch) view = <TicketDetail ticketId={ticketMatch[1]} />;
  else if (loopMatch) view = <LoopDetail loopId={loopMatch[1]} />;
  else if (hash.startsWith("#/projects")) view = <Projects />;
  else if (hash.startsWith("#/meetings")) view = <Meetings />;
  else if (hash.startsWith("#/loops")) view = <Loops />;
  else if (hash.startsWith("#/settings")) view = <Settings />;

  return (
    <div className="min-h-full">
      {view}
      <CaptureModal />
    </div>
  );
}

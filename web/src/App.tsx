import { Brain } from "./Brain.tsx";
import { Brain as BrainGraph } from "./BrainGraph.tsx";
import { CaptureModal } from "./Capture.tsx";
import { Chat } from "./Chat.tsx";
import { Home } from "./Home.tsx";
import { Loops, LoopDetail } from "./Loops.tsx";
import { Meetings } from "./Meetings.tsx";
import { Projects } from "./Projects.tsx";
import { Settings } from "./Settings.tsx";
import { Shell } from "./Shell.tsx";
import { TicketDetail } from "./TicketDetail.tsx";
import { VibeThread } from "./VibeThread.tsx";
import { useHashRoute } from "./hooks.ts";

export function App() {
  const hash = useHashRoute();
  const chatMatch = /^\/chats\/([^/]+)$/.exec(window.location.pathname);
  const vibeMatch = /^\/vibe\/([^/]+)\/([^/]+)$/.exec(window.location.pathname);
  const ticketMatch = /^#\/ticket\/(.+)$/.exec(hash);
  const loopMatch = /^#\/loops\/(.+)$/.exec(hash);

  let view = <Home />;
  if (vibeMatch) {
    view = <VibeThread scope={decodeURIComponent(vibeMatch[1])} sessionId={decodeURIComponent(vibeMatch[2])} />;
  } else if (chatMatch) view = <Chat conversationId={decodeURIComponent(chatMatch[1])} />;
  else if (ticketMatch) view = <TicketDetail ticketId={ticketMatch[1]} />;
  else if (loopMatch) view = <LoopDetail loopId={loopMatch[1]} />;
  else if (hash.startsWith("#/projects")) view = <Projects />;
  else if (hash.startsWith("#/graph")) view = <BrainGraph />;
  else if (hash.startsWith("#/brain")) view = <Brain />;
  else if (hash.startsWith("#/meetings")) view = <Meetings />;
  else if (hash.startsWith("#/loops")) view = <Loops />;
  else if (hash.startsWith("#/settings")) view = <Settings />;

  return (
    <Shell>
      {view}
      <CaptureModal />
    </Shell>
  );
}

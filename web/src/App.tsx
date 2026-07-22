import { Brain } from "./Brain.tsx";
import { Brain as BrainGraph } from "./BrainGraph.tsx";
import { CaptureModal } from "./Capture.tsx";
import { Chat } from "./Chat.tsx";
import { ExtensionPage } from "./ExtensionPage.tsx";
import { Home } from "./Home.tsx";
import { Loops, LoopDetail } from "./Loops.tsx";
import { Meetings } from "./Meetings.tsx";
import { Projects } from "./Projects.tsx";
import { Settings } from "./Settings.tsx";
import { SessionDetail, Sessions } from "./Sessions.tsx";
import { Shell } from "./Shell.tsx";
import { TicketDetail } from "./TicketDetail.tsx";
import { ThreadView, Threads } from "./Threads.tsx";
import { ProjectTerminalPage } from "./TerminalDrawer.tsx";
import { VibeThread } from "./VibeThread.tsx";
import { useHashRoute } from "./hooks.ts";

export function App() {
  const hash = useHashRoute();
  const chatMatch = /^\/chats\/([^/]+)$/.exec(window.location.pathname);
  const vibeMatch = /^\/vibe\/([^/]+)\/([^/]+)$/.exec(window.location.pathname);
  const agentMatch = /^\/agent\/([a-z][a-z0-9-]*)\/([^/]+)\/([^/]+)$/.exec(window.location.pathname);
  const ticketMatch = /^#\/ticket\/(.+)$/.exec(hash);
  const loopMatch = /^#\/loops\/(.+)$/.exec(hash);
  const extMatch = /^#\/ext\/([a-z][a-z0-9-]*)$/.exec(hash);
  const sessionMatch = /^#\/sessions\/(claude|codex)\/([^/]+)$/.exec(hash);
  const threadMatch = /^#\/threads\/([^/]+)$/.exec(hash);
  const terminalMatch = /^#\/terminal\/([^/]+)$/.exec(hash);

  let view = <Home />;
  if (agentMatch) {
    view = <VibeThread runner={agentMatch[1]} scope={decodeURIComponent(agentMatch[2])} sessionId={decodeURIComponent(agentMatch[3])} />;
  } else if (vibeMatch) {
    view = <VibeThread runner="vibe" scope={decodeURIComponent(vibeMatch[1])} sessionId={decodeURIComponent(vibeMatch[2])} />;
  } else if (chatMatch) view = <Chat conversationId={decodeURIComponent(chatMatch[1])} />;
  else if (threadMatch) view = <ThreadView threadId={decodeURIComponent(threadMatch[1])} />;
  else if (terminalMatch) view = <ProjectTerminalPage projectId={decodeURIComponent(terminalMatch[1])} />;
  else if (sessionMatch) view = <SessionDetail engine={sessionMatch[1] as "claude" | "codex"} sessionId={decodeURIComponent(sessionMatch[2])} />;
  else if (ticketMatch) view = <TicketDetail ticketId={ticketMatch[1]} />;
  else if (loopMatch) view = <LoopDetail loopId={loopMatch[1]} />;
  else if (extMatch) view = <ExtensionPage name={extMatch[1]!} />;
  else if (hash.startsWith("#/projects")) view = <Projects />;
  else if (hash.startsWith("#/graph")) view = <BrainGraph />;
  else if (hash.startsWith("#/brain")) view = <Brain />;
  else if (hash.startsWith("#/meetings")) view = <Meetings />;
  else if (hash.startsWith("#/loops")) view = <Loops />;
  else if (hash.startsWith("#/sessions")) view = <Sessions />;
  else if (hash.startsWith("#/threads")) view = <Threads />;
  else if (hash.startsWith("#/settings")) view = <Settings />;

  return (
    <Shell>
      {view}
      <CaptureModal />
    </Shell>
  );
}

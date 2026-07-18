import React from "react";
import {
  AbsoluteFill,
  Easing,
  interpolate,
  useCurrentFrame,
} from "remotion";
import {
  AMBER,
  BG,
  CARD_BORDER,
  FONT,
  GRADIENT,
  INK,
  MONO,
  MUTED,
  ORANGE,
  POP,
  PULL,
  SETTLE,
} from "./theme";

/**
 * Act One (0–640):
 *   0–140   "Two years ago, you had one project."      — one tidy card
 * 140–320   "Now AI lets you do more / and more / …"    — cards multiply
 * 320–505   "and the pings come from everywhere"        — notification chaos
 * 505–640   freeze, then everything collapses into one orange dot
 */

const COLLAPSE_START = 512;
const CENTER = { x: 960, y: 620 };

type Slot = { x: number; y: number; w: number; at: number; name: string };

// The first card sits alone; the rest pop in with an accelerating cadence.
const CARDS: Slot[] = [
  { x: 960, y: 620, w: 340, at: 8, name: "Project Alpha" },
  { x: 620, y: 500, w: 290, at: 160, name: "Partner Portal" },
  { x: 1310, y: 530, w: 300, at: 176, name: "Onboarding Copilot" },
  { x: 750, y: 830, w: 280, at: 190, name: "Usage Observatory" },
  { x: 1190, y: 810, w: 290, at: 203, name: "Hélium Migration" },
  { x: 420, y: 670, w: 260, at: 215, name: "Landing revamp" },
  { x: 1510, y: 690, w: 270, at: 226, name: "Pricing v3" },
  { x: 910, y: 400, w: 260, at: 236, name: "The big rewrite" },
  { x: 550, y: 940, w: 260, at: 245, name: "Side quest #7" },
  { x: 1350, y: 960, w: 260, at: 253, name: "That demo" },
  { x: 285, y: 445, w: 240, at: 261, name: "Another idea" },
  { x: 1640, y: 460, w: 240, at: 268, name: "Untitled 12" },
  { x: 1060, y: 985, w: 250, at: 275, name: "Untitled 13" },
];

type Toast = {
  x: number;
  y: number;
  at: number;
  from: "left" | "right" | "top" | "bottom";
  color: string;
  source: string;
  text: string;
};

const TOASTS: Toast[] = [
  { x: 520, y: 560, at: 335, from: "left", color: "#611f69", source: "Slack", text: "I need you to do this today" },
  { x: 1400, y: 620, at: 352, from: "right", color: "#1b1b19", source: "GitHub", text: "Issue #142 — login broken?" },
  { x: 820, y: 720, at: 369, from: "bottom", color: "#d93025", source: "Gmail", text: "Re: Re: Re: quick question" },
  { x: 1160, y: 450, at: 386, from: "top", color: "#1a73e8", source: "Calendar", text: "“Quick sync” (45 min)" },
  { x: 380, y: 860, at: 402, from: "left", color: AMBER, source: "Idea", text: "3am — rewrite it in Rust?" },
  { x: 1530, y: 880, at: 417, from: "right", color: "#611f69", source: "Slack", text: "random side project idea" },
  { x: 700, y: 400, at: 431, from: "top", color: "#d93025", source: "Gmail", text: "FWD: FWD: urgent-ish" },
  { x: 1270, y: 950, at: 445, from: "bottom", color: "#1a73e8", source: "Calendar", text: "Moved: product committee" },
];

/** Shared collapse: pull an element at (x, y) into the center dot. */
const useCollapse = (frame: number, x: number, y: number, order: number) => {
  const start = COLLAPSE_START + order * 4;
  const t = interpolate(frame, [start, start + 26], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(...PULL),
  });
  return {
    dx: (CENTER.x - x) * t,
    dy: (CENTER.y - y) * t,
    scale: 1 - 0.92 * t,
    opacity: t > 0.97 ? 0 : 1,
  };
};

const ProjectCard: React.FC<{ slot: Slot; index: number }> = ({ slot, index }) => {
  const frame = useCurrentFrame();
  const jitterAmp = interpolate(frame, [330, 490, 500, 508], [0, 2.4, 2.4, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const jitter = Math.sin(frame * 0.55 + index * 1.7) * jitterAmp;
  const collapse = useCollapse(frame, slot.x, slot.y, index);
  return (
    <div
      style={{
        position: "absolute",
        left: slot.x,
        top: slot.y,
        width: slot.w,
        opacity:
          collapse.opacity *
          interpolate(frame, [slot.at, slot.at + 8], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          }),
        translate: `${-slot.w / 2 + collapse.dx}px ${-60 + collapse.dy}px`,
        scale: String(
          collapse.scale *
            interpolate(frame, [slot.at, slot.at + 14], [0.4, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
              easing: Easing.bezier(...POP),
            }),
        ),
        rotate: `${jitter + (index % 2 === 0 ? -1 : 1) * (index % 5) * 0.7}deg`,
        background: "white",
        border: `1px solid ${CARD_BORDER}`,
        borderRadius: 18,
        boxShadow: "0 8px 28px rgba(27,27,25,0.08)",
        padding: "22px 26px",
        fontFamily: FONT,
      }}
    >
      <div style={{ fontSize: 27, fontWeight: 600, color: INK, whiteSpace: "nowrap" }}>
        {slot.name}
      </div>
      <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 9 }}>
        <div style={{ height: 9, width: "82%", borderRadius: 5, background: "rgba(27,27,25,0.10)" }} />
        <div style={{ height: 9, width: "58%", borderRadius: 5, background: "rgba(27,27,25,0.07)" }} />
      </div>
    </div>
  );
};

const NotificationToast: React.FC<{ toast: Toast; index: number }> = ({ toast, index }) => {
  const frame = useCurrentFrame();
  const entry = interpolate(frame, [toast.at, toast.at + 16], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(...POP),
  });
  const fromX = toast.from === "left" ? -600 : toast.from === "right" ? 600 : 0;
  const fromY = toast.from === "top" ? -500 : toast.from === "bottom" ? 500 : 0;
  const collapse = useCollapse(frame, toast.x, toast.y, index + 4);
  return (
    <div
      style={{
        position: "absolute",
        left: toast.x,
        top: toast.y,
        opacity: entry * collapse.opacity,
        translate: `${-190 + fromX * (1 - entry) + collapse.dx}px ${-38 + fromY * (1 - entry) + collapse.dy}px`,
        scale: String(collapse.scale),
        rotate: `${(index % 2 === 0 ? -1 : 1) * (2 + (index % 3)) * 1.1}deg`,
        display: "flex",
        alignItems: "center",
        gap: 16,
        background: "white",
        border: `1px solid ${CARD_BORDER}`,
        borderLeft: `7px solid ${toast.color}`,
        borderRadius: 15,
        boxShadow: "0 14px 34px rgba(27,27,25,0.16)",
        padding: "17px 26px 17px 20px",
        fontFamily: FONT,
        whiteSpace: "nowrap",
      }}
    >
      <span style={{ fontSize: 22, fontWeight: 700, color: toast.color, fontFamily: MONO }}>
        {toast.source}
      </span>
      <span style={{ fontSize: 25, fontWeight: 500, color: INK }}>{toast.text}</span>
    </div>
  );
};

const Headline: React.FC<{
  text: string;
  from: number;
  to: number;
  size?: number;
  accent?: boolean;
}> = ({ text, from, to, size = 76, accent }) => {
  const frame = useCurrentFrame();
  if (frame < from - 10 || frame > to + 10) return null;
  return (
    <div
      style={{
        position: "absolute",
        top: 128,
        left: 0,
        width: "100%",
        textAlign: "center",
        fontFamily: FONT,
        fontSize: size,
        fontWeight: 650,
        letterSpacing: "-0.02em",
        color: INK,
        opacity:
          interpolate(frame, [from, from + 12], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          }) *
          interpolate(frame, [to - 8, to], [1, 0], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          }),
        translate: `0px ${interpolate(frame, [from, from + 14], [26, 0], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: Easing.bezier(...SETTLE),
        })}px`,
        scale: String(
          interpolate(frame, [from, from + 12], [0.94, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(...POP),
          }),
        ),
      }}
    >
      {accent ? (
        <span
          style={{
            background: GRADIENT,
            WebkitBackgroundClip: "text",
            backgroundClip: "text",
            color: "transparent",
          }}
        >
          {text}
        </span>
      ) : (
        text
      )}
    </div>
  );
};

const CollapseDot: React.FC = () => {
  const frame = useCurrentFrame();
  if (frame < COLLAPSE_START + 6) return null;
  const grow = interpolate(frame, [COLLAPSE_START + 6, COLLAPSE_START + 86], [14, 150], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(...SETTLE),
  });
  const pulse = 1 + Math.sin(Math.max(0, frame - COLLAPSE_START - 86) * 0.18) * 0.03;
  return (
    <div
      style={{
        position: "absolute",
        left: CENTER.x,
        top: CENTER.y,
        width: grow,
        height: grow,
        translate: "-50% -50%",
        scale: String(pulse),
        borderRadius: "50%",
        background: GRADIENT,
        boxShadow: `0 0 ${grow * 0.9}px rgba(250, 80, 15, 0.45)`,
      }}
    />
  );
};

export const ActOne: React.FC = () => {
  const frame = useCurrentFrame();
  // Subtle camera shake while the pings pile up.
  const shakeAmp = interpolate(frame, [420, 495, 505], [0, 5, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <AbsoluteFill style={{ background: BG }}>
      <AbsoluteFill
        style={{
          translate: `${Math.sin(frame * 1.3) * shakeAmp}px ${Math.cos(frame * 1.7) * shakeAmp}px`,
        }}
      >
        {CARDS.map((slot, i) => (
          <ProjectCard key={slot.name} slot={slot} index={i} />
        ))}
        {TOASTS.map((toast, i) => (
          <NotificationToast key={toast.at} toast={toast} index={i} />
        ))}
        <CollapseDot />
      </AbsoluteFill>

      <Headline text="Two years ago, you had one project." from={16} to={140} />
      <Headline text="Now AI lets you do more" from={148} to={205} />
      <Headline text="and more" from={210} to={252} size={92} />
      <Headline text="and more" from={257} to={315} size={110} accent />
      <Headline text="and the pings come from everywhere." from={326} to={500} />

      {/* Small date stamp anchoring the first beat, like the app's greeting. */}
      <div
        style={{
          position: "absolute",
          top: 96,
          left: 0,
          width: "100%",
          textAlign: "center",
          fontFamily: MONO,
          fontSize: 26,
          color: MUTED,
          letterSpacing: "0.08em",
          opacity: interpolate(frame, [10, 24, 120, 138], [0, 1, 1, 0], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          }),
        }}
      >
        2024
      </div>
      <div
        style={{
          position: "absolute",
          top: 96,
          left: 0,
          width: "100%",
          textAlign: "center",
          fontFamily: MONO,
          fontSize: 26,
          color: ORANGE,
          letterSpacing: "0.08em",
          opacity: interpolate(frame, [150, 164, 490, 505], [0, 1, 1, 0], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          }),
        }}
      >
        2026
      </div>
    </AbsoluteFill>
  );
};

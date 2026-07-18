import { linearTiming, TransitionSeries } from "@remotion/transitions";
import { slide } from "@remotion/transitions/slide";
import React from "react";
import {
  AbsoluteFill,
  Easing,
  Img,
  interpolate,
  staticFile,
  useCurrentFrame,
} from "remotion";
import { BG, CARD_BORDER, CARD_SHADOW, FONT, INK, MONO, ORANGE, SETTLE } from "./theme";

export const SHOT_DURATION = 110;
export const SHOT_TRANSITION = 12;

type Shot = {
  file: string;
  kicker: string;
  headline: string;
  zoom?: [number, number];
  panY?: [number, number];
};

export const SHOTS: Shot[] = [
  {
    file: "shots/01-home-queue.png",
    kicker: "QUEUE",
    headline: "Every project, one calm morning view.",
    panY: [0, 0.35],
  },
  {
    file: "shots/03-capture-modal.png",
    kicker: "CAPTURE",
    headline: "Empty your head in one line — Boucle files it.",
    zoom: [1.04, 1.14],
  },
  {
    file: "shots/02-command-palette.png",
    kicker: "⌘K",
    headline: "Tickets, meetings, and the brain — one search away.",
    zoom: [1.04, 1.12],
  },
  {
    file: "shots/07-brain-graph.png",
    kicker: "BRAIN",
    headline: "A second brain that connects it all.",
    zoom: [1.1, 1.0],
  },
  {
    file: "shots/09-loops.png",
    kicker: "LOOPS",
    headline: "Recurring work runs itself on Devstral.",
    panY: [0, 0.25],
  },
  {
    file: "shots/05-projects.png",
    kicker: "PROJECTS",
    headline: "Reprioritized before you even sit down.",
    panY: [0.1, 0.4],
  },
];

const DemoShot: React.FC<{ shot: Shot }> = ({ shot }) => {
  const frame = useCurrentFrame();
  const cardW = 1660;
  const cardH = 810;
  // Screenshots are 3200x2000 → at cardW the natural height is cardW / 1.6.
  const imgH = cardW / 1.6;
  const maxPan = imgH - cardH;
  const zoom = shot.zoom ?? [1, 1.05];
  const panY = shot.panY ?? [0, 0];
  return (
    <AbsoluteFill style={{ background: BG, fontFamily: FONT }}>
      <div style={{ position: "absolute", top: 78, left: 130, right: 130 }}>
        <div
          style={{
            fontFamily: MONO,
            fontSize: 28,
            letterSpacing: "0.14em",
            color: ORANGE,
            fontWeight: 500,
            opacity: interpolate(frame, [4, 16], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            }),
            translate: `${interpolate(frame, [4, 20], [-30, 0], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
              easing: Easing.bezier(...SETTLE),
            })}px 0px`,
          }}
        >
          {shot.kicker}
        </div>
        <div
          style={{
            marginTop: 12,
            fontSize: 62,
            fontWeight: 650,
            letterSpacing: "-0.02em",
            color: INK,
            opacity: interpolate(frame, [10, 24], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            }),
            translate: `0px ${interpolate(frame, [10, 28], [24, 0], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
              easing: Easing.bezier(...SETTLE),
            })}px`,
          }}
        >
          {shot.headline}
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          top: 230,
          left: (1920 - cardW) / 2,
          width: cardW,
          height: cardH,
          borderRadius: 22,
          border: `1px solid ${CARD_BORDER}`,
          boxShadow: CARD_SHADOW,
          overflow: "hidden",
          background: "white",
          opacity: interpolate(frame, [14, 30], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          }),
          translate: `0px ${interpolate(frame, [14, 34], [46, 0], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(...SETTLE),
          })}px`,
        }}
      >
        <Img
          src={staticFile(shot.file)}
          style={{
            width: "100%",
            display: "block",
            translate: `0px ${-maxPan *
              interpolate(frame, [0, SHOT_DURATION], panY, {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
                easing: Easing.bezier(0.45, 0, 0.55, 1),
              })}px`,
            scale: String(
              interpolate(frame, [0, SHOT_DURATION], zoom, {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
                easing: Easing.bezier(0.45, 0, 0.55, 1),
              }),
            ),
            transformOrigin: "50% 30%",
          }}
        />
      </div>
    </AbsoluteFill>
  );
};

export const DEMO_DURATION =
  SHOTS.length * SHOT_DURATION - (SHOTS.length - 1) * SHOT_TRANSITION;

export const Demo: React.FC = () => {
  return (
    <TransitionSeries>
      {SHOTS.flatMap((shot, i) => {
        const seq = (
          <TransitionSeries.Sequence
            key={shot.file}
            durationInFrames={SHOT_DURATION}
          >
            <DemoShot shot={shot} />
          </TransitionSeries.Sequence>
        );
        if (i === SHOTS.length - 1) return [seq];
        return [
          seq,
          <TransitionSeries.Transition
            key={`${shot.file}-t`}
            presentation={slide({ direction: "from-right" })}
            timing={linearTiming({
              durationInFrames: SHOT_TRANSITION,
              easing: Easing.bezier(0.65, 0, 0.35, 1),
            })}
          />,
        ];
      })}
    </TransitionSeries>
  );
};

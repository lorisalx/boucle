import { linearTiming, TransitionSeries } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import React from "react";
import { AbsoluteFill, Audio, Easing, Sequence, staticFile } from "remotion";
import { ActOne } from "./ActOne";
import { Demo, DEMO_DURATION, SHOT_DURATION, SHOT_TRANSITION } from "./Demo";
import { Outro } from "./Outro";
import { TitleCard } from "./TitleCard";

export const ACT_ONE_DURATION = 640;
export const TITLE_DURATION = 140;
export const OUTRO_DURATION = 170;
const FADE = 16;

export const TOTAL_DURATION =
  ACT_ONE_DURATION + TITLE_DURATION + DEMO_DURATION + OUTRO_DURATION - 3 * FADE;

const crossfade = (key: string) => (
  <TransitionSeries.Transition
    key={key}
    presentation={fade()}
    timing={linearTiming({
      durationInFrames: FADE,
      easing: Easing.bezier(0.45, 0, 0.55, 1),
    })}
  />
);

// ---- Voiceover (Voxtral, en_paul_neutral) ----
// Starts are derived from the scene constants above so the lines stay glued
// to their visual beats even if scene durations change. Clip lengths were
// verified against each beat window at generation time (scripts: see repo
// history / video/public/vo). fps = 30.
const TITLE_START = ACT_ONE_DURATION - FADE; // 624
const DEMO_START = TITLE_START + TITLE_DURATION - FADE; // 748
const OUTRO_START = DEMO_START + DEMO_DURATION - FADE; // 1332
const SHOT_STEP = SHOT_DURATION - SHOT_TRANSITION; // 98

const VO: { src: string; from: number }[] = [
  { src: "vo/01-one-project.mp3", from: 8 }, // "Two years ago, you had one project."
  { src: "vo/02-more.mp3", from: 150 }, // "Now, AI lets you do more. And more. And more."
  { src: "vo/03-pings.mp3", from: 332 }, // "And the pings come from everywhere."
  { src: "vo/04-collapse.mp3", from: 518 }, // "Until you pull it all into one place."
  { src: "vo/05-title.mp3", from: TITLE_START + 24 }, // "So we built Boucle."
  { src: "vo/06-queue.mp3", from: DEMO_START + 6 },
  { src: "vo/07-capture.mp3", from: DEMO_START + SHOT_STEP + 6 },
  { src: "vo/08-palette.mp3", from: DEMO_START + 2 * SHOT_STEP + 6 },
  { src: "vo/09-brain.mp3", from: DEMO_START + 3 * SHOT_STEP + 6 },
  { src: "vo/10-loops.mp3", from: DEMO_START + 4 * SHOT_STEP + 6 },
  { src: "vo/11-projects.mp3", from: DEMO_START + 5 * SHOT_STEP + 6 },
  { src: "vo/12-outro.mp3", from: OUTRO_START + 16 }, // "Boucle. Built on the Mistral stack…"
];

const VoiceOver: React.FC = () => (
  <>
    {VO.map((line) => (
      <Sequence key={line.src} from={line.from}>
        <Audio src={staticFile(line.src)} />
      </Sequence>
    ))}
  </>
);

export const Main: React.FC = () => {
  return (
    <AbsoluteFill>
      <VoiceOver />
      <TransitionSeries>
      <TransitionSeries.Sequence durationInFrames={ACT_ONE_DURATION}>
        <ActOne />
      </TransitionSeries.Sequence>
      {crossfade("act-title")}
      <TransitionSeries.Sequence durationInFrames={TITLE_DURATION}>
        <TitleCard />
      </TransitionSeries.Sequence>
      {crossfade("title-demo")}
      <TransitionSeries.Sequence durationInFrames={DEMO_DURATION}>
        <Demo />
      </TransitionSeries.Sequence>
      {crossfade("demo-outro")}
      <TransitionSeries.Sequence durationInFrames={OUTRO_DURATION}>
        <Outro />
      </TransitionSeries.Sequence>
      </TransitionSeries>
    </AbsoluteFill>
  );
};

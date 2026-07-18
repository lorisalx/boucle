import { linearTiming, TransitionSeries } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import React from "react";
import { Easing } from "remotion";
import { ActOne } from "./ActOne";
import { Demo, DEMO_DURATION } from "./Demo";
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

export const Main: React.FC = () => {
  return (
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
  );
};

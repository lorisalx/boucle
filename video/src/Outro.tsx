import React from "react";
import {
  AbsoluteFill,
  Easing,
  Img,
  interpolate,
  staticFile,
  useCurrentFrame,
} from "remotion";
import { BG, FONT, GRADIENT, INK, MONO, MUTED, POP, SETTLE } from "./theme";

export const Outro: React.FC = () => {
  const frame = useCurrentFrame();
  const fade = (from: number) =>
    interpolate(frame, [from, from + 14], [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });
  const rise = (from: number) =>
    interpolate(frame, [from, from + 18], [26, 0], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: Easing.bezier(...SETTLE),
    });
  return (
    <AbsoluteFill
      style={{
        background: BG,
        alignItems: "center",
        justifyContent: "center",
        flexDirection: "column",
        gap: 40,
        fontFamily: FONT,
      }}
    >
      <Img
        src={staticFile("brand/Mistral-Icon-Gradient-RGB.png")}
        style={{
          width: 120,
          height: 120,
          opacity: fade(0),
          scale: String(
            interpolate(frame, [0, 20], [0.5, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
              easing: Easing.bezier(...POP),
            }),
          ),
        }}
      />
      <div
        style={{
          fontSize: 150,
          fontWeight: 700,
          letterSpacing: "-0.03em",
          color: INK,
          opacity: fade(8),
          translate: `0px ${rise(8)}px`,
        }}
      >
        Boucle
      </div>
      <div
        style={{
          fontSize: 40,
          fontWeight: 500,
          color: MUTED,
          opacity: fade(22),
          translate: `0px ${rise(22)}px`,
          display: "flex",
          gap: 26,
          alignItems: "center",
        }}
      >
        <span>Capture</span>
        <Dot />
        <span>Queue</span>
        <Dot />
        <span>Brain</span>
        <Dot />
        <span>Loops</span>
      </div>
      <div
        style={{
          position: "absolute",
          bottom: 88,
          fontFamily: MONO,
          fontSize: 26,
          letterSpacing: "0.1em",
          color: MUTED,
          opacity: fade(36),
        }}
      >
        BUILT ON MISTRAL — AGENTS API · DEVSTRAL · VOXTRAL
      </div>
    </AbsoluteFill>
  );
};

const Dot: React.FC = () => (
  <span
    style={{
      width: 12,
      height: 12,
      borderRadius: "50%",
      background: GRADIENT,
      display: "inline-block",
    }}
  />
);

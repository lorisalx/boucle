import React from "react";
import {
  AbsoluteFill,
  Easing,
  Img,
  interpolate,
  staticFile,
  useCurrentFrame,
} from "remotion";
import { BG, FONT, INK, MONO, MUTED, POP, SETTLE } from "./theme";

export const TitleCard: React.FC = () => {
  const frame = useCurrentFrame();
  const rise = (from: number) =>
    interpolate(frame, [from, from + 18], [30, 0], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: Easing.bezier(...SETTLE),
    });
  const fade = (from: number) =>
    interpolate(frame, [from, from + 14], [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });
  return (
    <AbsoluteFill
      style={{
        background: BG,
        alignItems: "center",
        justifyContent: "center",
        flexDirection: "column",
        gap: 44,
        fontFamily: FONT,
      }}
    >
      <Img
        src={staticFile("brand/Mistral-Icon-Gradient-RGB.png")}
        style={{
          width: 150,
          height: 150,
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
          fontSize: 120,
          fontWeight: 700,
          letterSpacing: "-0.03em",
          color: INK,
          opacity: fade(10),
          translate: `0px ${rise(10)}px`,
        }}
      >
        So we built <span style={{ color: "#fa500f" }}>Boucle</span>.
      </div>
      <div
        style={{
          fontSize: 44,
          fontWeight: 500,
          color: MUTED,
          opacity: fade(26),
          translate: `0px ${rise(26)}px`,
        }}
      >
        Your chief of staff, in a loop — on the Mistral stack.
      </div>
      <div
        style={{
          position: "absolute",
          bottom: 90,
          fontFamily: MONO,
          fontSize: 26,
          letterSpacing: "0.1em",
          color: MUTED,
          opacity: fade(40),
        }}
      >
        AGENTS API · DEVSTRAL · VOXTRAL
      </div>
    </AbsoluteFill>
  );
};

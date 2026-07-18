import { loadFont as loadGeist } from "@remotion/google-fonts/Geist";
import { loadFont as loadGeistMono } from "@remotion/google-fonts/GeistMono";

const geist = loadGeist("normal", { weights: ["400", "500", "600", "700"] });
const geistMono = loadGeistMono("normal", { weights: ["400", "500"] });

export const FONT = geist.fontFamily;
export const MONO = geistMono.fontFamily;

// Palette lifted from the Boucle web app (web/src/index.css)
export const BG = "#fbfaf8";
export const INK = "#1b1b19";
export const MUTED = "#8a8578";
export const AMBER = "#ff8204";
export const ORANGE = "#fa500f";
export const GRADIENT = `linear-gradient(135deg, ${AMBER}, ${ORANGE})`;
export const CARD_BORDER = "rgba(27, 27, 25, 0.1)";
export const CARD_SHADOW = "0 12px 40px rgba(27, 27, 25, 0.10)";

// Overshooting pop used for cards and toasts flying in.
export const POP = [0.34, 1.56, 0.64, 1] as const;
// Smooth settle for text.
export const SETTLE = [0.16, 1, 0.3, 1] as const;
// Accelerating pull for the collapse.
export const PULL = [0.7, 0, 0.84, 0] as const;

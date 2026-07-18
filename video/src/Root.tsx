import { Composition } from "remotion";
import "./index.css";
import { Main, TOTAL_DURATION } from "./Main";

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="BoucleDemo"
      component={Main}
      durationInFrames={TOTAL_DURATION}
      fps={30}
      width={1920}
      height={1080}
    />
  );
};

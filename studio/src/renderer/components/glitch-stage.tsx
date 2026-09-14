import { useEffect, useRef } from "preact/hooks";
import { Vex, GlitchDriver, LAYOUT } from "../../../glitch/vex";
import { useStore } from "../store";

/** The single live Glitch driver for the app (production engine and mood palette both talk to it). */
export const glitch = new GlitchDriver(7);

export function GlitchStage({ devPos }: { devPos: "home" | "left" | "hidden" }) {
  const ref = useRef<SVGSVGElement>(null);
  const { config } = useStore();
  useEffect(() => { if (config?.glitch?.homeY) glitch.slide(config.glitch.homeY, 1); }, [config?.glitch?.homeY]);
  useEffect(() => {
    const svg = ref.current!; svg.replaceChildren(); // rebuilt when the size setting changes
    const vex = new Vex(svg, { size: config?.glitch?.size ?? 1 });
    let last = performance.now(), raf = 0;
    const loop = (now: number) => { vex.update(glitch.tick(Math.min(.05, (now - last) / 1000)), now / 1000); last = now; raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [config?.glitch?.size]);
  const dev = devPos === "home" ? { left: "60%", top: "60%" } : devPos === "left" ? { left: "0%", top: "60%" } : { left: "60%", top: "110%" };
  return (
    <div class="stage">
      <svg ref={ref} viewBox={`0 0 ${LAYOUT.W} ${LAYOUT.H}`} />
      <div class="devbox" style={{ width: "40%", height: "40%", ...dev }}>DEV</div>
    </div>
  );
}

import { useEffect, useRef } from "react";
import { geoOrthographic, geoPath, geoGraticule10, geoCircle } from "d3-geo";

import { MARKETS, MAX_MARKET_SHARE } from "../lib/ai-adoption";
import { LAND } from "../lib/land";

/**
 * A rotating Earth with painted oceans, land and a lit limb.
 *
 * Projection and clipping come from d3-geo rather than hand-rolled maths:
 * clipping a polygon against the horizon of a sphere is genuinely hard, and
 * doing it naively smears landmasses across the disc.
 *
 * The three-dimensional read is pure 2D canvas — a radial gradient offset
 * towards the light gives the terminator, a second one adds atmosphere outside
 * the limb, and a soft specular highlight sits where the sun would be. No
 * WebGL, no texture, ~11KB of coastline.
 */

/** Where the light comes from, as a fraction of the radius from centre. */
const LIGHT = { x: -0.35, y: -0.42 };

const OCEAN_LIT = "#2b7fc4";
const OCEAN_DEEP = "#0d2f52";
const LAND_LIT = "#3f9d6d";
const LAND_DEEP = "#1d5c40";
const ATMOSPHERE = "#5eb8ff";
const MARKET_DOT = "#ffd166";

export function Globe({ size = 360 }: { size?: number }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // Match device pixel ratio, or coastlines render soft on retina screens.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    context.scale(dpr, dpr);

    const centre = size / 2;
    // Leave room for the atmosphere to bloom outside the sphere.
    const radius = size / 2 - size * 0.06;

    const projection = geoOrthographic()
      .fitExtent(
        [
          [size * 0.06, size * 0.06],
          [size - size * 0.06, size - size * 0.06],
        ],
        { type: "Sphere" },
      )
      .rotate([0, -14]);

    const path = geoPath(projection, context);
    const graticule = geoGraticule10();

    const lightX = centre + LIGHT.x * radius;
    const lightY = centre + LIGHT.y * radius;

    let spin = 0;
    let frame = 0;
    let running = true;

    const draw = () => {
      context.clearRect(0, 0, size, size);
      projection.rotate([spin, -14]);

      // Atmosphere: a halo just outside the limb, so the planet sits in light
      // rather than being pasted onto the card.
      const halo = context.createRadialGradient(
        centre,
        centre,
        radius * 0.92,
        centre,
        centre,
        radius * 1.16,
      );
      halo.addColorStop(0, `${ATMOSPHERE}55`);
      halo.addColorStop(0.4, `${ATMOSPHERE}22`);
      halo.addColorStop(1, `${ATMOSPHERE}00`);
      context.fillStyle = halo;
      context.beginPath();
      context.arc(centre, centre, radius * 1.16, 0, Math.PI * 2);
      context.fill();

      // Everything from here is inside the sphere.
      context.save();
      context.beginPath();
      context.arc(centre, centre, radius, 0, Math.PI * 2);
      context.clip();

      // Ocean, lit from the same direction as everything else.
      const ocean = context.createRadialGradient(
        lightX,
        lightY,
        radius * 0.05,
        centre,
        centre,
        radius * 1.3,
      );
      ocean.addColorStop(0, OCEAN_LIT);
      ocean.addColorStop(0.55, "#1a5a92");
      ocean.addColorStop(1, OCEAN_DEEP);
      context.fillStyle = ocean;
      context.fillRect(0, 0, size, size);

      // Land, with its own light-to-dark ramp so continents read as raised.
      const land = context.createRadialGradient(
        lightX,
        lightY,
        radius * 0.05,
        centre,
        centre,
        radius * 1.3,
      );
      land.addColorStop(0, LAND_LIT);
      land.addColorStop(0.6, "#2c7a55");
      land.addColorStop(1, LAND_DEEP);
      context.beginPath();
      path(LAND);
      context.fillStyle = land;
      context.fill();

      // Coastline: a hairline lift where land meets water.
      context.beginPath();
      path(LAND);
      context.strokeStyle = "rgba(255,255,255,0.22)";
      context.lineWidth = 0.6;
      context.stroke();

      // Graticule, faint enough to suggest a globe without becoming a cage.
      context.beginPath();
      path(graticule);
      context.strokeStyle = "rgba(255,255,255,0.10)";
      context.lineWidth = 0.6;
      context.stroke();

      // Terminator: darkness increasing away from the light. This is what
      // turns a flat disc into a sphere.
      const shade = context.createRadialGradient(
        lightX,
        lightY,
        radius * 0.15,
        centre,
        centre,
        radius * 1.45,
      );
      shade.addColorStop(0, "rgba(0,0,0,0)");
      shade.addColorStop(0.45, "rgba(0,0,0,0.10)");
      shade.addColorStop(0.75, "rgba(0,0,0,0.42)");
      shade.addColorStop(1, "rgba(0,0,0,0.72)");
      context.fillStyle = shade;
      context.fillRect(0, 0, size, size);

      // Specular sheen where the sun would strike.
      const sheen = context.createRadialGradient(
        lightX,
        lightY,
        0,
        lightX,
        lightY,
        radius * 0.75,
      );
      sheen.addColorStop(0, "rgba(255,255,255,0.20)");
      sheen.addColorStop(1, "rgba(255,255,255,0)");
      context.fillStyle = sheen;
      context.fillRect(0, 0, size, size);

      // Markets. geoCircle keeps a dot genuinely on the sphere, so it
      // foreshortens towards the limb instead of staying a flat disc.
      for (const market of MARKETS) {
        const [lambda, phi] = projection.rotate();
        // d3 still projects points on the far side; test the angle ourselves.
        const cosDistance =
          Math.sin((-phi * Math.PI) / 180) * Math.sin((market.lat * Math.PI) / 180) +
          Math.cos((-phi * Math.PI) / 180) *
            Math.cos((market.lat * Math.PI) / 180) *
            Math.cos(((market.lon + lambda) * Math.PI) / 180);
        if (cosDistance < 0.02) continue;

        const point: [number, number] = [market.lon, market.lat];
        // Each market pulses on its own phase, so the globe reads as many
        // independent events rather than one synchronised blink.
        const pulse = reduceMotion
          ? 0.85
          : 0.6 + 0.4 * Math.sin(frame / 32 + market.lon / 20 + market.lat / 15);
        // Area tracks share, so a market twice the size looks twice as big
        // rather than twice as wide.
        const relative = Math.sqrt(market.share / MAX_MARKET_SHARE);

        context.beginPath();
        path(geoCircle().center(point).radius(2.4 + relative * 4.4)());
        context.fillStyle = MARKET_DOT;
        context.globalAlpha = 0.2 * cosDistance * pulse;
        context.fill();

        context.beginPath();
        path(geoCircle().center(point).radius(0.7 + relative * 1.5)());
        context.globalAlpha = Math.min(1, 0.55 + cosDistance * 0.45) * pulse;
        context.fill();
      }
      context.globalAlpha = 1;

      context.restore();

      // Rim light, drawn outside the clip so it sits crisply on the edge.
      context.beginPath();
      context.arc(centre, centre, radius, 0, Math.PI * 2);
      context.strokeStyle = `${ATMOSPHERE}88`;
      context.lineWidth = 1.2;
      context.stroke();
    };

    const tick = () => {
      if (!running) return;
      // A full turn in roughly a minute: present, never distracting.
      spin = (spin + 0.12) % 360;
      frame += 1;
      draw();
      requestAnimationFrame(tick);
    };

    if (reduceMotion) {
      // Still a globe, just not a moving one — centred on the Atlantic so both
      // the Americas and Europe are in view.
      spin = -30;
      draw();
    } else {
      requestAnimationFrame(tick);
    }

    return () => {
      running = false;
    };
  }, [size]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: size, height: size, display: "block", maxWidth: "100%" }}
      role="img"
      aria-label="Rotating globe showing the markets where shoppers use AI assistants"
    />
  );
}

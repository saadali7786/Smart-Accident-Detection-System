import { useState } from "react";
import { TileLayer } from "react-leaflet";

const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

export default function DarkMapLayer() {
  const [tileState, setTileState] = useState("loading");

  return (
    <>
      <TileLayer
        attribution={TILE_ATTRIBUTION}
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        eventHandlers={{
          loading: () => setTileState("loading"),
          load: () => setTileState("ready"),
          tileerror: () => setTileState("error"),
        }}
      />
      {tileState !== "ready" && (
        <div
          className={`map-tile-status ${tileState === "error" ? "error" : ""}`}
          role={tileState === "error" ? "alert" : "status"}
          aria-live="polite"
        >
          {tileState === "error" ? "Map tiles unavailable" : "Loading map tiles"}
        </div>
      )}
    </>
  );
}

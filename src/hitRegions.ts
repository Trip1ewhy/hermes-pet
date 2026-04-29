import { invoke } from "@tauri-apps/api/core";

interface HitRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

const regions = new Map<string, HitRegion>();

let flushQueued = false;

export function updateHitRegion(id: string, rect: HitRegion | null) {
  if (rect && rect.width > 0 && rect.height > 0) {
    regions.set(id, {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    });
  } else {
    regions.delete(id);
  }

  queueFlush();
}

function queueFlush() {
  if (flushQueued) return;
  flushQueued = true;

  window.requestAnimationFrame(() => {
    flushQueued = false;
    invoke("set_pet_hit_regions", {
      regions: Array.from(regions.values()),
    }).catch((e) => {
      console.warn("set_pet_hit_regions failed:", e);
    });
  });
}

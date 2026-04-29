// 流 A spike 用占位 pet：一个 200×200 的米色 SVG 圆。
//
// 当前架构（2026-04-29）：
// 1. Rust 启动时窗口铺满主屏 + 默认全穿透
// 2. PetCircle 上报 hit region 矩形，鼠标进矩形 Rust 关穿透 → 接管事件
// 3. 圆几何命中（在矩形 hit region 内再做圆精确判定）：圆内 → hover 表情 + 可拖动
// 4. 通过 onPosChange 把当前位置外推给 App，用于 BubbleStack 跟随渲染
//
// 调试条（左下角黑底白字）spike 验收后删除。

import { useEffect, useRef, useState } from "react";
import { updateHitRegion } from "../hitRegions";
import "./PetCircle.css";

const SIZE = 200;
const RADIUS = SIZE / 2;

interface PetCircleProps {
  /** 把当前位置和尺寸暴露给上层（BubbleStack 跟随定位用） */
  onPosChange?: (pos: { x: number; y: number; size: number }) => void;
}

export const PET_SIZE = SIZE;

export default function PetCircle({ onPosChange }: PetCircleProps) {
  const [pos, setPos] = useState(() => ({
    x: Math.max(0, window.innerWidth / 2 - SIZE / 2),
    y: Math.max(0, window.innerHeight / 3 - SIZE / 2),
  }));
  const [hovered, setHovered] = useState(false);

  // === spike 调试 state ===
  const [moves, setMoves] = useState(0);
  const [mouse, setMouse] = useState({ x: 0, y: 0 });

  const posRef = useRef(pos);
  posRef.current = pos;

  useEffect(() => {
    updateHitRegion("pet-circle", {
      x: pos.x,
      y: pos.y,
      width: SIZE,
      height: SIZE,
    });

    onPosChange?.({ x: pos.x, y: pos.y, size: SIZE });

    return () => updateHitRegion("pet-circle", null);
  }, [pos.x, pos.y, onPosChange]);

  // 拖动：dragRef 记录鼠标按下时鼠标点相对圆左上的偏移
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);

  useEffect(() => {
    function isInsideCircle(x: number, y: number) {
      const cx = posRef.current.x + RADIUS;
      const cy = posRef.current.y + RADIUS;
      const dx = x - cx;
      const dy = y - cy;
      return dx * dx + dy * dy <= RADIUS * RADIUS;
    }

    function onMove(e: MouseEvent) {
      const x = e.clientX;
      const y = e.clientY;
      setMoves((m) => m + 1);
      setMouse({ x: Math.round(x), y: Math.round(y) });

      if (dragRef.current) {
        setPos({
          x: x - dragRef.current.dx,
          y: y - dragRef.current.dy,
        });
        return;
      }

      const inside = isInsideCircle(x, y);
      setHovered(inside);
    }

    function onDown(e: MouseEvent) {
      if (!isInsideCircle(e.clientX, e.clientY)) return;
      dragRef.current = {
        dx: e.clientX - posRef.current.x,
        dy: e.clientY - posRef.current.y,
      };
    }
    function onUp() {
      dragRef.current = null;
    }

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("mouseup", onUp);

    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  return (
    <>
      <div
        className={`pet-circle${hovered ? " is-hovered" : ""}`}
        style={{
          width: SIZE,
          height: SIZE,
          transform: `translate(${pos.x}px, ${pos.y}px)`,
        }}
      >
        <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`}>
          <defs>
            <radialGradient id="petBody" cx="50%" cy="40%" r="60%">
              <stop offset="0%" stopColor="#FFF8EC" />
              <stop offset="100%" stopColor="#F5E6D3" />
            </radialGradient>
          </defs>
          <circle cx={SIZE / 2} cy={SIZE / 2} r={SIZE / 2 - 4} fill="url(#petBody)" stroke="#D4B896" strokeWidth="2" />
          <circle cx={SIZE / 2 - 28} cy={SIZE / 2 - 6} r={hovered ? 4 : 8} fill="#2B2B2B" />
          <circle cx={SIZE / 2 + 28} cy={SIZE / 2 - 6} r={hovered ? 4 : 8} fill="#2B2B2B" />
          <path
            d={
              hovered
                ? `M ${SIZE / 2 - 18} ${SIZE / 2 + 22} Q ${SIZE / 2} ${SIZE / 2 + 38} ${SIZE / 2 + 18} ${SIZE / 2 + 22}`
                : `M ${SIZE / 2 - 18} ${SIZE / 2 + 28} Q ${SIZE / 2} ${SIZE / 2 + 32} ${SIZE / 2 + 18} ${SIZE / 2 + 28}`
            }
            fill="none"
            stroke="#2B2B2B"
            strokeWidth="3"
            strokeLinecap="round"
          />
        </svg>
      </div>
      <div className="pet-debug">
        moves={moves} mouse=({mouse.x},{mouse.y}) pet=({Math.round(pos.x)},{Math.round(pos.y)}) hov={String(hovered)}
      </div>
    </>
  );
}

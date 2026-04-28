// 流 A spike：透明窗口 + always-on-top + 鼠标穿透 验证组件。
//
// 这一版还不画桌宠形象，先用一个 200×200 的米色 SVG 圆占位，
// 验证以下 4 件事：
//   1. 窗口背景完全透明（看不到任何 macOS 默认窗口边框）
//   2. 窗口始终置顶（点击其它窗口后米色圆仍浮在最上层）
//   3. 圆外的桌面图标可以正常点（鼠标穿透生效）
//   4. 圆内可以接收鼠标事件（hover 变色 + 可拖动）
//
// 实现机制：
//   - 默认整个 webview 是"鼠标穿透"模式（启动时 Rust 侧 set_ignore_cursor_events(true)）
//   - 圆的 DOM 节点上 onMouseEnter / onMouseLeave 切换穿透开关
//   - 由于 OS 在穿透模式下根本不会派发鼠标事件给 webview，
//     这里用一个"探测层"：在圆的外接矩形（hit-area）上挂事件，
//     探测层本身也参与穿透判定（精确 hit-test 由浏览器层处理）。

import PetCircle from "./components/PetCircle";
import "./App.css";

function App() {
  return (
    <div className="pet-root">
      <PetCircle />
    </div>
  );
}

export default App;

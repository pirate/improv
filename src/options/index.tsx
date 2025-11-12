import { createRoot } from "react-dom/client";
const container = document.getElementById("root");

if (container) {
  const root = createRoot(container);
  root.render(
    <div className="p-6">
      <h1 className="text-2xl">Hello, World</h1>
      <p className="text-base">This options page is rendered with React</p>
    </div>
  );
}

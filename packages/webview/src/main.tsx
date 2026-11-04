import "@xyflow/react/dist/style.css";
import "./styles.css";
import { createRoot } from "react-dom/client";
import { disableSchemaCompilation } from "@delamain/core";
import { ChatApp } from "./chat/ChatApp";
import { ConfigApp } from "./config/ConfigApp";

disableSchemaCompilation();

// The host renders <div id="root" data-view="chat|config"> and loads this same bundle in both webviews.
const root = document.getElementById("root");
if (root) {
  const view = root.dataset.view === "config" ? "config" : "chat";
  document.body.classList.add(`harness-${view}`);
  createRoot(root).render(view === "config" ? <ConfigApp /> : <ChatApp />);
}

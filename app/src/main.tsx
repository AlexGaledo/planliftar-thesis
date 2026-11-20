/**
 * App entry: global styles, React root, providers and router.
 * Kept tiny on purpose; the route table lives in app/router.tsx.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import "./styles/global.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
